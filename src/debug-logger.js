(() => {
    const LOGGER_REGISTRY_KEY = '__imageFinderDebugLoggers';
    const CONSOLE_LEVELS = ['log', 'info', 'warn', 'error'];
    const MAX_DEPTH = 4;
    const MAX_ITEMS = 32;
    const MAX_STRING_LENGTH = 2000;
    const DEFAULT_BATCH_SIZE = 25;
    const DEFAULT_FLUSH_DELAY_MS = 250;

    const truncate = (value, maximum = MAX_STRING_LENGTH) => {
        const text = String(value);
        return text.length > maximum ? `${text.slice(0, maximum - 3)}...` : text;
    };
    const getElementDescription = (element) => {
        try {
            const className = typeof element.className === 'string'
                ? element.className.trim()
                : element.getAttribute?.('class')?.trim() ?? '';
            return {
                type: 'DOMElement',
                tag: String(element.tagName ?? 'unknown').toLowerCase(),
                id: element.id || null,
                class: truncate(className, 240) || null
            };
        } catch {
            return {type: 'DOMElement', tag: 'unavailable'};
        }
    };
    const serializeValue = (value, seen = new WeakSet(), depth = 0) => {
        try {
            if (value === null) return null;
            if (value === undefined) return {type: 'undefined'};
            if (typeof value === 'string') return truncate(value);
            if (typeof value === 'number' || typeof value === 'boolean') return value;
            if (typeof value === 'bigint') return {type: 'bigint', value: String(value)};
            if (typeof value === 'symbol') return {type: 'symbol', value: String(value)};
            if (typeof value === 'function') {
                return {type: 'function', name: value.name || null};
            }
            if (value?.nodeType === 1 && value?.tagName) return getElementDescription(value);
            if (value instanceof Error ||
                (typeof value?.name === 'string' && typeof value?.message === 'string' &&
                    typeof value?.stack === 'string')) {
                return {
                    type: 'Error',
                    name: value.name || 'Error',
                    message: truncate(value.message),
                    stack: typeof value.stack === 'string' ? truncate(value.stack, 6000) : null
                };
            }
            if (value instanceof Date) return {type: 'Date', value: value.toISOString()};
            if (depth >= MAX_DEPTH) return {type: 'truncated', reason: 'max-depth'};
            if (typeof value !== 'object') return truncate(value);
            if (seen.has(value)) return {type: 'circular'};
            seen.add(value);

            if (Array.isArray(value)) {
                const items = value.slice(0, MAX_ITEMS).map((item) =>
                    serializeValue(item, seen, depth + 1)
                );
                if (value.length > MAX_ITEMS) items.push({type: 'truncated', remaining: value.length - MAX_ITEMS});
                return items;
            }
            if (value instanceof Map) {
                return {
                    type: 'Map',
                    entries: Array.from(value.entries()).slice(0, MAX_ITEMS).map(([key, item]) => [
                        serializeValue(key, seen, depth + 1),
                        serializeValue(item, seen, depth + 1)
                    ]),
                    size: value.size
                };
            }
            if (value instanceof Set) {
                return {
                    type: 'Set',
                    values: Array.from(value.values()).slice(0, MAX_ITEMS).map((item) =>
                        serializeValue(item, seen, depth + 1)
                    ),
                    size: value.size
                };
            }

            const result = {};
            const keys = Object.keys(value).slice(0, MAX_ITEMS);
            keys.forEach((key) => {
                try {
                    result[key] = serializeValue(value[key], seen, depth + 1);
                } catch {
                    result[key] = {type: 'unavailable'};
                }
            });
            if (Object.keys(value).length > MAX_ITEMS) {
                result.__truncated__ = Object.keys(value).length - MAX_ITEMS;
            }
            return result;
        } catch (error) {
            return {
                type: 'serialization-error',
                message: error instanceof Error ? truncate(error.message) : 'unknown'
            };
        }
    };
    const getMessageText = (argumentsList) => argumentsList.map((value) => {
        if (typeof value === 'string') return truncate(value, 400);
        if (value && typeof value === 'object' && value.type === 'Error') {
            return `${value.name}: ${value.message}`;
        }
        if (value && typeof value === 'object' && value.type === 'DOMElement') {
            return `<${value.tag}>`;
        }
        if (value === null) return 'null';
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return '[object]';
    }).join(' ');
    const serializeConsoleArguments = (argumentsList) => {
        const serializedArguments = Array.from(argumentsList, (value) => serializeValue(value));
        return {
            message: getMessageText(serializedArguments),
            arguments: serializedArguments
        };
    };
    const getRegistry = () => {
        if (!(globalThis[LOGGER_REGISTRY_KEY] instanceof Map)) {
            globalThis[LOGGER_REGISTRY_KEY] = new Map();
        }
        return globalThis[LOGGER_REGISTRY_KEY];
    };
    const createLogger = ({
        source,
        sendRecords = () => Promise.resolve(),
        batchSize = DEFAULT_BATCH_SIZE,
        flushDelayMs = DEFAULT_FLUSH_DELAY_MS
    } = {}) => {
        const normalizedSource = ['popup', 'tab', 'service-worker'].includes(source)
            ? source
            : 'unknown';
        const registry = getRegistry();
        if (registry.has(normalizedSource)) return registry.get(normalizedSource);

        let context = {};
        let sourceSequence = 0;
        let pendingRecords = [];
        let flushTimer = null;
        let sendQueue = Promise.resolve();
        let installed = false;
        const originalMethods = new Map();
        const normalizeContext = (nextContext) => ({
            scanId: typeof nextContext?.scanId === 'string' && nextContext.scanId
                ? nextContext.scanId
                : null,
            url: typeof nextContext?.url === 'string' && nextContext.url
                ? nextContext.url
                : null
        });
        const flush = () => {
            if (flushTimer !== null) {
                clearTimeout(flushTimer);
                flushTimer = null;
            }
            if (pendingRecords.length === 0) return sendQueue;

            const records = pendingRecords;
            pendingRecords = [];
            sendQueue = sendQueue
                .then(() => Promise.resolve(sendRecords(records)))
                .catch(() => undefined);
            return sendQueue;
        };
        const queueRecord = (level, args) => {
            try {
                const serialized = serializeConsoleArguments(args);
                pendingRecords.push({
                    timestamp: new Date().toISOString(),
                    source: normalizedSource,
                    level,
                    sourceSequence: ++sourceSequence,
                    ...context,
                    ...serialized
                });
                if (pendingRecords.length >= Math.max(1, batchSize)) {
                    void flush();
                } else if (flushTimer === null && typeof setTimeout === 'function') {
                    flushTimer = setTimeout(() => {
                        flushTimer = null;
                        void flush();
                    }, Math.max(0, flushDelayMs));
                }
            } catch {
                // Debug logging must never affect the original console call.
            }
        };
        const logger = {
            install() {
                if (installed || typeof console === 'undefined') return logger;
                installed = true;
                CONSOLE_LEVELS.forEach((level) => {
                    const original = console[level];
                    if (typeof original !== 'function') return;
                    originalMethods.set(level, original);
                    try {
                        console[level] = (...args) => {
                            original.apply(console, args);
                            queueRecord(level, args);
                        };
                    } catch {
                        // A locked console method simply remains unobserved.
                    }
                });
                return logger;
            },
            setContext(nextContext) {
                context = normalizeContext(nextContext);
                return logger;
            },
            clearContext(scanId = null) {
                if (!scanId || context.scanId === scanId) context = {};
                return logger;
            },
            flush,
            getContext: () => ({...context}),
            getOriginalMethod: (level) => originalMethods.get(level) ?? null
        };
        registry.set(normalizedSource, logger);
        return logger;
    };

    globalThis.ImageFinderDebugLogger = Object.freeze({
        createLogger,
        serializeConsoleArguments,
        serializeValue
    });
})();
