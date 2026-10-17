const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_TARGET = 'image-finder-offscreen';
const OFFSCREEN_ANALYZER_CONTROL_TARGET = 'image-finder-offscreen-analyzer-control';
const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';
const HIDDEN_DEEP_SCAN_TARGET = 'image-finder-hidden-deepscan';
const ONLYFANS_MAIN_WORLD_TARGET = 'image-finder-onlyfans-main-world';
const TERMINAL_DOWNLOAD_STATES = new Set(['complete', 'interrupted']);
const PROTECTED_DEEP_SCAN_FRAME_RULE_ID = 10001;
const HIDDEN_DEEP_SCAN_FRAME_RULE_ID = 10002;
const HIDDEN_DEEP_SCAN_HOST_FRAME_ID = 0;
const EMBED_BLOCKED_OR_LOAD_FAILED = 'EMBED_BLOCKED_OR_LOAD_FAILED';
const POPUP_DEEP_SCAN_PORT_NAME = 'image-finder-popup-deepscan';
const REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY = 'reopenPopupAfterRestart';
const REOPEN_POPUP_AFTER_RESTART_MAX_AGE_MS = 60 * 1000;
const DEBUG_LOG_TARGET = 'image-finder-debug-log';
const DOWNLOADER_EVENT_TARGET = 'image-finder-downloader';
const DEBUG_LOG_EXPORT_DELAY_MS = 5000;
const DEBUG_LOG_POPUP_FINAL_DELAY_MS = 250;
const ZIP_BLOB_TRANSFER_CHUNK_BYTES = 512 * 1024;
const DEBUG_LOG_SETTINGS_BY_SOURCE = Object.freeze({
    popup: 'logpopup',
    tab: 'logtab',
    'service-worker': 'logserviceworker'
});

if (typeof importScripts === 'function') {
    importScripts('debug-logger.js');
    importScripts('isolated-deepscan-host.js');
    // ✴️ NEW 2026-10-15: Loads the persistent download service into the classic service worker.
    importScripts('classes/DownLoader.js');
    if (typeof JSZip === 'undefined') importScripts('../vendor/jszip.min.js');
}

const backgroundObjectUrlsByDownloadId = new Map();
const offscreenTokensByDownloadId = new Map();
const activeZipBlobTransfers = new Set();
let creatingOffscreenDocument = null;
let activeIsolatedDeepScan = null;
let activeHiddenDeepScan = null;
let backgroundDeepScanHost = null;
let protectedDeepScanFrameRuleOwner = null;
let hiddenDeepScanFrameRuleOwner = null;
let protectedDeepScanFrameRuleUpdate = Promise.resolve();
const popupDeepScanPorts = new Map();
const debugCollectorsByScanId = new Map();
let activeDebugLogContext = null;
const debugBackgroundLogger = globalThis.ImageFinderDebugLogger?.createLogger({
    source: 'service-worker',
    sendRecords: (records) => collectDebugRecords(records)
})?.install();
// ✴️ NEW 2026-10-15: Keeps media download and ZIP preparation independent from popup lifetime.
const downLoader = typeof globalThis.DownLoader === 'function'
    ? new globalThis.DownLoader({
        createZipDownload: downloadMediaZipInOffscreen,
        downloadBlob,
        getErrorMessage,
        resolvePageBlob,
        onJobUpdate: sendDownLoaderEvent
    })
    : null;

async function reopenPopupAfterExtensionRestart() {
    let restartRequestedAt = null;
    try {
        const stored = await chrome.storage.local.get(REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY);
        restartRequestedAt = stored[REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY];
    } catch (error) {
        console.warn('[Restart] Cannot read popup reopening request:', error);
        return;
    }

    if (!Number.isFinite(restartRequestedAt)) return;

    try {
        await chrome.storage.local.remove(REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY);
    } catch (error) {
        console.warn('[Restart] Cannot consume popup reopening request:', error);
        return;
    }

    if (Date.now() - restartRequestedAt > REOPEN_POPUP_AFTER_RESTART_MAX_AGE_MS) return;

    if (typeof chrome.action?.openPopup !== 'function') {
        console.warn('[Restart] Automatic popup reopening after restart is not supported by this Chrome version.');
        return;
    }

    try {
        await chrome.action.openPopup();
    } catch (error) {
        console.warn('[Restart] Cannot reopen popup after restart:', error);
    }
}

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

