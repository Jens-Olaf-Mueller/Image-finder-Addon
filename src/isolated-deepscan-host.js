(() => {
    const FRAME_MESSAGE_TARGET = 'image-finder-isolated-deepscan-frame';
    const FRAME_HANDSHAKE_TIMEOUT_MS = 10000;
    const DEEP_SCAN_TOTAL_LIMIT_MS = 30000;
    const DEEP_SCAN_FRAME_VIEWPORT_WIDTH_PX = 1280;
    const DEEP_SCAN_FRAME_VIEWPORT_HEIGHT_PX = 800;

    const getErrorMessage = (error) => error instanceof Error ? error.message : String(error);

    async function getFrameContainer() {
        if (typeof document === 'undefined') {
            throw new Error('A document context is required for isolated DeepScan');
        }
        if (document.body) return document.body;

        await new Promise((resolve) => {
            document.addEventListener('DOMContentLoaded', resolve, {once: true});
        });
        if (!document.body) throw new Error('The isolated DeepScan host has no document body');

        return document.body;
    }

    function prepareFrameHost(container) {
        const width = `${DEEP_SCAN_FRAME_VIEWPORT_WIDTH_PX}px`;
        const height = `${DEEP_SCAN_FRAME_VIEWPORT_HEIGHT_PX}px`;
        const root = document.documentElement;

        [root, container].forEach((element) => {
            element.style.margin = '0';
            element.style.padding = '0';
            element.style.width = width;
            element.style.height = height;
            element.style.minWidth = width;
            element.style.minHeight = height;
            element.style.overflow = 'hidden';
        });
        container.style.position = 'relative';
    }

    function createIsolatedDeepScanHost({emit = null} = {}) {
        let activeJob = null;

        const emitEvent = (event) => {
            if (typeof emit !== 'function') return;

            Promise.resolve(emit(event)).catch(() => undefined);
        };
        const sendToFrame = (job, action) => {
            try {
                job.frame.contentWindow?.postMessage({
                    target: FRAME_MESSAGE_TARGET,
                    action,
                    scanId: job.scanId,
                    token: job.token,
                    url: job.url,
                    ignoreHiddenImages: job.ignoreHiddenImages === true,
                    totalLimitMs: job.totalLimitMs
                }, job.frameOrigin);
            } catch {
                // The handshake timeout reports a frame that cannot be reached.
            }
        };
        const clearJobTimers = (job) => {
            clearTimeout(job.handshakeTimeout);
            clearTimeout(job.totalTimeout);
            clearInterval(job.handshakeInterval);
        };
        const cleanup = (job) => {
            clearJobTimers(job);
            window.removeEventListener('message', job.onMessage);
            job.frame.removeEventListener('load', job.onFrameLoad);
            job.frame.remove();
            if (activeJob === job) activeJob = null;
        };
        const emitCompletion = (job, status, reason = null) => {
            emitEvent({
                action: 'complete',
                scanId: job.scanId,
                url: job.url,
                status,
                ...(typeof reason === 'string' && reason ? {reason} : {})
            });
        };
        const finish = (job, {status = 'completed', reason = null} = {}) => {
            if (!job || job.finished) return;
            job.finished = true;
            cleanup(job);
            emitCompletion(job, status, reason);
        };
        const cancel = async (scanId = null) => {
            const job = activeJob;
            if (!job || (scanId && job.scanId !== scanId)) return false;

            sendToFrame(job, 'cancel');
            finish(job, {status: 'cancelled'});
            return true;
        };
        const start = async (jobInput) => {
            await cancel();

            if (typeof jobInput?.scanId !== 'string' || !jobInput.scanId ||
                typeof jobInput?.token !== 'string' || !jobInput.token ||
                typeof jobInput?.url !== 'string' || !jobInput.url) {
                throw new Error('The isolated DeepScan job is invalid');
            }

            let frameOrigin;
            try {
                const url = new URL(jobInput.url);
                if (!['http:', 'https:'].includes(url.protocol)) {
                    throw new Error('The isolated DeepScan URL must use HTTP(S)');
                }
                frameOrigin = url.origin;
            } catch (error) {
                throw new Error(`The isolated DeepScan URL is invalid: ${getErrorMessage(error)}`);
            }

            const container = await getFrameContainer();
            prepareFrameHost(container);
            const frame = document.createElement('iframe');
            const totalLimitMs = Number.isFinite(jobInput.totalLimitMs)
                ? Math.max(0, Math.min(DEEP_SCAN_TOTAL_LIMIT_MS, jobInput.totalLimitMs))
                : DEEP_SCAN_TOTAL_LIMIT_MS;
            const job = {
                scanId: jobInput.scanId,
                token: jobInput.token,
                url: jobInput.url,
                frameOrigin,
                ignoreHiddenImages: jobInput.ignoreHiddenImages === true,
                totalLimitMs,
                frame,
                finished: false,
                handshakeTimeout: null,
                handshakeInterval: null,
                totalTimeout: null,
                onMessage: null,
                onFrameLoad: null
            };

            frame.setAttribute('aria-hidden', 'true');
            frame.tabIndex = -1;
            frame.width = String(DEEP_SCAN_FRAME_VIEWPORT_WIDTH_PX);
            frame.height = String(DEEP_SCAN_FRAME_VIEWPORT_HEIGHT_PX);
            frame.style.cssText = [
                'position:absolute',
                'display:block',
                `width:${DEEP_SCAN_FRAME_VIEWPORT_WIDTH_PX}px`,
                `height:${DEEP_SCAN_FRAME_VIEWPORT_HEIGHT_PX}px`,
                'opacity:0',
                'pointer-events:none',
                'border:0',
                'left:0',
                'top:0'
            ].join(';');
            job.onMessage = (event) => {
                if (event.source !== frame.contentWindow || event.origin !== job.frameOrigin) return;

                const data = event.data;
                if (data?.target !== FRAME_MESSAGE_TARGET || data.scanId !== job.scanId ||
                    data.token !== job.token) {
                    return;
                }

                if (data.action === 'ready') {
                    clearTimeout(job.handshakeTimeout);
                    clearInterval(job.handshakeInterval);
                    job.handshakeInterval = null;
                    return;
                }
                if (data.action === 'batch' && Array.isArray(data.candidates) && !job.finished) {
                    emitEvent({
                        action: 'batch',
                        scanId: job.scanId,
                        url: job.url,
                        candidates: data.candidates
                    });
                    return;
                }
                if (data.action === 'complete') {
                    finish(job, {
                        status: data.status,
                        reason: data.reason
                    });
                }
            };
            job.onFrameLoad = () => sendToFrame(job, 'start');

            window.addEventListener('message', job.onMessage);
            frame.addEventListener('load', job.onFrameLoad);
            frame.src = job.url;
            container.append(frame);
            activeJob = job;

            job.handshakeInterval = setInterval(() => sendToFrame(job, 'start'), 200);
            job.handshakeTimeout = setTimeout(() => {
                finish(job, {status: 'unavailable', reason: 'EMBED_BLOCKED_OR_LOAD_FAILED'});
            }, Math.min(FRAME_HANDSHAKE_TIMEOUT_MS, totalLimitMs));
            job.totalTimeout = setTimeout(() => {
                sendToFrame(job, 'cancel');
                finish(job, {status: 'timedOut'});
            }, totalLimitMs);
            sendToFrame(job, 'start');

            return {scanId: job.scanId};
        };

        return {start, cancel};
    }

    globalThis.createIsolatedDeepScanHost = createIsolatedDeepScanHost;
})();
