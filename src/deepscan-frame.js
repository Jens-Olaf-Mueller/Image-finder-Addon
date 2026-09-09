(() => {
    const FRAME_MESSAGE_TARGET = 'image-finder-isolated-deepscan-frame';
    const HIDDEN_DEEP_SCAN_TARGET = 'image-finder-hidden-deepscan';
    const HIDDEN_DEEP_SCAN_FRAME_TARGET = 'image-finder-hidden-deepscan-frame';
    const HIDDEN_DEEP_SCAN_HANDSHAKE_TIMEOUT_MS = 10000;
    const HIDDEN_DEEP_SCAN_LOAD_GRACE_MS = 15000;
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
    const sendHiddenDeepScanEvent = (message) => chrome.runtime.sendMessage({
        target: HIDDEN_DEEP_SCAN_TARGET,
        source: 'hidden-deepscan-host',
        ...message
    }).catch(() => undefined);
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
        sendHiddenDeepScanFrameMessage(scan, {
            action: 'complete',
            status,
            ...(typeof reason === 'string' && reason ? {reason} : {}),
            ...(typeof endReason === 'string' && endReason ? {endReason} : {})
        });
        if (activeHiddenDeepScanFrame === scan) activeHiddenDeepScanFrame = null;
    };
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
            completed: false
        };
        activeHiddenDeepScanFrame = scan;
        sendHiddenDeepScanFrameMessage(scan, {action: 'ready'});
    };
    const startHiddenDeepScanFrame = async (message) => {
        const scan = activeHiddenDeepScanFrame;
        if (!scan || scan.scanId !== message.scanId || scan.token !== message.token || scan.started) {
            return;
        }

        scan.started = true;

        try {
            const {runHiddenFrameDeepScan} = await import(chrome.runtime.getURL('src/content.js'));
            const result = await runHiddenFrameDeepScan({
                ignoreHiddenImages: message.ignoreHiddenImages === true,
                signal: scan.controller.signal,
                totalLimitMs: Number.isFinite(message.totalLimitMs) ? message.totalLimitMs : 90000,
                onBatch: async (candidates) => {
                    if (activeHiddenDeepScanFrame !== scan || scan.controller.signal.aborted) return;

                    sendHiddenDeepScanFrameMessage(scan, {action: 'batch', candidates});
                }
            });
            completeHiddenDeepScanFrame(scan, result.status, null, result.endReason);
        } catch (error) {
            completeHiddenDeepScanFrame(
                scan,
                'failed',
                error instanceof Error ? error.message : String(error)
            );
        }
    };
    const clearHiddenDeepScanHost = (scan) => {
        if (!scan) return;

        clearTimeout(scan.handshakeTimeout);
        clearInterval(scan.handshakeInterval);
        window.removeEventListener('message', scan.onMessage);
        scan.frame.removeEventListener('load', scan.onFrameLoad);
        scan.wrapper.remove();
        if (activeHiddenDeepScanHost === scan) activeHiddenDeepScanHost = null;
    };
    const queueHiddenDeepScanEvent = (scan, message) => {
        scan.eventQueue = scan.eventQueue.then(() => sendHiddenDeepScanEvent(message)).catch(() => undefined);
        return scan.eventQueue;
    };
    const finishHiddenDeepScanHost = (scan, status, reason = null) => {
        if (!scan || scan.finished) return;

        scan.finished = true;
        clearHiddenDeepScanHost(scan);
        void queueHiddenDeepScanEvent(scan, {
            action: 'complete',
            scanId: scan.scanId,
            status,
            ...(typeof reason === 'string' && reason ? {reason} : {})
        });
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

        finishHiddenDeepScanHost(scan, 'unavailable', getHiddenDeepScanHandshakeTimeoutReason(scan));
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
                totalLimitMs: scan.totalLimitMs
            }, scan.frameOrigin);
        } catch {
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
            totalLimitMs: Number.isFinite(message.totalLimitMs) ? message.totalLimitMs : 90000,
            wrapper,
            frame,
            finished: false,
            ready: false,
            started: false,
            frameLoadCount: 0,
            loadGraceUsed: false,
            handshakeTimeout: null,
            handshakeInterval: null,
            onMessage: null,
            onFrameLoad: null,
            eventQueue: Promise.resolve()
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
            if (data.action === 'batch' && Array.isArray(data.candidates)) {
                void queueHiddenDeepScanEvent(scan, {
                    action: 'batch',
                    scanId: scan.scanId,
                    candidates: data.candidates
                });
                return;
            }
            if (data.action === 'complete') {
                scan.finished = true;
                clearHiddenDeepScanHost(scan);
                void queueHiddenDeepScanEvent(scan, {
                    action: 'complete',
                    scanId: scan.scanId,
                    status: data.status,
                    ...(typeof data.reason === 'string' && data.reason ? {reason: data.reason} : {}),
                    ...(typeof data.endReason === 'string' && data.endReason
                        ? {endReason: data.endReason}
                        : {})
                });
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
                totalLimitMs: Number.isFinite(message.totalLimitMs) ? message.totalLimitMs : 30000,
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