// This function is deliberately self-contained: chrome.scripting serializes it into the page's
// MAIN execution world, where Vue's DOM expandos are visible.  The visible-tab trace showed that
// MessagesList.onUserScrollIntent() followed by MessagesList.onScroll() is the page's own route
// to the top-history loader.  Do exactly that route once; do not reset Vue state, fabricate an
// InfiniteLoading $state object, or call a collection of unrelated methods.
async function triggerOnlyFansHistoryLoaderInMainWorld() {
    const chatSelector = '.b-chats__scrollbar.b-chat__messages';
    const loaderSelector = '.infinite-loading-container.b-chat__loading-top';
    const result = {
        containerFound: false,
        loaderFound: false,
        componentFound: false,
        invoked: false,
        method: null,
        framework: null,
        componentHostDepth: null,
        componentParentDepth: null,
        componentName: null,
        receiverScope: null,
        candidateCount: 0,
        isLoadingBefore: null,
        isLoadingAfter: null,
        isComplete: null,
        networkRequestTriggered: false,
        reason: null
    };
    const container = document.querySelector(chatSelector);
    if (!container) {
        result.reason = 'CHAT_CONTAINER_NOT_FOUND';
        return result;
    }
    result.containerFound = true;

    const loader = container.querySelector(loaderSelector);
    if (!loader) {
        result.isComplete = true;
        result.reason = 'TOP_LOADER_NOT_FOUND_COMPLETE';
        return result;
    }
    result.loaderFound = true;

    const isObject = (value) => value !== null &&
        (typeof value === 'object' || typeof value === 'function');
    const candidates = [];
    const seen = new WeakSet();
    const componentName = (component, framework) => {
        try {
            return framework === 'vue2'
                ? component.$options?.name ?? component.$options?._componentTag ?? null
                : component.type?.name ?? component.type?.__name ?? null;
        } catch {
            return null;
        }
    };
    const addCandidate = (component, framework, hostDepth, parentDepth) => {
        if (!isObject(component) || seen.has(component)) return;
        seen.add(component);
        candidates.push({
            component,
            framework,
            hostDepth,
            parentDepth,
            name: componentName(component, framework)
        });
    };
    const addVue2Children = (component, hostDepth, childDepth = 1) => {
        if (!isObject(component) || childDepth > 3) return;
        let children;
        try {
            children = component.$children;
        } catch {
            return;
        }
        if (!Array.isArray(children)) return;
        for (const child of children) {
            addCandidate(child, 'vue2', hostDepth, -childDepth);
            addVue2Children(child, hostDepth, childDepth + 1);
        }
    };

    let element = loader;
    for (let hostDepth = 0; element && hostDepth < 10; hostDepth += 1) {
        let vue2 = null;
        let vue3 = null;
        try {
            vue2 = element.__vue__;
            vue3 = element.__vueParentComponent;
        } catch {
            // Continue at the parent DOM node when a page proxy rejects access.
        }
        for (let parentDepth = 0; isObject(vue2) && parentDepth < 8; parentDepth += 1) {
            addCandidate(vue2, 'vue2', hostDepth, parentDepth);
            if (parentDepth <= 1) addVue2Children(vue2, hostDepth);
            try {
                vue2 = vue2.$parent;
            } catch {
                break;
            }
        }
        for (let parentDepth = 0; isObject(vue3) && parentDepth < 8; parentDepth += 1) {
            addCandidate(vue3, 'vue3', hostDepth, parentDepth);
            try {
                vue3 = vue3.parent;
            } catch {
                break;
            }
        }
        element = element.parentElement;
    }

    result.candidateCount = candidates.length;
    result.componentFound = candidates.length > 0;
    if (!result.componentFound) {
        result.reason = 'VUE_COMPONENT_NOT_FOUND';
        return result;
    }

    const getReceivers = (candidate) => {
        try {
            if (candidate.framework === 'vue2') {
                return [
                    {receiver: candidate.component, thisArg: candidate.component, scope: 'instance'},
                    {
                        receiver: candidate.component.$options?.methods,
                        thisArg: candidate.component,
                        scope: 'options.methods'
                    }
                ];
            }
            const proxy = candidate.component.proxy;
            return [
                {receiver: proxy, thisArg: proxy ?? candidate.component, scope: 'proxy'},
                {receiver: candidate.component.ctx, thisArg: proxy ?? candidate.component, scope: 'ctx'},
                {
                    receiver: candidate.component.type?.methods,
                    thisArg: proxy ?? candidate.component,
                    scope: 'type.methods'
                }
            ];
        } catch {
            return [];
        }
    };
    const findMethod = (candidate, name) => {
        for (const {receiver, thisArg, scope} of getReceivers(candidate)) {
            if (!isObject(receiver)) continue;
            try {
                const method = receiver[name];
                if (typeof method === 'function') return {method, thisArg, scope};
            } catch {
                // Inspect the next public receiver.
            }
        }
        return null;
    };
    const isLoading = () => {
        try {
            return candidates.some(({component}) => component.isLoading === true || component.status === 1);
        } catch {
            return null;
        }
    };
    const messagesList = candidates.find((candidate) => candidate.name === 'MessagesList');
    const scrollIntent = messagesList ? findMethod(messagesList, 'onUserScrollIntent') : null;
    const onScroll = messagesList ? findMethod(messagesList, 'onScroll') : null;
    const infiniteLoading = candidates.find((candidate) => candidate.name === 'InfiniteLoading');
    const attemptLoad = infiniteLoading ? findMethod(infiniteLoading, 'attemptLoad') : null;
    const route = scrollIntent || onScroll
        ? {candidate: messagesList, method: scrollIntent && onScroll ? 'onUserScrollIntent+onScroll' :
            (scrollIntent ? 'onUserScrollIntent' : 'onScroll'), receiver: scrollIntent ?? onScroll}
        : attemptLoad
            ? {candidate: infiniteLoading, method: 'attemptLoad', receiver: attemptLoad}
            : null;
    if (!route) {
        result.reason = messagesList
            ? 'MESSAGES_LIST_SCROLL_METHOD_NOT_EXPOSED'
            : 'MESSAGES_LIST_AND_ATTEMPT_LOAD_NOT_FOUND';
        return result;
    }

    result.framework = route.candidate.framework;
    result.componentHostDepth = route.candidate.hostDepth;
    result.componentParentDepth = route.candidate.parentDepth;
    result.componentName = route.candidate.name;
    result.receiverScope = route.receiver.scope;
    result.method = route.method;
    result.isLoadingBefore = isLoading();
    result.isComplete = false;

    let networkRequestTriggered = false;
    const isMessagesRequest = (url) => /\/chats\/[^/?#]+\/messages\b|\/api2\/v2\/chats\b/i.test(url);
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalFetch = typeof window.fetch === 'function' ? window.fetch : null;
    let xhrWrapped = false;
    let fetchWrapped = false;
    try {
        try {
            XMLHttpRequest.prototype.open = function (method, url, ...rest) {
                try {
                    if (isMessagesRequest(String(url ?? ''))) networkRequestTriggered = true;
                } catch {
                    // Observation must never interfere with an XHR.
                }
                return Reflect.apply(originalOpen, this, [method, url, ...rest]);
            };
            xhrWrapped = true;
        } catch {
            // A non-writable page API must not prevent the page handler from being called.
        }
        if (originalFetch) {
            try {
                window.fetch = function (input, ...rest) {
                    try {
                        const url = typeof input === 'string' ? input : input?.url ?? '';
                        if (isMessagesRequest(url)) networkRequestTriggered = true;
                    } catch {
                        // Observation must never interfere with a fetch.
                    }
                    return Reflect.apply(originalFetch, this, [input, ...rest]);
                };
                fetchWrapped = true;
            } catch {
                // A non-writable page API must not prevent the page handler from being called.
            }
        }

        // The component method is called directly.  The argument describes the direction but
        // deliberately does not claim to be a browser-trusted event.  attemptLoad is used only
        // when that observed MessagesList route is not exposed in this OF build.
        if (route.method === 'attemptLoad') {
            const pending = attemptLoad.method.call(attemptLoad.thisArg, true);
            pending?.catch?.(() => undefined);
        } else if (scrollIntent) {
            const pending = scrollIntent.method.call(scrollIntent.thisArg, {
                type: 'wheel',
                isTrusted: false,
                deltaY: -120,
                deltaX: 0,
                wheelDelta: 120,
                wheelDeltaY: 120,
                target: container,
                currentTarget: container
            });
            pending?.catch?.(() => undefined);
        }
        if (route.method !== 'attemptLoad' && onScroll) {
            const pending = onScroll.method.call(onScroll.thisArg, {
                type: 'scroll',
                isTrusted: false,
                target: container,
                currentTarget: container
            });
            pending?.catch?.(() => undefined);
        }
        result.invoked = true;

        // Give the page route a brief, bounded window to create its request; the result remains
        // an observation, not a prediction based on a successful function call.
        await new Promise((resolve) => setTimeout(resolve, 1200));
        result.networkRequestTriggered = networkRequestTriggered;
        result.isLoadingAfter = isLoading();
        result.reason = networkRequestTriggered
            ? 'NETWORK_REQUEST_STARTED'
            : 'HANDLER_CALLED_NO_NETWORK';
        return result;
    } catch (error) {
        result.networkRequestTriggered = networkRequestTriggered;
        result.isLoadingAfter = isLoading();
        result.reason = `HANDLER_ERROR:${error instanceof Error ? error.message : String(error)}`;
        return result;
    } finally {
        if (xhrWrapped) XMLHttpRequest.prototype.open = originalOpen;
        if (fetchWrapped) window.fetch = originalFetch;
    }
}

// Kept deliberately narrow: this is the virtual Swiper used by OF chat-media previews.
// The page-owned Swiper instance lives in MAIN world; a DOM click remains the compatibility
// fallback when that instance is not exposed by this OF build.
async function advanceOnlyFansVirtualSwiperInMainWorld(swiperIndex, direction) {
    const result = {
        found: false,
        invoked: false,
        changed: false,
        method: null,
        indexBefore: null,
        indexAfter: null,
        reason: null
    };
    if (!Number.isInteger(swiperIndex) || swiperIndex < 0 ||
        !['forward', 'backward'].includes(direction)) {
        result.reason = 'INVALID_SWIPER_REQUEST';
        return result;
    }

    const hosts = Array.from(document.querySelectorAll(
        '.b-chats__scrollbar.b-chat__messages .swiper.b-slideshow.swiper-virtual'
    ));
    const host = hosts[swiperIndex] ?? null;
    if (!host) {
        result.reason = 'SWIPER_NOT_FOUND';
        return result;
    }
    result.found = true;

    const getActiveIndex = () => host.querySelector(
        '.swiper-slide-active[data-swiper-slide-index]'
    )?.getAttribute('data-swiper-slide-index') ?? null;
    const controlSelector = direction === 'forward'
        ? '.swiper-navigation .swiper-button-next'
        : '.swiper-navigation .swiper-button-prev';
    const control = host.querySelector(controlSelector);
    const isDisabled = (element) => !element || element.classList.contains('swiper-button-disabled') ||
        element.getAttribute('aria-disabled') === 'true' || element.hasAttribute('disabled');
    result.indexBefore = getActiveIndex();
    if (isDisabled(control)) {
        result.reason = 'SWIPER_EDGE_REACHED';
        return result;
    }

    const findSwiperInstance = () => {
        const vue = host.__vue__;
        const values = [
            host.swiper,
            host.__swiper__,
            vue?.swiper,
            vue?.$refs?.swiper?.swiper,
            vue?.$refs?.swiper?.$swiper,
            vue?.$children?.find?.((child) => typeof child?.swiper?.slideNext === 'function')?.swiper
        ];
        return values.find((candidate) => candidate &&
            typeof candidate.slideNext === 'function' && typeof candidate.slidePrev === 'function') ?? null;
    };

    try {
        const swiper = findSwiperInstance();
        if (swiper) {
            if (direction === 'forward') {
                swiper.slideNext();
                result.method = 'swiper.slideNext';
            } else {
                swiper.slidePrev();
                result.method = 'swiper.slidePrev';
            }
        } else {
            control.click();
            result.method = direction === 'forward' ? 'swiper-button-next.click' :
                'swiper-button-prev.click';
        }
        result.invoked = true;

        const deadline = Date.now() + 1200;
        while (Date.now() < deadline) {
            const currentIndex = getActiveIndex();
            if (currentIndex !== null && currentIndex !== result.indexBefore) {
                result.changed = true;
                result.indexAfter = currentIndex;
                result.reason = 'SWIPER_ADVANCED';
                return result;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        result.indexAfter = getActiveIndex();
        result.reason = 'SWIPER_STATE_UNCHANGED';
        return result;
    } catch (error) {
        result.indexAfter = getActiveIndex();
        result.reason = `SWIPER_ERROR:${error instanceof Error ? error.message : String(error)}`;
        return result;
    }
}

async function requestOnlyFansMainWorldPageAction(message, sender) {
    const tabId = sender?.tab?.id;
    const frameId = sender?.frameId;
    let hostname = null;
    try {
        hostname = new URL(sender?.url ?? '').hostname;
    } catch {
        // The request is rejected below.
    }
    const isHistoryRequest = message?.action === 'trigger-history-loader';
    const isSwiperRequest = message?.action === 'advance-virtual-swiper';
    const validSwiperRequest = isSwiperRequest && Number.isInteger(message?.swiperIndex) &&
        message.swiperIndex >= 0 && ['forward', 'backward'].includes(message?.direction);
    if (message?.source !== 'hidden-deepscan-frame' ||
        (!isHistoryRequest && !validSwiperRequest) ||
        !Number.isInteger(tabId) || !Number.isInteger(frameId) ||
        !hostname?.endsWith('onlyfans.com') ||
        activeHiddenDeepScan?.tabId !== tabId) {
        throw new Error('ONLYFANS_MAIN_WORLD_REQUEST_REJECTED');
    }

    const results = await chrome.scripting.executeScript({
        target: {tabId, frameIds: [frameId]},
        world: 'MAIN',
        func: isHistoryRequest
            ? triggerOnlyFansHistoryLoaderInMainWorld
            : advanceOnlyFansVirtualSwiperInMainWorld,
        ...(isSwiperRequest ? {args: [message.swiperIndex, message.direction]} : {})
    });
    return results[0]?.result ?? {reason: 'MAIN_WORLD_NO_RESULT'};
}

// ✴️ NEW 2026-10-15: Broadcasts background download job changes to any open popup.
function sendDownLoaderEvent(event) {
    void chrome.runtime.sendMessage({
        target: DOWNLOADER_EVENT_TARGET,
        source: 'background',
        ...event
    }).catch(() => undefined);
}

function getDebugManifestMeta() {
    try {
        const manifest = chrome.runtime.getManifest();
        return {
            version: manifest?.version ?? null,
            versionName: manifest?.version_name ?? null
        };
    } catch {
        return {version: null, versionName: null};
    }
}

function getEnabledDebugLogSources(debugSettings) {
    const debugModeEnabled = debugSettings?.debugmode === true;

    return Object.fromEntries(Object.entries(DEBUG_LOG_SETTINGS_BY_SOURCE).map(
        ([source, setting]) => [source, debugModeEnabled && debugSettings?.[setting] === true]
    ));
}

function hasEnabledDebugLogSource(enabledSources) {
    return Object.values(enabledSources ?? {}).some((enabled) => enabled === true);
}

function createDebugCollector(job) {
    if (!job?.scanId || debugCollectorsByScanId.has(job.scanId)) return;
    activeDebugLogContext = null;
    debugBackgroundLogger?.clearContext();

    if (!hasEnabledDebugLogSource(job.enabledDebugLogSources)) return;

    debugCollectorsByScanId.set(job.scanId, {
        meta: {
            ...getDebugManifestMeta(),
            scanId: job.scanId,
            url: job.url ?? null,
            startedAt: new Date().toISOString(),
            hiddenCompletedAt: null,
            endedAt: null,
            status: null,
            enabledSources: {...job.enabledDebugLogSources}
        },
        enabledSources: {...job.enabledDebugLogSources},
        popupClientId: job.popupClientId ?? null,
        records: [],
        collectorSequence: 0,
        exportTimer: null,
        exported: false,
        popupComplete: false,
        popupDisconnected: false
    });
    activeDebugLogContext = {scanId: job.scanId, url: job.url ?? null};
    debugBackgroundLogger?.setContext(activeDebugLogContext);
}

function collectDebugRecords(records) {
    if (!Array.isArray(records)) return;

    records.forEach((record) => {
        if (!record || typeof record.scanId !== 'string' || !record.scanId) return;
        const collector = debugCollectorsByScanId.get(record.scanId);
        if (!collector || collector.exported) return;

        const source = record.source;
        if (collector.enabledSources?.[source] !== true) return;

        collector.records.push({
            timestamp: typeof record.timestamp === 'string' ? record.timestamp : new Date().toISOString(),
            source,
            level: ['log', 'info', 'warn', 'error'].includes(record.level)
                ? record.level
                : 'log',
            sourceSequence: Number.isInteger(record.sourceSequence) ? record.sourceSequence : null,
            collectorSequence: ++collector.collectorSequence,
            scanId: record.scanId,
            url: typeof record.url === 'string' ? record.url : collector.meta.url,
            message: typeof record.message === 'string' ? record.message : '',
            arguments: Array.isArray(record.arguments) ? record.arguments : []
        });
    });
}

function getDebugFilename(meta) {
    let domain = 'unknown-domain';
    try {
        domain = new URL(meta.url).hostname || domain;
    } catch {
        // Keep the generic fallback for malformed or unavailable URLs.
    }
    const safeDomain = domain.replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') ||
        'unknown-domain';
    const safeVersion = String(meta.versionName || meta.version || 'unknown-version')
        .replace(/[^a-z0-9.-]+/gi, '-').replace(/^-+|-+$/g, '') || 'unknown-version';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    return `image-finder-debug-${safeVersion}-${safeDomain}-${timestamp}-${meta.scanId}.json`;
}

function getDebugLogFolder(date = new Date()) {
    const year = String(date.getFullYear());
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');

    return `logs/imagefinder/${year}_${month}_${day}`;
}

async function exportDebugCollector(scanId) {
    const collector = debugCollectorsByScanId.get(scanId);
    if (!collector || collector.exported) return;

    collector.exported = true;
    const payload = JSON.stringify({meta: collector.meta, records: collector.records}, null, 2);
    try {
        await downloadBlob(new Blob([payload], {type: 'application/json'}), {
            filename: `${getDebugLogFolder()}/${getDebugFilename(collector.meta)}`,
            saveAs: false,
            conflictAction: 'uniquify'
        });
    } catch {
        // Export failure must never alter DeepScan completion.
    } finally {
        debugCollectorsByScanId.delete(scanId);
        if (activeDebugLogContext?.scanId === scanId) activeDebugLogContext = null;
        debugBackgroundLogger?.clearContext(scanId);
    }
}

function queueDebugCollectorExport(collector, delayMs) {
    if (!collector || collector.exported) return;
    if (collector.exportTimer !== null) clearTimeout(collector.exportTimer);
    collector.exportTimer = setTimeout(() => {
        collector.exportTimer = null;
        void exportDebugCollector(collector.meta.scanId);
    }, delayMs);
}

function handleDebugContextComplete(message) {
    if (message?.source !== 'popup' || typeof message.scanId !== 'string') return;
    const collector = debugCollectorsByScanId.get(message.scanId);
    if (!collector || collector.exported) return;

    collector.popupComplete = true;
    // ✏️ EDIT 2026-10-13: The popup closes its context only after all queued batches are processed.
    collector.meta.endedAt = new Date().toISOString();
    if (!collector.meta.status) return;
    const flush = debugBackgroundLogger?.flush?.() ?? Promise.resolve();
    void flush.finally(() => {
        queueDebugCollectorExport(collector, DEBUG_LOG_POPUP_FINAL_DELAY_MS);
    });
}

// ✏️ EDIT 2026-10-13: Waits for final popup records independently of port-registration timing.
function isPopupDebugContextPending(collector) {
    return collector?.enabledSources?.popup === true &&
        collector.popupComplete !== true &&
        collector.popupDisconnected !== true;
}

// ✴️ NEW 2026-10-11: Exports completed records when their popup can no longer close the context.
function scheduleDisconnectedPopupDebugExports(clientId) {
    debugCollectorsByScanId.forEach((collector) => {
        if (collector.popupClientId !== clientId || collector.exported) {
            return;
        }

        collector.popupDisconnected = true;
        if (!collector.meta.status) return;
        collector.meta.endedAt ??= new Date().toISOString();
        queueDebugCollectorExport(collector, DEBUG_LOG_EXPORT_DELAY_MS);
    });
}

function scheduleDebugExport(job, status, reason = null) {
    const collector = debugCollectorsByScanId.get(job?.scanId);
    if (!collector || collector.exported) return;

    // ✏️ EDIT 2026-10-13: Retains hidden completion separately from the eventual popup completion.
    collector.meta.hiddenCompletedAt ??= new Date().toISOString();
    collector.meta.status = status;
    if (typeof reason === 'string' && reason) collector.meta.reason = reason;
    if (!isPopupDebugContextPending(collector)) {
        collector.meta.endedAt ??= collector.meta.hiddenCompletedAt;
    }
    const flush = debugBackgroundLogger?.flush?.() ?? Promise.resolve();
    void flush.finally(() => {
        // ✏️ EDIT 2026-10-11: An open popup flushes its own terminal records first.
        if (isPopupDebugContextPending(collector)) return;
        queueDebugCollectorExport(
            collector,
            collector.popupComplete ? DEBUG_LOG_POPUP_FINAL_DELAY_MS : DEBUG_LOG_EXPORT_DELAY_MS
        );
    });
}

function getPopupDeepScanClientId(port) {
    const prefix = `${POPUP_DEEP_SCAN_PORT_NAME}:`;
    if (typeof port?.name !== 'string' || !port.name.startsWith(prefix)) return null;

    const clientId = port.name.slice(prefix.length);
    return clientId || null;
}

function getDeepScanCancelSource(endReason) {
    if (endReason === 'user-abort') return 'user';
    if (endReason === 'popup-closed') return 'popup-closed';
    if (endReason === 'settings-open') return 'settings-open';
    if (endReason === 'tab-reload') return 'tab-reload';
    return null;
}

function isTerminalDownloadState(state) {
    return TERMINAL_DOWNLOAD_STATES.has(state);
}

function canCreateObjectUrlHere() {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

function canUseOffscreenDocument() {
    return typeof chrome.offscreen?.createDocument === 'function';
}

function canUseProtectedDeepScanFrameRule() {
    return typeof chrome.declarativeNetRequest?.updateSessionRules === 'function';
}

function isHiddenDeepScanFrameUnavailableReason(reason) {
    return reason === EMBED_BLOCKED_OR_LOAD_FAILED ||
        (typeof reason === 'string' && /^HIDDEN_FRAME_(?:LOAD|READY)_TIMEOUT:/.test(reason));
}

function isMissingMessageReceiverError(error) {
    return /Receiving end does not exist/i.test(getErrorMessage(error));
}

function queueProtectedDeepScanFrameRuleUpdate(update) {
    const queuedUpdate = protectedDeepScanFrameRuleUpdate
        .catch(() => undefined)
        .then(update);

    protectedDeepScanFrameRuleUpdate = queuedUpdate.catch(() => undefined);
    return queuedUpdate;
}

function createProtectedDeepScanFrameRule(url) {
    const targetURL = new URL(url);
    targetURL.hash = '';

    return {
        id: PROTECTED_DEEP_SCAN_FRAME_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                {header: 'X-Frame-Options', operation: 'remove'},
                {header: 'Content-Security-Policy', operation: 'remove'}
            ]
        },
        condition: {
            urlFilter: `|${targetURL.href}|`,
            isUrlFilterCaseSensitive: true,
            requestMethods: ['get'],
            resourceTypes: ['sub_frame'],
            tabIds: [Number.isInteger(chrome.tabs?.TAB_ID_NONE) ? chrome.tabs.TAB_ID_NONE : -1]
        }
    };
}

async function installProtectedDeepScanFrameRule(job) {
    if (!canUseProtectedDeepScanFrameRule()) {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        throw new Error('Temporary frame rules are unavailable');
    }

    const rule = createProtectedDeepScanFrameRule(job.url);
    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [PROTECTED_DEEP_SCAN_FRAME_RULE_ID],
                addRules: [rule]
            })
        );
        protectedDeepScanFrameRuleOwner = {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        };
    } catch (error) {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        throw error;
    }
}

