(() => {
    const FRAME_MESSAGE_TARGET = 'image-finder-isolated-deepscan-frame';
    const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
    let activeScan = null;

    const sendToHost = (message) => {
        window.parent.postMessage({
            target: FRAME_MESSAGE_TARGET,
            ...message
        }, extensionOrigin);
    };
    const sendReady = (scan) => {
        sendToHost({action: 'ready', scanId: scan.scanId, token: scan.token});
    };
    const sendTrace = (scan, message) => {
        sendToHost({
            action: 'trace',
            scanId: scan.scanId,
            token: scan.token,
            message
        });
    };
    const isTrustedHostMessage = (event) => event.source === window.parent &&
        event.origin === extensionOrigin &&
        event.data?.target === FRAME_MESSAGE_TARGET &&
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
        sendTrace(scan, 'frame scan started');

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
})();
