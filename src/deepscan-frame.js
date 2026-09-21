(() => {
    const FRAME_MESSAGE_TARGET = 'image-finder-isolated-deepscan-frame';
    const HIDDEN_DEEP_SCAN_TARGET = 'image-finder-hidden-deepscan';
    const HIDDEN_DEEP_SCAN_FRAME_TARGET = 'image-finder-hidden-deepscan-frame';
    const HIDDEN_DEEP_SCAN_HANDSHAKE_TIMEOUT_MS = 10000;
    const HIDDEN_DEEP_SCAN_LOAD_GRACE_MS = 15000;
    const HIDDEN_DEEP_SCAN_HYDRATION_POLL_INTERVAL_MS = 100;
    const HIDDEN_DEEP_SCAN_HYDRATION_STABLE_MS = 2500;
    const HIDDEN_DEEP_SCAN_HYDRATION_MAX_WAIT_MS = 10000;
    const HIDDEN_DEEP_SCAN_ACTIVE_CONTAINER_COLORS = [
        '#ff634733',
        '#90ee9040',
        '#a5cef255'
    ];
    const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
    let activeScan = null;
    let activeHiddenDeepScanHost = null;
    let activeHiddenDeepScanFrame = null;

    const sendToHost = (message) => {
        window.parent.postMessage({
            target: FRAME_MESSAGE_TARGET,
            ...message
        }, extensionOrigin);
    };
    const sendReady = (scan) => {
        sendToHost({action: 'ready', scanId: scan.scanId, token: scan.token});
    };
    const sendHiddenDeepScanEvent = async (message) => {
        const isCompletion = message?.action === 'complete';

        if (isCompletion) {
            console.info(
                '[DeepScan COMPLETE TRACE] host-send-start',
                `scanId=${message.scanId}`,
                `status=${message.status}`
            );
        }

        try {
            const response = await chrome.runtime.sendMessage({
                target: HIDDEN_DEEP_SCAN_TARGET,
                source: 'hidden-deepscan-host',
                ...message
            });
            if (response?.success !== true) {
                throw new Error('Hidden DeepScan background acknowledgement failed');
            }
            if (isCompletion) {
                console.info(
                    '[DeepScan COMPLETE TRACE] host-send-success',
                    `scanId=${message.scanId}`,
                    `status=${message.status}`
                );
            }
            return true;
        } catch (error) {
            if (isCompletion) {
                console.error(
                    '[DeepScan COMPLETE TRACE] host-send-error',
                    `scanId=${message.scanId}`,
                    `error=${getDiagnosticErrorMessage(error)}`
                );
            }
            return false;
        }
    };
    const getSafeLocation = (location) => {
        try {
            return `${location.origin}${location.pathname}`;
        } catch {
            return '(unavailable)';
        }
    };
    const getHiddenStateSnapshot = (frameWindow = window) => {
        try {
            const documentElement = frameWindow.document.documentElement;
            const body = frameWindow.document.body;
            const scrollElement = frameWindow.document.scrollingElement ?? documentElement;

            return {
                location: getSafeLocation(frameWindow.location),
                readyState: frameWindow.document.readyState,
                bodyChildren: body?.children.length ?? 0,
                domElements: frameWindow.document.getElementsByTagName('*').length,
                images: frameWindow.document.images?.length ?? 0,
                scrollHeight: Math.max(
                    documentElement?.scrollHeight ?? 0,
                    body?.scrollHeight ?? 0,
                    scrollElement?.scrollHeight ?? 0
                ),
                hasBeforePreloader: Boolean(frameWindow.document.querySelector(
                    'before_preloader, #before_preloader, .before_preloader'
                ))
            };
        } catch {
            return {
                location: '(unavailable)',
                readyState: '(unavailable)',
                bodyChildren: 0,
                domElements: 0,
                images: 0,
                scrollHeight: 0,
                hasBeforePreloader: false
            };
        }
    };
    const getDiagnosticErrorMessage = (reason) => {
        const message = reason instanceof Error
            ? reason.message
            : typeof reason === 'string'
                ? reason
                : '';

        return message ? message.slice(0, 240) : 'UNKNOWN_ERROR';
    };
    const logHiddenState = (phase, state) => {
        console.log(
            '[DeepScan HIDDEN STATE]',
            `phase=${phase}`,
            `location=${state.location}`,
            `readyState=${state.readyState}`,
            `bodyChildren=${state.bodyChildren}`,
            `domElements=${state.domElements}`,
            `images=${state.images}`,
            `scrollHeight=${state.scrollHeight}`,
            `hasBeforePreloader=${state.hasBeforePreloader}`
        );
    };
    const logHiddenError = (kind, message) => {
        console.error('[DeepScan HIDDEN ERROR]', `kind=${kind}`, `message=${message}`);
    };
    const getElementPathFromBody = (element) => {
        if (!element?.isConnected || !document.body?.contains(element)) return null;

        const path = [];
        let current = element;
        while (current && current !== document.body) {
            const parent = current.parentElement;
            const index = parent ? Array.prototype.indexOf.call(parent.children, current) : -1;
            if (!parent || index < 0) return null;

            path.unshift(index);
            current = parent;
        }

        return current === document.body
            ? {path, tagName: element.tagName}
            : null;
    };
    const getElementFromBodyPath = (descriptor) => {
        if (!Array.isArray(descriptor?.path) || descriptor.path.length === 0 ||
            descriptor.path.length > 128 || typeof descriptor.tagName !== 'string') {
            return null;
        }

        let current = document.body;
        for (const index of descriptor.path) {
            if (!Number.isInteger(index) || index < 0) return null;
            current = current?.children[index] ?? null;
            if (!current) return null;
        }

        return current?.tagName === descriptor.tagName ? current : null;
    };
    const clearVisibleContainerMarker = (scan) => {
        const marker = scan?.visibleContainerMarker;
        if (!marker) return;

        const {element, value, priority} = marker;
        if (element?.isConnected) {
            if (value) element.style.setProperty('background-color', value, priority);
            else element.style.removeProperty('background-color');
        }
        scan.visibleContainerMarker = null;
    };
    const setVisibleContainerMarker = (scan, descriptor, colorIndex = 0) => {
        clearVisibleContainerMarker(scan);
        const element = getElementFromBodyPath(descriptor);
        if (!element) return;
        const index = Number.isInteger(colorIndex) ? colorIndex : 0;
        const color = HIDDEN_DEEP_SCAN_ACTIVE_CONTAINER_COLORS[
            ((index % HIDDEN_DEEP_SCAN_ACTIVE_CONTAINER_COLORS.length) +
                HIDDEN_DEEP_SCAN_ACTIVE_CONTAINER_COLORS.length) %
                HIDDEN_DEEP_SCAN_ACTIVE_CONTAINER_COLORS.length
        ];

        scan.visibleContainerMarker = {
            element,
            value: element.style.getPropertyValue('background-color'),
            priority: element.style.getPropertyPriority('background-color'),
            color
        };
        element.style.setProperty('background-color', color, 'important');
    };
    const sendHiddenDeepScanFrameMessage = (scan, message) => {
        window.parent.postMessage({
            target: HIDDEN_DEEP_SCAN_FRAME_TARGET,
            scanId: scan.scanId,
            token: scan.token,
            ...message
        }, scan.parentOrigin);
    };
    const completeHiddenDeepScanFrame = (scan, status, reason = null, endReason = null) => {
        if (!scan || scan.completed) return;

        scan.completed = true;
        scan.cleanupDiagnostics?.();
        scan.stateTimeouts?.forEach((timeout) => clearTimeout(timeout));
        sendHiddenDeepScanFrameMessage(scan, {
            action: 'complete',
            status,
            ...(typeof reason === 'string' && reason ? {reason} : {}),
            ...(typeof endReason === 'string' && endReason ? {endReason} : {})
        });
        if (activeHiddenDeepScanFrame === scan) activeHiddenDeepScanFrame = null;
    };
    const sendHiddenDeepScanFrameState = (scan, phase) => {
        if (!scan || scan.completed) return;

        const state = getHiddenStateSnapshot();
        logHiddenState(phase, state);
        sendHiddenDeepScanFrameMessage(scan, {
            action: 'hidden-state',
            phase,
            state
        });
    };
    const sendHiddenDeepScanFrameError = (scan, kind, reason) => {
        if (!scan || scan.completed) return;

        const message = getDiagnosticErrorMessage(reason);
        logHiddenError(kind, message);
        sendHiddenDeepScanFrameMessage(scan, {
            action: 'hidden-error',
            kind,
            message
        });
    };
    const installHiddenDeepScanFrameDiagnostics = (scan) => {
        const onError = (event) => {
            if (event.target !== window) return;

            sendHiddenDeepScanFrameError(scan, 'runtime', event.message || event.error);
        };
        const onUnhandledRejection = (event) => {
            sendHiddenDeepScanFrameError(scan, 'unhandledrejection', event.reason);
        };
        const onSecurityPolicyViolation = (event) => {
            sendHiddenDeepScanFrameError(scan, 'csp', event.violatedDirective || 'policy violation');
        };

        window.addEventListener('error', onError, true);
        window.addEventListener('unhandledrejection', onUnhandledRejection);
        document.addEventListener('securitypolicyviolation', onSecurityPolicyViolation);

        return () => {
            window.removeEventListener('error', onError, true);
            window.removeEventListener('unhandledrejection', onUnhandledRejection);
            document.removeEventListener('securitypolicyviolation', onSecurityPolicyViolation);
        };
    };
    const isSameHiddenHydrationState = (first, second) =>
        first.readyState === second.readyState &&
        first.bodyChildren === second.bodyChildren &&
        first.domElements === second.domElements &&
        first.images === second.images &&
        first.scrollHeight === second.scrollHeight;
    const isRelevantHiddenHydrationMutation = (record) => {
        if (record.type !== 'childList') return false;

        return [...record.addedNodes, ...record.removedNodes].some((node) => {
            if (node.nodeType === Node.ELEMENT_NODE) return true;
            if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return false;

            return node.querySelector?.('*') !== null;
        });
    };
    const waitForHiddenFrameHydration = (scan) => new Promise((resolve) => {
        const startedAt = Date.now();
        const deadline = startedAt + HIDDEN_DEEP_SCAN_HYDRATION_MAX_WAIT_MS;
        let previousState = getHiddenStateSnapshot();
        let lastRelevantActivityAt = startedAt;
        let observer = null;
        let timer = null;
        let finished = false;
        const finish = (shouldStart) => {
            if (finished) return;

            finished = true;
            clearTimeout(timer);
            observer?.disconnect();
            scan.controller.signal.removeEventListener('abort', onAbort);
            resolve(shouldStart);
        };
        const noteRelevantActivity = () => {
            lastRelevantActivityAt = Date.now();
        };
        const check = () => {
            if (scan.controller.signal.aborted) {
                finish(false);
                return;
            }

            const now = Date.now();
            const state = getHiddenStateSnapshot();
            if (!isSameHiddenHydrationState(previousState, state)) {
                previousState = state;
                noteRelevantActivity();
            }
            if (now >= deadline || (state.readyState !== 'loading' &&
                now - lastRelevantActivityAt >= HIDDEN_DEEP_SCAN_HYDRATION_STABLE_MS)) {
                finish(true);
                return;
            }

            timer = setTimeout(check, HIDDEN_DEEP_SCAN_HYDRATION_POLL_INTERVAL_MS);
        };
        const onAbort = () => finish(false);

        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver((records) => {
                if (records.some(isRelevantHiddenHydrationMutation)) noteRelevantActivity();
            });
            observer.observe(document.documentElement, {
                subtree: true,
                childList: true
            });
        }
        scan.controller.signal.addEventListener('abort', onAbort, {once: true});
        check();
    });
    const initializeHiddenDeepScanFrame = (message, parentOrigin) => {
        if (activeHiddenDeepScanFrame?.scanId === message.scanId &&
            activeHiddenDeepScanFrame.token === message.token) {
            sendHiddenDeepScanFrameMessage(activeHiddenDeepScanFrame, {action: 'ready'});
            return;
        }
        activeHiddenDeepScanFrame?.controller.abort();

        const scan = {
            scanId: message.scanId,
            token: message.token,
            parentOrigin,
            controller: new AbortController(),
            started: false,
            completed: false,
            cleanupDiagnostics: null,
            stateTimeouts: []
        };
        scan.cleanupDiagnostics = installHiddenDeepScanFrameDiagnostics(scan);
        activeHiddenDeepScanFrame = scan;
        sendHiddenDeepScanFrameState(scan, 'load');
        sendHiddenDeepScanFrameMessage(scan, {action: 'ready'});
        sendHiddenDeepScanFrameState(scan, 'ready');
        scan.stateTimeouts.push(setTimeout(() => {
            sendHiddenDeepScanFrameState(scan, '1s');
        }, 1000));
        scan.stateTimeouts.push(setTimeout(() => {
            sendHiddenDeepScanFrameState(scan, '3s');
        }, 3000));
    };
    const startHiddenDeepScanFrame = async (message) => {
        const scan = activeHiddenDeepScanFrame;
        if (!scan || scan.scanId !== message.scanId || scan.token !== message.token || scan.started) {
            return;
        }

        scan.started = true;

        try {
            const {runHiddenFrameDeepScan} = await import(chrome.runtime.getURL('src/content.js'));
            if (!(await waitForHiddenFrameHydration(scan))) {
                completeHiddenDeepScanFrame(scan, 'cancelled');
                return;
            }
            sendHiddenDeepScanFrameState(scan, 'before-start');
            const result = await runHiddenFrameDeepScan({
                ignoreHiddenImages: message.ignoreHiddenImages === true,
                minimumImageWidth: message.minimumImageWidth,
                minimumImageHeight: message.minimumImageHeight,
                signal: scan.controller.signal,
                onBatch: async (candidates, diagnostic = null) => {
                    if (activeHiddenDeepScanFrame !== scan || scan.controller.signal.aborted) return;

                    sendHiddenDeepScanFrameMessage(scan, {
                        action: 'batch',
                        candidates,
                        ...(diagnostic ? {diagnostic} : {})
                    });
                },
                onActiveScrollContainer: (container, colorIndex = 0) => {
                    sendHiddenDeepScanFrameMessage(scan, {
                        action: 'active-container',
                        ...(container ? {
                            container: getElementPathFromBody(container),
                            colorIndex
                        } : {})
                    });
                }
            });
            console.info(
                '[DeepScan COMPLETE TRACE] hidden-return',
                `scanId=${scan.scanId}`,
                `status=${result.status}`,
                `endReason=${result.endReason}`
            );
            completeHiddenDeepScanFrame(scan, result.status, null, result.endReason);
        } catch (error) {
            sendHiddenDeepScanFrameError(scan, 'initialization', error);
            completeHiddenDeepScanFrame(
                scan,
                'failed',
                error instanceof Error ? error.message : String(error)
            );
        }
    };
    const clearHiddenDeepScanHost = (scan) => {
        if (!scan) return;

        clearVisibleContainerMarker(scan);
        clearTimeout(scan.handshakeTimeout);
        clearInterval(scan.handshakeInterval);
        window.removeEventListener('message', scan.onMessage);
        scan.frame.removeEventListener('load', scan.onFrameLoad);
        scan.wrapper.remove();
        if (activeHiddenDeepScanHost === scan) activeHiddenDeepScanHost = null;
    };
    const queueHiddenDeepScanEvent = (scan, message) => {
        scan.eventQueue = scan.eventQueue.then(() =>
            scan.cancelled && message.action !== 'complete'
                ? undefined
                : sendHiddenDeepScanEvent(message)
        ).catch(() => false);
        return scan.eventQueue;
    };
    const finishHiddenDeepScanHost = async (scan, status, reason = null, endReason = null) => {
        if (!scan || scan.finished) return;

        scan.finished = true;
        scan.cancelled = status === 'cancelled';
        console.info(
            '[DeepScan COMPLETE TRACE] host-queue-enter',
            `scanId=${scan.scanId}`,
            `status=${status}`
        );
        try {
            await queueHiddenDeepScanEvent(scan, {
                action: 'complete',
                scanId: scan.scanId,
                status,
                ...(typeof reason === 'string' && reason ? {reason} : {}),
                ...(typeof endReason === 'string' && endReason ? {endReason} : {})
            });
        } finally {
            console.info(
                '[DeepScan COMPLETE TRACE] host-cleanup-start',
                `scanId=${scan.scanId}`,
                `status=${status}`
            );
            clearHiddenDeepScanHost(scan);
        }
    };
    const getHiddenDeepScanHandshakeTimeoutReason = (scan) =>
        scan.frameLoadCount > 0
            ? `HIDDEN_FRAME_READY_TIMEOUT:frameLoads=${scan.frameLoadCount}`
            : 'HIDDEN_FRAME_LOAD_TIMEOUT:frameLoads=0';
    const handleHiddenDeepScanHandshakeTimeout = (scan) => {
        if (!scan || scan.finished || scan.ready) return;

        if (scan.frameLoadCount === 0 && !scan.loadGraceUsed) {
            scan.loadGraceUsed = true;
            scan.handshakeTimeout = setTimeout(
                () => handleHiddenDeepScanHandshakeTimeout(scan),
                HIDDEN_DEEP_SCAN_LOAD_GRACE_MS
            );
            return;
        }

        const reason = getHiddenDeepScanHandshakeTimeoutReason(scan);
        logHiddenError('frame', reason);
        void queueHiddenDeepScanEvent(scan, {
            action: 'hidden-error',
            scanId: scan.scanId,
            kind: 'frame',
            message: reason
        });
        finishHiddenDeepScanHost(scan, 'unavailable', reason);
    };
    const hasExpectedHiddenFrameOrigin = (scan) => {
        try {
            return scan.frame.contentWindow?.location.origin === scan.frameOrigin;
        } catch {
            return false;
        }
    };
    const sendHiddenDeepScanInitialization = (scan) => {
        if (!scan || scan.finished || scan.frameLoadCount === 0 || !hasExpectedHiddenFrameOrigin(scan)) {
            return;
        }

        try {
            scan.frame.contentWindow?.postMessage({
                target: HIDDEN_DEEP_SCAN_FRAME_TARGET,
                action: 'initialize',
                scanId: scan.scanId,
                token: scan.token
            }, scan.frameOrigin);
        } catch {
            // The handshake timeout reports a child frame that cannot be reached.
        }
    };
    const sendHiddenDeepScanStart = (scan) => {
        try {
            scan.frame.contentWindow?.postMessage({
                target: HIDDEN_DEEP_SCAN_FRAME_TARGET,
                action: 'start',
                scanId: scan.scanId,
                token: scan.token,
                ignoreHiddenImages: scan.ignoreHiddenImages === true,
                minimumImageWidth: scan.minimumImageWidth,
                minimumImageHeight: scan.minimumImageHeight
            }, scan.frameOrigin);
        } catch {
            logHiddenError('initialization', 'HIDDEN_FRAME_START_FAILED');
            void queueHiddenDeepScanEvent(scan, {
                action: 'hidden-error',
                scanId: scan.scanId,
                kind: 'initialization',
                message: 'HIDDEN_FRAME_START_FAILED'
            });
            finishHiddenDeepScanHost(scan, 'failed', 'HIDDEN_FRAME_START_FAILED');
        }
    };
    const startHiddenDeepScanHost = (message) => {
        if (activeHiddenDeepScanHost?.scanId === message.scanId &&
            activeHiddenDeepScanHost.token === message.token) {
            return;
        }
        finishHiddenDeepScanHost(activeHiddenDeepScanHost, 'cancelled');

        let frameOrigin;
        try {
            const url = new URL(message.url);
            if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Invalid hidden DeepScan URL');
            frameOrigin = url.origin;
        } catch {
            void sendHiddenDeepScanEvent({
                action: 'complete',
                scanId: message.scanId,
                status: 'failed'
            });
            return;
        }

        const parent = document.body ?? document.documentElement;
        if (!parent) {
            void sendHiddenDeepScanEvent({
                action: 'complete',
                scanId: message.scanId,
                status: 'failed'
            });
            return;
        }

        const wrapper = document.createElement('div');
        const frame = document.createElement('iframe');
        const scan = {
            scanId: message.scanId,
            token: message.token,
            frameOrigin,
            ignoreHiddenImages: message.ignoreHiddenImages === true,
            minimumImageWidth: message.minimumImageWidth,
            minimumImageHeight: message.minimumImageHeight,
            wrapper,
            frame,
            finished: false,
            cancelled: false,
            ready: false,
            started: false,
            frameLoadCount: 0,
            loadGraceUsed: false,
            handshakeTimeout: null,
            handshakeInterval: null,
            onMessage: null,
            onFrameLoad: null,
            eventQueue: Promise.resolve(),
            visibleContainerMarker: null
        };
        wrapper.setAttribute('aria-hidden', 'true');
        wrapper.style.cssText = [
            'position:fixed!important',
            'display:block!important',
            'left:0!important',
            'top:0!important',
            'width:1280px!important',
            'height:800px!important',
            'overflow:hidden!important',
            'opacity:0!important',
            'pointer-events:none!important',
            'border:0!important',
            'margin:0!important',
            'padding:0!important'
        ].join(';');
        frame.setAttribute('aria-hidden', 'true');
        frame.tabIndex = -1;
        frame.loading = 'eager';
        frame.width = '1280';
        frame.height = '800';
        frame.style.cssText = [
            'display:block!important',
            'width:1280px!important',
            'height:800px!important',
            'border:0!important',
            'margin:0!important',
            'padding:0!important',
            'pointer-events:none!important'
        ].join(';');
        scan.onMessage = (event) => {
            if (event.source !== frame.contentWindow || event.origin !== scan.frameOrigin) return;

            const data = event.data;
            if (data?.target !== HIDDEN_DEEP_SCAN_FRAME_TARGET ||
                data.scanId !== scan.scanId || data.token !== scan.token) {
                return;
            }
            if (data.action === 'ready') {
                if (scan.ready || scan.finished) return;

                scan.ready = true;
                clearTimeout(scan.handshakeTimeout);
                clearInterval(scan.handshakeInterval);
                scan.started = true;
                sendHiddenDeepScanStart(scan);
                return;
            }
            if (scan.finished) return;
            if (data.action === 'active-container') {
                if (data.container) {
                    setVisibleContainerMarker(scan, data.container, data.colorIndex);
                }
                else clearVisibleContainerMarker(scan);
                return;
            }
            if (data.action === 'hidden-state' && typeof data.phase === 'string' && data.state) {
                void queueHiddenDeepScanEvent(scan, {
                    action: 'hidden-state',
                    scanId: scan.scanId,
                    phase: data.phase,
                    state: data.state
                });
                return;
            }
            if (data.action === 'hidden-error' && typeof data.kind === 'string') {
                void queueHiddenDeepScanEvent(scan, {
                    action: 'hidden-error',
                    scanId: scan.scanId,
                    kind: data.kind,
                    message: getDiagnosticErrorMessage(data.message)
                });
                return;
            }
            if (data.action === 'batch' && Array.isArray(data.candidates)) {
                void queueHiddenDeepScanEvent(scan, {
                    action: 'batch',
                    scanId: scan.scanId,
                    candidates: data.candidates,
                    ...(data.diagnostic ? {diagnostic: data.diagnostic} : {})
                });
                return;
            }
            if (data.action === 'complete') {
                console.info(
                    '[DeepScan COMPLETE TRACE] frame-forward',
                    `scanId=${scan.scanId}`,
                    `status=${data.status}`,
                    'hostQueue=scheduled'
                );
                void finishHiddenDeepScanHost(
                    scan,
                    data.status,
                    data.reason,
                    data.endReason
                );
            }
        };
        scan.onFrameLoad = () => {
            scan.frameLoadCount += 1;
            sendHiddenDeepScanInitialization(scan);
        };

        window.addEventListener('message', scan.onMessage);
        frame.addEventListener('load', scan.onFrameLoad);
        frame.src = message.url;
        wrapper.append(frame);
        parent.append(wrapper);
        activeHiddenDeepScanHost = scan;
        scan.handshakeInterval = setInterval(() => {
            sendHiddenDeepScanInitialization(scan);
        }, 200);
        scan.handshakeTimeout = setTimeout(() => {
            handleHiddenDeepScanHandshakeTimeout(scan);
        }, HIDDEN_DEEP_SCAN_HANDSHAKE_TIMEOUT_MS);
    };
    const isTrustedHostMessage = (event) => event.source === window.parent &&
        event.origin === extensionOrigin &&
        event.data?.target === FRAME_MESSAGE_TARGET &&
        typeof event.data.scanId === 'string' &&
        typeof event.data.token === 'string';
    const isTrustedHiddenDeepScanMessage = (event) => event.source === window.parent &&
        event.origin === window.location.origin &&
        event.data?.target === HIDDEN_DEEP_SCAN_FRAME_TARGET &&
        typeof event.data.scanId === 'string' &&
        typeof event.data.token === 'string';
    const complete = (scan, status, reason = null) => {
        if (!scan || scan.completed) return;

        scan.completed = true;
        sendToHost({
            action: 'complete',
            scanId: scan.scanId,
            token: scan.token,
            status,
            ...(typeof reason === 'string' && reason ? {reason} : {})
        });
        if (activeScan === scan) activeScan = null;
    };
    const start = async (message) => {
        if (activeScan?.scanId === message.scanId && activeScan.token === message.token) {
            sendReady(activeScan);
            return;
        }
        if (activeScan) activeScan.controller.abort();

        const scan = {
            scanId: message.scanId,
            token: message.token,
            controller: new AbortController(),
            completed: false
        };
        activeScan = scan;
        sendReady(scan);

        try {
            const {runIsolatedDeepScan} = await import(chrome.runtime.getURL('src/content.js'));
            const result = await runIsolatedDeepScan({
                ignoreHiddenImages: message.ignoreHiddenImages === true,
                signal: scan.controller.signal,
                onBatch: async (candidates) => {
                    if (activeScan !== scan || scan.controller.signal.aborted) return;

                    sendToHost({
                        action: 'batch',
                        scanId: scan.scanId,
                        token: scan.token,
                        candidates
                    });
                }
            });
            complete(scan, result.status);
        } catch (error) {
            complete(scan, 'failed', error instanceof Error ? error.message : String(error));
        }
    };

    window.addEventListener('message', (event) => {
        if (isTrustedHiddenDeepScanMessage(event)) {
            const message = event.data;
            if (message.action === 'initialize') {
                initializeHiddenDeepScanFrame(message, event.origin);
            } else if (message.action === 'start') {
                void startHiddenDeepScanFrame(message);
            } else if (message.action === 'cancel' && activeHiddenDeepScanFrame?.scanId === message.scanId &&
                activeHiddenDeepScanFrame.token === message.token) {
                activeHiddenDeepScanFrame.controller.abort();
            }
            return;
        }
        if (!isTrustedHostMessage(event)) return;

        const message = event.data;
        if (message.action === 'cancel') {
            if (activeScan?.scanId === message.scanId && activeScan.token === message.token) {
                activeScan.controller.abort();
            }
            return;
        }
        if (message.action === 'start' && typeof message.url === 'string') {
            void start(message);
        }
    });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message?.target !== HIDDEN_DEEP_SCAN_TARGET || message.source !== 'background' ||
            window.top !== window) {
            return undefined;
        }
        if (message.action === 'start' && typeof message.scanId === 'string' &&
            typeof message.token === 'string' && typeof message.url === 'string') {
            startHiddenDeepScanHost(message);
            sendResponse({success: true});
            return undefined;
        }
        if (message.action === 'probe' && typeof message.scanId === 'string' &&
            typeof message.token === 'string') {
            sendResponse({success: true});
            return undefined;
        }
        if (message.action === 'cancel' && activeHiddenDeepScanHost?.scanId === message.scanId) {
            finishHiddenDeepScanHost(activeHiddenDeepScanHost, 'cancelled');
            sendResponse({success: true});
            return undefined;
        }
        sendResponse({success: false});
        return undefined;
    });
})();