async function removeProtectedDeepScanFrameRule(scanId = null) {
    const owner = protectedDeepScanFrameRuleOwner;
    if (scanId && owner && owner.scanId !== scanId) return false;
    if (!canUseProtectedDeepScanFrameRule()) return false;

    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [PROTECTED_DEEP_SCAN_FRAME_RULE_ID]
            })
        );
        if (!scanId || protectedDeepScanFrameRuleOwner?.scanId === scanId) {
            protectedDeepScanFrameRuleOwner = null;
        }
        return true;
    } catch {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: scanId ?? owner?.scanId ?? '',
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        return false;
    }
}

function createHiddenDeepScanFrameRule(url, tabId) {
    const targetURL = new URL(url);
    targetURL.hash = '';

    return {
        id: HIDDEN_DEEP_SCAN_FRAME_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                {header: 'X-Frame-Options', operation: 'remove'},
                {header: 'Content-Security-Policy', operation: 'remove'}
            ]
        },
        condition: {
            urlFilter: `|${targetURL.href}|`,
            isUrlFilterCaseSensitive: true,
            requestMethods: ['get'],
            resourceTypes: ['sub_frame'],
            tabIds: [tabId]
        }
    };
}

function logHiddenDeepScanFallback(job, phase, details = {}) {
    console.info('[DeepScan HIDDEN FALLBACK]', {
        scanId: job?.scanId ?? null,
        url: job?.url ?? null,
        token: job?.token ?? null,
        allowProtectedDeepScan: job?.allowProtectedDeepScan === true,
        protectedFrameRuleAttempted: job?.protectedFrameRuleAttempted === true,
        phase,
        ...details
    });
}

async function installHiddenDeepScanFrameRule(job) {
    if (!canUseProtectedDeepScanFrameRule()) {
        throw new Error('Temporary frame rules are unavailable');
    }

    const rule = createHiddenDeepScanFrameRule(job.url, job.tabId);
    await queueProtectedDeepScanFrameRuleUpdate(() =>
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [HIDDEN_DEEP_SCAN_FRAME_RULE_ID],
            addRules: [rule]
        })
    );
    hiddenDeepScanFrameRuleOwner = {
        scanId: job.scanId,
        ruleId: HIDDEN_DEEP_SCAN_FRAME_RULE_ID
    };
}

async function removeHiddenDeepScanFrameRule(scanId = null) {
    const owner = hiddenDeepScanFrameRuleOwner;
    if (scanId && owner && owner.scanId !== scanId) return false;
    if (!canUseProtectedDeepScanFrameRule()) return false;

    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [HIDDEN_DEEP_SCAN_FRAME_RULE_ID]
            })
        );
        if (!scanId || hiddenDeepScanFrameRuleOwner?.scanId === scanId) {
            hiddenDeepScanFrameRuleOwner = null;
        }
        return true;
    } catch {
        return false;
    }
}

// Session rules outlive a suspended service worker, so discard an unowned stale rule on startup.
void removeProtectedDeepScanFrameRule();
void removeHiddenDeepScanFrameRule();

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }

    return btoa(binary);
}

async function blobToDataUrl(blob) {
    const mimeType = blob.type || 'application/octet-stream';
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    return `data:${mimeType};base64,${base64}`;
}

async function readPageBlobAsDataUrl(blobUrl) {
    if (typeof blobUrl !== 'string' || !/^blob:/i.test(blobUrl)) {
        throw new Error('The page Blob URL is invalid');
    }

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error('Cannot read the page Blob URL');

    const blob = await response.blob();

    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
            } else {
                reject(new Error('Cannot convert the page Blob to a Data URL'));
            }
        };
        reader.onerror = () => reject(new Error('Cannot read the page Blob'));
        reader.readAsDataURL(blob);
    });
}

async function resolvePageBlob(tabId, blobUrl) {
    if (!Number.isInteger(tabId)) {
        throw new Error('The Blob image source tab is missing');
    }

    let results;
    try {
        results = await chrome.scripting.executeScript({
            target: {tabId},
            func: readPageBlobAsDataUrl,
            args: [blobUrl]
        });
    } catch (error) {
        throw new Error(`Cannot resolve Blob image in its source tab: ${getErrorMessage(error)}`);
    }

    const dataUrl = results[0]?.result;
    if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
        throw new Error('The source tab did not return a valid image Data URL');
    }

    return dataUrl;
}

// ✴️ NEW 2026-10-15: Reads a page-local Blob in bounded chunks from its source tab.
async function streamPageBlobToExtension(blobUrl, transferId, chunkSize) {
    if (typeof blobUrl !== 'string' || !/^blob:/i.test(blobUrl)) {
        throw new Error('The page Blob URL is invalid');
    }
    if (typeof transferId !== 'string' || !transferId || !Number.isInteger(chunkSize) || chunkSize <= 0) {
        throw new Error('The ZIP Blob transfer is invalid');
    }

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error('Cannot read the page Blob URL');

    const blob = await response.blob();
    const sendChunk = async (action, payload = {}) => {
        const result = await chrome.runtime.sendMessage({
            target: 'image-finder-offscreen',
            source: 'zip-blob-transfer',
            action,
            transferId,
            ...payload
        });
        if (result?.success !== true) {
            throw new Error(result?.error || 'Cannot transfer the page Blob for ZIP creation');
        }
    };
    const encodeBase64 = (buffer) => {
        const bytes = new Uint8Array(buffer);
        const characterChunkSize = 0x8000;
        let binary = '';

        for (let offset = 0; offset < bytes.length; offset += characterChunkSize) {
            binary += String.fromCharCode(...bytes.subarray(offset, offset + characterChunkSize));
        }

        return btoa(binary);
    };

    await sendChunk('startMediaZipBlobTransfer', {byteLength: blob.size});

    let index = 0;
    for (let offset = 0; offset < blob.size; offset += chunkSize) {
        const part = await blob.slice(offset, Math.min(offset + chunkSize, blob.size)).arrayBuffer();

        await sendChunk('storeMediaZipBlobChunk', {
            index: index++,
            data: encodeBase64(part)
        });
    }

    return {byteLength: blob.size, chunks: index};
}

// ✴️ NEW 2026-10-15: Streams one tab-local Blob into the offscreen ZIP document without a large message.
async function streamPageBlobToOffscreen(tabId, blobUrl, transferId) {
    if (!Number.isInteger(tabId)) {
        throw new Error('The Blob image source tab is missing');
    }
    if (typeof transferId !== 'string' || !transferId) {
        throw new Error('The ZIP Blob transfer is invalid');
    }

    activeZipBlobTransfers.add(transferId);
    try {
        await chrome.scripting.executeScript({
            target: {tabId},
            func: streamPageBlobToExtension,
            args: [blobUrl, transferId, ZIP_BLOB_TRANSFER_CHUNK_BYTES]
        });
    } catch (error) {
        throw new Error(`Cannot stream Blob image from its source tab: ${getErrorMessage(error)}`);
    } finally {
        activeZipBlobTransfers.delete(transferId);
    }
}

// ✴️ NEW 2026-10-15: Relays one bounded source-tab Blob fragment to the offscreen ZIP document.
async function relayPageBlobZipTransfer(message) {
    const transferId = message?.transferId;
    if (typeof transferId !== 'string' || !activeZipBlobTransfers.has(transferId)) {
        throw new Error('The ZIP Blob transfer is no longer active');
    }

    if (message.action === 'startMediaZipBlobTransfer') {
        await sendOffscreenMessage('startMediaZipBlobTransfer', {
            transferId,
            byteLength: message.byteLength
        });
        return;
    }

    if (message.action === 'storeMediaZipBlobChunk') {
        await sendOffscreenMessage('storeMediaZipBlobChunk', {
            transferId,
            index: message.index,
            data: message.data
        });
        return;
    }

    throw new Error('The ZIP Blob transfer action is invalid');
}

function releaseBackgroundObjectUrl(downloadId) {
    const objectUrl = backgroundObjectUrlsByDownloadId.get(downloadId);
    if (!objectUrl) return;

    backgroundObjectUrlsByDownloadId.delete(downloadId);
    URL.revokeObjectURL(objectUrl);
}

async function isOffscreenDocumentOpen() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if (typeof chrome.runtime?.getContexts === 'function') {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });

        return contexts.length > 0;
    }

    if (typeof clients !== 'undefined' && typeof clients.matchAll === 'function') {
        const matchedClients = await clients.matchAll();
        return matchedClients.some(client => client.url === offscreenUrl);
    }

    throw new Error('Cannot determine whether the offscreen document already exists');
}

async function ensureOffscreenDocument() {
    if (!canUseOffscreenDocument()) {
        throw new Error('This background context cannot create Blob URLs or an offscreen document');
    }

    if (await isOffscreenDocumentOpen()) return;
    if (creatingOffscreenDocument) return creatingOffscreenDocument;

    creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['BLOBS', 'IFRAME_SCRIPTING', 'DOM_SCRAPING'],
        justification: 'Create durable Blob URLs, host an isolated iframe, and analyze image content outside the popup.'
    });

    try {
        await creatingOffscreenDocument;
    } finally {
        creatingOffscreenDocument = null;
    }
}

async function sendOffscreenMessage(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action,
        ...payload
    });

    if (response?.success !== true) {
        throw new Error(response?.error || `Offscreen request "${action}" failed`);
    }

    return response;
}

// ✴️ NEW 2026-10-15: Lets the offscreen document create large ZIP Blobs without runtime-message payloads.
async function downloadMediaZipInOffscreen(media, options, jobId) {
    await ensureOffscreenDocument();
    const response = await sendOffscreenMessage('createMediaZip', {media, jobId});

    if (typeof response.token !== 'string' || typeof response.objectUrl !== 'string') {
        throw new Error('The offscreen ZIP service returned an invalid Blob URL');
    }

    if (!Array.isArray(response.results)) {
        throw new Error('The offscreen ZIP service returned invalid results');
    }

    let downloadId;
    try {
        downloadId = await chrome.downloads.download({
            url: response.objectUrl,
            ...options
        });
    } catch (error) {
        try {
            await sendOffscreenMessage('releaseObjectUrl', {token: response.token});
        } catch (releaseError) {
            console.warn('Cannot release failed offscreen ZIP URL:', releaseError);
        }
        throw error;
    }

    offscreenTokensByDownloadId.set(downloadId, response.token);

    try {
        await sendOffscreenMessage('associateDownload', {downloadId, token: response.token});
    } catch (error) {
        if (await releaseFinishedDownloadUrl(downloadId)) return response.results;
        throw error;
    }

    await releaseFinishedDownloadUrl(downloadId);

    return response.results.map(item => item.success === true
        ? {...item, downloadId}
        : item
    );
}

async function sendDeepScanClientMessage(job, message) {
    const isCompletion = message?.action === 'complete' && message.status === 'completed';
    const clientId = job?.popupClientId ?? null;

    try {
        const response = await chrome.runtime.sendMessage({
            target: ISOLATED_DEEP_SCAN_TARGET,
            source: 'background',
            ...message,
            ...(clientId ? {popupClientId: clientId} : {})
        });

        if (isCompletion && response?.success !== true) {
            throw new Error('DEEP_SCAN_CLIENT_ACK_MISSING');
        }

        return true;
    } catch (error) {
        if (isCompletion) {
            console.warn(
                '[DeepScan] completion delivery failed',
                `scanId=${job.scanId}`,
                `clientId=${clientId ?? 'none'}`,
                `error=${getErrorMessage(error)}`
            );
        }
        // The popup may already be closed; the isolated job is intentionally not persistent.
        return false;
    }
}

function queueDeepScanClientMessage(job, message) {
    if (!job || job.cancelled) return Promise.resolve();

    job.clientQueuePending = (job.clientQueuePending ?? 0) + 1;
    job.clientEventQueue = (job.clientEventQueue ?? Promise.resolve())
        .then(() => {
            if (job.cancelled) return undefined;

            const messageForClient = message?.action === 'batch' && message.diagnostic
                ? {
                    ...message,
                    diagnostic: {
                        ...message.diagnostic,
                        backgroundSentAt: Date.now()
                    }
                }
                : message;
            return sendDeepScanClientMessage(job, messageForClient);
        })
        .catch(() => undefined)
        .finally(() => {
            job.clientQueuePending = Math.max(0, (job.clientQueuePending ?? 1) - 1);
        });
    return job.clientEventQueue;
}

function createHiddenDeepScanHostMessage(job, action) {
    return {
        target: HIDDEN_DEEP_SCAN_TARGET,
        source: 'background',
        action,
        scanId: job.scanId,
        token: job.token,
        ...(action === 'start' ? {
            url: job.url,
            minimumImageWidth: job.minimumImageWidth,
            minimumImageHeight: job.minimumImageHeight,
            collectContainerDiagnostics: job.collectContainerDiagnostics === true
        } : {})
    };
}

async function probeHiddenDeepScanHost(job) {
    const response = await chrome.tabs.sendMessage(
        job.tabId,
        createHiddenDeepScanHostMessage(job, 'probe'),
        {frameId: job.hostFrameId}
    );
    if (response?.success !== true) {
        throw new Error('HIDDEN_HOST_LISTENER_NOT_READY');
    }
}

async function injectHiddenDeepScanHost(job) {
    await chrome.scripting.executeScript({
        target: {tabId: job.tabId, frameIds: [job.hostFrameId]},
        files: ['src/debug-logger.js', 'src/deepscan-frame.js'],
        injectImmediately: true
    });
}

async function ensureHiddenDeepScanHost(job) {
    try {
        await probeHiddenDeepScanHost(job);
        return;
    } catch (error) {
        if (!isMissingMessageReceiverError(error)) throw error;
    }

    try {
        await injectHiddenDeepScanHost(job);
        await probeHiddenDeepScanHost(job);
    } catch (error) {
        throw error;
    }
}

async function sendHiddenDeepScanHostMessage(job, action) {
    if (action === 'start') {
        await ensureHiddenDeepScanHost(job);
    }

    const response = await chrome.tabs.sendMessage(
        job.tabId,
        createHiddenDeepScanHostMessage(job, action),
        {frameId: job.hostFrameId}
    );
    if (response?.success !== true) {
        throw new Error('The hidden DeepScan host is unavailable');
    }
}

async function finishHiddenDeepScan(job) {
    if (!job || activeHiddenDeepScan !== job) return;

    activeHiddenDeepScan = null;
    try {
        await sendHiddenDeepScanHostMessage(job, 'cancel');
    } catch {
        // The content-script host may have already removed the hidden iframe.
    } finally {
        await removeHiddenDeepScanFrameRule(job.scanId);
    }
}

async function completeHiddenDeepScanJob(job, status, reason = null, performance = null) {
    await finishHiddenDeepScan(job);

    const isolatedJob = activeIsolatedDeepScan;
    if (isolatedJob?.scanId === job.scanId) {
        await finishIsolatedDeepScan(isolatedJob, status, reason, performance);
    }
}

async function startHiddenDeepScanHost(job) {
    await sendHiddenDeepScanHostMessage(job, 'start');
}

async function retryHiddenDeepScanWithProtectedFrameRule(job) {
    try {
        logHiddenDeepScanFallback(job, 'rule-install-start');
        try {
            await installHiddenDeepScanFrameRule(job);
        } catch (error) {
            logHiddenDeepScanFallback(job, 'rule-install-error', {
                error: getErrorMessage(error)
            });
            throw error;
        }
        logHiddenDeepScanFallback(job, 'rule-install-success');
        if (job.cancelled || activeHiddenDeepScan !== job) {
            await removeHiddenDeepScanFrameRule(job.scanId);
            return;
        }
        logHiddenDeepScanFallback(job, 'retry-start');
        try {
            await startHiddenDeepScanHost(job);
        } catch (error) {
            logHiddenDeepScanFallback(job, 'retry-start-error', {
                error: getErrorMessage(error)
            });
            throw error;
        }
        logHiddenDeepScanFallback(job, 'retry-start-success');
    } catch (error) {
        if (job.cancelled || activeHiddenDeepScan !== job) return;
        await completeHiddenDeepScanJob(job, 'unavailable', getErrorMessage(error));
    }
}

async function startHiddenDeepScan(request) {
    await finishHiddenDeepScan(activeHiddenDeepScan);
    await removeHiddenDeepScanFrameRule();

    const job = {
        scanId: request.scanId,
        token: crypto.randomUUID(),
        tabId: request.tabId,
        hostFrameId: HIDDEN_DEEP_SCAN_HOST_FRAME_ID,
        url: request.url,
        minimumImageWidth: Number.isFinite(request.minimumImageWidth)
            ? Math.max(0, Math.round(request.minimumImageWidth))
            : 200,
        minimumImageHeight: Number.isFinite(request.minimumImageHeight)
            ? Math.max(0, Math.round(request.minimumImageHeight))
            : 200,
        collectContainerDiagnostics: request.collectContainerDiagnostics === true,
        allowProtectedDeepScan: request.allowProtectedDeepScan === true,
        protectedFrameRuleAttempted: false,
        cancelled: false
    };
    activeHiddenDeepScan = job;

    try {
        await startHiddenDeepScanHost(job);
    } catch (error) {
        await finishHiddenDeepScan(job);
        throw error;
    }
}

function handleHiddenDeepScanEvent(event) {
    const job = activeHiddenDeepScan;
    if (!job || job.cancelled || event?.scanId !== job.scanId) return;

    const isolatedJob = activeIsolatedDeepScan;
    if (!isolatedJob || isolatedJob.scanId !== job.scanId) return;
    if (event.action === 'hidden-state' && typeof event.phase === 'string' && event.state) {
        return;
    }
    if (event.action === 'hidden-error' && typeof event.kind === 'string') {
        console.error('[DeepScan HIDDEN ERROR]', {
            kind: event.kind,
            message: typeof event.message === 'string' ? event.message : 'UNKNOWN_ERROR'
        });
        return;
    }
    if (event.action === 'batch' && Array.isArray(event.candidates)) {
        if (isolatedJob.cancelled) return;
        const diagnostic = event.diagnostic && typeof event.diagnostic === 'object'
            ? {
                ...event.diagnostic,
                backgroundReceivedAt: Date.now()
            }
            : null;
        void queueDeepScanClientMessage(isolatedJob, {
            action: 'batch',
            scanId: isolatedJob.scanId,
            url: isolatedJob.url,
            candidates: event.candidates,
            ...(diagnostic ? {diagnostic} : {})
        });
        return;
    }
    if (event.action !== 'complete') return;

    const isHiddenFrameUnavailable = event.status === 'unavailable' &&
        isHiddenDeepScanFrameUnavailableReason(event.reason);
    const retryConditionMatched = isHiddenFrameUnavailable &&
        job.allowProtectedDeepScan && !job.protectedFrameRuleAttempted;
    if (isHiddenFrameUnavailable) {
        logHiddenDeepScanFallback(job, 'decision', {
            status: event.status,
            reason: event.reason ?? null,
            retryConditionMatched
        });
    }
    if (retryConditionMatched) {
        job.protectedFrameRuleAttempted = true;
        void retryHiddenDeepScanWithProtectedFrameRule(job);
        return;
    }
    const status = ['completed', 'cancelled', 'unavailable', 'failed'].includes(event.status)
        ? event.status
        : 'failed';
    void completeHiddenDeepScanJob(job, status, event.reason, event.performance);
}

function logIsolatedDeepScanFailure(job, status, reason = null) {
    if (!job || job.errorLogged) return;
    job.errorLogged = true;

    if (status === 'unavailable') {
        console.error('[DeepScan] Isolated context unavailable:', {
            url: job.url,
            reason: reason || 'UNKNOWN'
        });
        return;
    }
    console.error('[DeepScan] Isolated scan failed:', job.url, reason || 'UNKNOWN_ERROR');
}

async function finishIsolatedDeepScan(job, status, reason = null, performance = null) {
    if (!job || activeIsolatedDeepScan !== job) return;

    if (activeHiddenDeepScan?.scanId === job.scanId) {
        await finishHiddenDeepScan(activeHiddenDeepScan);
    }
    activeIsolatedDeepScan = null;
    await removeProtectedDeepScanFrameRule(job.scanId);
    if (!['completed', 'cancelled'].includes(status)) {
        logIsolatedDeepScanFailure(job, status, reason);
    }
    await job.clientEventQueue?.catch(() => undefined);
    await sendDeepScanClientMessage(job, {
        action: 'complete',
        scanId: job.scanId,
        url: job.url,
        status,
        ...(typeof reason === 'string' ? {reason} : {}),
        ...(performance && typeof performance === 'object' ? {performance} : {})
    });
    scheduleDebugExport(job, status, reason);
}

async function startIsolatedDeepScanHost(job) {
    if (canUseOffscreenDocument()) {
        await ensureOffscreenDocument();
        await sendOffscreenMessage('startDeepScan', {job});
        return;
    }

    await getBackgroundDeepScanHost().start(job);
}

async function retryProtectedDeepScan(job) {
    try {
        await installProtectedDeepScanFrameRule(job);
        if (job.cancelled || activeIsolatedDeepScan !== job) {
            await removeProtectedDeepScanFrameRule(job.scanId);
            return;
        }

        await startIsolatedDeepScanHost(job);
    } catch (error) {
        if (job.cancelled || activeIsolatedDeepScan !== job) return;
        await finishIsolatedDeepScan(job, 'unavailable', getErrorMessage(error));
    }
}

function handleIsolatedDeepScanHostEvent(event) {
    const job = activeIsolatedDeepScan;
    const isActiveJobEvent = Boolean(job && !job.cancelled && event?.scanId === job.scanId &&
        event.url === job.url);

    if (!isActiveJobEvent) return;
    if (event.action === 'batch' && Array.isArray(event.candidates)) {
        void sendDeepScanClientMessage(job, {
            action: 'batch',
            scanId: job.scanId,
            url: job.url,
            candidates: event.candidates
        });
        return;
    }
    if (event.action !== 'complete') return;

    const status = ['completed', 'cancelled', 'unavailable', 'failed'].includes(event.status)
        ? event.status
        : 'failed';
    if (job.allowProtectedDeepScan && !job.protectedFrameRuleAttempted &&
        status === 'unavailable' && event.reason === EMBED_BLOCKED_OR_LOAD_FAILED) {
        job.protectedFrameRuleAttempted = true;
        void retryProtectedDeepScan(job);
        return;
    }

    void finishIsolatedDeepScan(job, status, event.reason);
}

function getBackgroundDeepScanHost() {
    if (backgroundDeepScanHost) return backgroundDeepScanHost;
    if (typeof document === 'undefined' || typeof globalThis.createIsolatedDeepScanHost !== 'function') {
        throw new Error('This browser has no isolated DeepScan document context');
    }

    backgroundDeepScanHost = globalThis.createIsolatedDeepScanHost({
        emit: handleIsolatedDeepScanHostEvent
    });
    return backgroundDeepScanHost;
}

async function cancelIsolatedDeepScan(scanId = null, endReason = 'cancelled') {
    const job = activeIsolatedDeepScan;
    const normalizedEndReason = ['user-abort', 'popup-closed', 'settings-open', 'tab-reload']
        .includes(endReason)
        ? endReason
        : 'cancelled';
    const hiddenDeepScanJob = activeHiddenDeepScan;
    const hasMatchingHiddenJob = Boolean(hiddenDeepScanJob &&
        (!scanId || hiddenDeepScanJob.scanId === scanId));
    const hasMatchingJob = Boolean(job && (!scanId || job.scanId === scanId));
    const cancellationSource = getDeepScanCancelSource(normalizedEndReason);
    if (!hasMatchingHiddenJob && !hasMatchingJob) return false;
    if (cancellationSource) console.info(`[DeepScan CANCEL] source=${cancellationSource}`);

    if (hasMatchingHiddenJob) {
        hiddenDeepScanJob.cancelled = true;
        await finishHiddenDeepScan(hiddenDeepScanJob);
    }
    if (!hasMatchingJob) {
        if (cancellationSource) console.info('[DeepScan CANCEL COMPLETE]');
        return true;
    }

    job.cancelled = true;
    if (normalizedEndReason === 'user-abort') {
        console.info('[DeepScan] stopped by user', {scanId: job.scanId});
    }
    activeIsolatedDeepScan = null;
    try {
        if (canUseOffscreenDocument()) {
            if (await isOffscreenDocumentOpen()) {
                await sendOffscreenMessage('cancelDeepScan', {scanId: job.scanId});
            }
        } else if (backgroundDeepScanHost) {
            await backgroundDeepScanHost.cancel(job.scanId);
        }
    } catch {
        // Cancelling a discarded host must still finish the popup-side DeepScan cleanly.
    } finally {
        await removeProtectedDeepScanFrameRule(job.scanId);
    }

    await job.clientEventQueue?.catch(() => undefined);
    await sendDeepScanClientMessage(job, {
        action: 'complete',
        scanId: job.scanId,
        url: job.url,
        status: 'cancelled',
        endReason: normalizedEndReason
    });
    if (cancellationSource) console.info('[DeepScan CANCEL COMPLETE]');
    scheduleDebugExport(job, 'cancelled', normalizedEndReason);
    return true;
}

async function startIsolatedDeepScan(request) {
    if (typeof request?.scanId !== 'string' || !request.scanId ||
        typeof request?.url !== 'string' || !request.url || !Number.isInteger(request.tabId)) {
        throw new Error('The isolated DeepScan request is invalid');
    }
    await cancelIsolatedDeepScan();
    await removeProtectedDeepScanFrameRule();
    const job = {
        scanId: request.scanId,
        token: crypto.randomUUID(),
        url: request.url,
        tabId: request.tabId,
        minimumImageWidth: Number.isFinite(request.minimumImageWidth)
            ? Math.max(0, Math.round(request.minimumImageWidth))
            : 200,
        minimumImageHeight: Number.isFinite(request.minimumImageHeight)
            ? Math.max(0, Math.round(request.minimumImageHeight))
            : 200,
        allowProtectedDeepScan: request.allowProtectedDeepScan === true,
        enabledDebugLogSources: getEnabledDebugLogSources(request.debugSettings),
        popupClientId: typeof request.popupClientId === 'string' && request.popupClientId
            ? request.popupClientId
            : null,
        protectedFrameRuleAttempted: false,
        cancelled: false,
        errorLogged: false,
        clientEventQueue: Promise.resolve(),
        clientQueuePending: 0
    };
    activeIsolatedDeepScan = job;
    createDebugCollector(job);

    try {
        const tab = await chrome.tabs.get(job.tabId);
        if (tab?.url !== job.url) {
            await cancelIsolatedDeepScan(job.scanId);
            return {scanId: job.scanId};
        }

        await startHiddenDeepScan({
            scanId: job.scanId,
            tabId: job.tabId,
            url: job.url,
            minimumImageWidth: job.minimumImageWidth,
            minimumImageHeight: job.minimumImageHeight,
            allowProtectedDeepScan: job.allowProtectedDeepScan,
            collectContainerDiagnostics: job.enabledDebugLogSources.popup === true ||
                job.enabledDebugLogSources.tab === true
        });
    } catch (error) {
        await finishIsolatedDeepScan(job, 'unavailable', getErrorMessage(error));
    }

    return {scanId: job.scanId};
}

async function releaseOffscreenObjectUrlForDownload(downloadId) {
    const token = offscreenTokensByDownloadId.get(downloadId);
    offscreenTokensByDownloadId.delete(downloadId);

    if (!canUseOffscreenDocument()) return;

    try {
        if (token) {
            await sendOffscreenMessage('releaseObjectUrl', {token});
            return;
        }

        if (await isOffscreenDocumentOpen()) {
            await sendOffscreenMessage('releaseObjectUrlForDownload', {downloadId});
        }
    } catch (error) {
        console.warn('Cannot release offscreen Object URL:', downloadId, error);
    }
}

async function releaseFinishedDownloadUrl(downloadId) {
    try {
        const [download] = await chrome.downloads.search({id: downloadId});
        if (!isTerminalDownloadState(download?.state)) return false;

        releaseBackgroundObjectUrl(downloadId);
        await releaseOffscreenObjectUrlForDownload(downloadId);
        return true;
    } catch (error) {
        console.warn('Cannot read download status:', downloadId, error);
        return false;
    }
}

async function downloadBlobWithBackgroundObjectUrl(blob, options) {
    const objectUrl = URL.createObjectURL(blob);

    try {
        const downloadId = await chrome.downloads.download({
            url: objectUrl,
            ...options
        });

        backgroundObjectUrlsByDownloadId.set(downloadId, objectUrl);
        await releaseFinishedDownloadUrl(downloadId);
        return downloadId;
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

async function downloadBlobWithOffscreenDocument(blob, options) {
    await ensureOffscreenDocument();

    const dataUrl = await blobToDataUrl(blob);
    const {token, objectUrl} = await sendOffscreenMessage('createObjectUrl', {dataUrl});
    if (typeof token !== 'string' || typeof objectUrl !== 'string') {
        throw new Error('Offscreen document returned an invalid Blob URL');
    }

    let downloadId;
    try {
        downloadId = await chrome.downloads.download({
            url: objectUrl,
            ...options
        });
    } catch (error) {
        try {
            await sendOffscreenMessage('releaseObjectUrl', {token});
        } catch (releaseError) {
            console.warn('Cannot release failed offscreen download URL:', releaseError);
        }
        throw error;
    }

    offscreenTokensByDownloadId.set(downloadId, token);

    try {
        await sendOffscreenMessage('associateDownload', {downloadId, token});
    } catch (error) {
        if (await releaseFinishedDownloadUrl(downloadId)) return downloadId;
        throw error;
    }

    await releaseFinishedDownloadUrl(downloadId);
    return downloadId;
}

async function downloadBlob(blob, options) {
    if (canCreateObjectUrlHere()) {
        return downloadBlobWithBackgroundObjectUrl(blob, options);
    }

    return downloadBlobWithOffscreenDocument(blob, options);
}

chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (!isTerminalDownloadState(state)) return;

    releaseBackgroundObjectUrl(delta.id);
    void releaseOffscreenObjectUrlForDownload(delta.id);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const job = activeIsolatedDeepScan;
    const hiddenDeepScan = activeHiddenDeepScan;
    if (hiddenDeepScan && tabId === hiddenDeepScan.tabId && typeof changeInfo.url === 'string' &&
        changeInfo.url !== hiddenDeepScan.url) {
        void completeHiddenDeepScanJob(hiddenDeepScan, 'cancelled');
    }
    if (!job || tabId !== job.tabId || typeof changeInfo.url !== 'string' || changeInfo.url === job.url) {
        return;
    }

    void cancelIsolatedDeepScan(job.scanId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeHiddenDeepScan?.tabId === tabId) {
        void completeHiddenDeepScanJob(activeHiddenDeepScan, 'cancelled');
    }
    if (activeIsolatedDeepScan?.tabId === tabId) {
        void cancelIsolatedDeepScan(activeIsolatedDeepScan.scanId);
    }
});

chrome.runtime.onInstalled.addListener(() => {
    void reopenPopupAfterExtensionRestart();
});

chrome.runtime.onConnect.addListener((port) => {
    const clientId = getPopupDeepScanClientId(port);
    if (!clientId) return;

    popupDeepScanPorts.set(clientId, port);
    port.onDisconnect.addListener(() => {
        if (popupDeepScanPorts.get(clientId) !== port) return;

        popupDeepScanPorts.delete(clientId);
        scheduleDisconnectedPopupDebugExports(clientId);
        const job = activeIsolatedDeepScan;
        if (job?.popupClientId !== clientId) return;

        void cancelIsolatedDeepScan(job.scanId, 'popup-closed');
    });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message?.target === DEBUG_LOG_TARGET) {
        if (message.action === 'records') collectDebugRecords(message.records);
        else if (message.action === 'context-complete') handleDebugContextComplete(message);
        sendResponse({success: true});
        return undefined;
    }

    if (message?.target === OFFSCREEN_TARGET) {
        // ✏️ EDIT 2026-10-15: Relays compact ZIP preparation progress from the offscreen document.
        if (message.source === 'offscreen' && message.action === 'zipProgress') {
            downLoader?.updateJob(message.jobId, message.progress);
            return undefined;
        }

        if (message.source === 'offscreen' && message.action === 'resolveMediaZipBlob') {
            Promise.resolve(streamPageBlobToOffscreen(
                message.tabId,
                message.blobUrl,
                message.transferId
            )).then(
                () => sendResponse({success: true, transferId: message.transferId}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }

        if (message.source === 'zip-blob-transfer' &&
            ['startMediaZipBlobTransfer', 'storeMediaZipBlobChunk'].includes(message.action)) {
            Promise.resolve(relayPageBlobZipTransfer(message)).then(
                () => sendResponse({success: true}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }

        return undefined;
    }

    if (message?.target === OFFSCREEN_ANALYZER_CONTROL_TARGET) {
        if (message.action !== 'ensureOffscreenDocument') return undefined;

        Promise.resolve(ensureOffscreenDocument()).then(
            () => sendResponse({success: true}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message?.target === HIDDEN_DEEP_SCAN_TARGET) {
        if (message.source === 'hidden-deepscan-host') {
            handleHiddenDeepScanEvent(message);
            sendResponse({success: true});
        }
        return undefined;
    }

    if (message?.target === ONLYFANS_MAIN_WORLD_TARGET) {
        Promise.resolve(requestOnlyFansMainWorldPageAction(message, sender)).then(
            (result) => sendResponse({success: true, result}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message?.target === ISOLATED_DEEP_SCAN_TARGET) {
        if (message.source === 'isolated-host') {
            handleIsolatedDeepScanHostEvent(message);
            return undefined;
        }
        if (message.source === 'background') return undefined;

        if (message.action === 'start') {
            Promise.resolve(startIsolatedDeepScan(message)).then(
                (result) => sendResponse({success: true, ...result}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }
        if (message.action === 'cancel') {
            Promise.resolve(cancelIsolatedDeepScan(message.scanId, message.endReason)).then(
                (cancelled) => sendResponse({success: true, cancelled}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }

        return undefined;
    }

    if (message?.action === 'resolveBlobImage') {
        Promise.resolve(resolvePageBlob(message.tabId, message.blobUrl)).then(
            (dataUrl) => sendResponse({success: true, dataUrl}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );

        return true;
    }

    if (message?.action === 'downloadImage') {
        if (!downLoader) {
            sendResponse({success: false, error: 'The background download service is unavailable'});
            return undefined;
        }

        Promise.resolve(downLoader.download(message)).then(
            (downloadId) => sendResponse({success: true, downloadId}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );

        return true;
    }

    if (message?.action !== 'downloadImageList' || !Array.isArray(message.images)) {
        return undefined;
    }

    const zipRequested = message?.zip?.enabled === true;
    if (zipRequested && (!message.zip.options || typeof message.zip.options !== 'object')) {
        sendResponse({success: false, error: 'ZIP download options are invalid'});
        return undefined;
    }

    if (!downLoader) {
        sendResponse({success: false, error: 'The background download service is unavailable'});
        return undefined;
    }

    try {
        // ✏️ EDIT 2026-10-15: A list request now starts a background job immediately.
        const job = downLoader.startList(
            message.images,
            zipRequested ? message.zip.options : null
        );
        sendResponse({success: true, job});
    } catch (error) {
        sendResponse({success: false, error: getErrorMessage(error)});
    }

    return undefined;
});
