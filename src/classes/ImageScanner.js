import { scanImages } from '../content.js';

const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';

function getPixelCount(candidate) {
    const width = Number(candidate?.width);
    const height = Number(candidate?.height);

    return Number.isFinite(width) && Number.isFinite(height)
        ? Math.max(0, width) * Math.max(0, height)
        : 0;
}

export default class ImageScanner {
    #activeDeepScan = null;
    #deepScanClientId = null;
    #deepScanDebugContext = null;

    get isDeepScanRunning() {
        return this.#activeDeepScan !== null;
    }

    constructor(settings, mediaProvider) {
        this.settings = settings;
        this.mediaProvider = mediaProvider;
        this.currentTab = null;
    }

    setDeepScanClientId(clientId) {
        this.#deepScanClientId = typeof clientId === 'string' && clientId
            ? clientId
            : null;
    }

    async scan({onStart = null, onProgress = null, signal = null} = {}) {
        if (signal?.aborted) return [];

        this.currentTab = null;
        this.mediaProvider.reset();
        const [tab] = await window.chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        if (signal?.aborted || !Number.isInteger(tab?.id)) return [];
        this.currentTab = tab ?? null;

        const result = await window.chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: scanImages
        });
        if (signal?.aborted) return [];
        const filesFound = result[0]?.result ?? [];

        const candidates = await this.mediaProvider.prepareCandidates(filesFound, tab.id, {
            onStart,
            onProgress,
            signal
        });
        return candidates;
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        const session = this.#activeDeepScan;
        if (!session) return false;

        const normalizedEndReason = ['user-abort', 'popup-closed', 'settings-open', 'tab-reload']
            .includes(endReason)
            ? endReason
            : 'cancelled';
        session.cancelled = true;
        session.controller.abort();
        session.finish({status: 'cancelled', endReason: normalizedEndReason});
        try {
            await window.chrome.runtime.sendMessage({
                target: ISOLATED_DEEP_SCAN_TARGET,
                action: 'cancel',
                scanId: session.scanId,
                endReason: normalizedEndReason
            });
        } catch {
            // The background may already have discarded the isolated host.
        }

        return true;
    }

    // ✴️ NEW 2026-10-11: Closes DeepScan debug collection after the final popup result log.
    /**
     * Flushes the popup debug context after the caller logged the final DeepScan result.
     * @returns {Promise<void>}
     */
    async completeDeepScanDebugContext() {
        const context = this.#deepScanDebugContext;
        if (!context) return;

        this.#deepScanDebugContext = null;
        const {logger, scanId} = context;
        try {
            await logger?.flush?.();
        } finally {
            logger?.clearContext(scanId);
            try {
                await window.chrome.runtime.sendMessage({
                    target: 'image-finder-debug-log',
                    action: 'context-complete',
                    source: 'popup',
                    scanId
                });
            } catch {
                // The fallback export covers a closed popup.
            }
        }
    }

    async scanDeepImages(scanContext, onCandidates = null) {
        if (!scanContext?.isScannable || !Number.isInteger(scanContext.tabId)) {
            return [];
        }

        const debugSettings = this.settings.get('debug') ?? {};
        const shouldMeasurePopupPipeline = debugSettings.debugmode === true &&
            debugSettings.logpopup === true;
        const imageFilter = this.mediaProvider.filter;
        const allowProtectedDeepScan = this.settings.get(
            'common',
            'allowProtectedDeepScan',
            false
        ) === true;
        const candidatesByURL = new Map();
        await this.cancelDeepScan();

        const scanId = crypto.randomUUID();
        const debugLogger = globalThis.imageFinderDebugLogger;
        this.#deepScanDebugContext = {logger: debugLogger, scanId};
        debugLogger?.setContext({scanId, url: scanContext.url});
        const transportMetrics = {
            batches: 0,
            timestampedBatches: 0,
            hiddenToBackgroundMs: 0,
            backgroundQueueMs: 0,
            backgroundToPopupMs: 0,
            popupQueueMs: 0,
            popupPipelineMs: 0,
            endToEndMs: 0
        };
        // ✴️ NEW 2026-10-11: Aggregates the popup-only DeepScan phases that follow hidden scanning.
        const popupPipelineDetail = {
            batches: 0,
            rawCandidates: 0,
            newURLCandidates: 0,
            preparedCandidates: 0,
            candidateSelectionMs: 0,
            candidatePreparationMs: 0,
            fileInfoRequests: 0,
            fileInfoFailures: 0,
            fileInfoMs: 0,
            dimensionRequests: 0,
            dimensionCacheHits: 0,
            dimensionFailures: 0,
            dimensionMs: 0,
            candidateStoreMs: 0,
            analyzerMs: 0,
            visibleResultStoreMs: 0,
            listReconciliationMs: 0,
            listSortMs: 0,
            postListUiMs: 0,
            totalMs: 0,
            maxCandidatePreparationMs: 0,
            maxAnalyzerMs: 0,
            maxListReconciliationMs: 0,
            maxTotalMs: 0
        };

        const addTransportDuration = (name, value) => {
            if (!Number.isFinite(value)) return;
            transportMetrics[name] = (transportMetrics[name] ?? 0) + Math.max(0, value);
        };

        const recordTransportBatch = (diagnostic, popupReceivedAt, popupProcessingStartedAt, popupProcessingFinishedAt ) => {
            transportMetrics.batches += 1;
            addTransportDuration(
                'popupQueueMs',
                popupProcessingStartedAt - popupReceivedAt
            );
            addTransportDuration(
                'popupPipelineMs',
                popupProcessingFinishedAt - popupProcessingStartedAt
            );

            const emittedAt = Number(diagnostic?.emittedAt);
            const backgroundReceivedAt = Number(diagnostic?.backgroundReceivedAt);
            const backgroundSentAt = Number(diagnostic?.backgroundSentAt);
            if (![emittedAt, backgroundReceivedAt, backgroundSentAt].every(Number.isFinite)) {
                return;
            }

            transportMetrics.timestampedBatches += 1;
            addTransportDuration('hiddenToBackgroundMs', backgroundReceivedAt - emittedAt);
            addTransportDuration('backgroundQueueMs', backgroundSentAt - backgroundReceivedAt);
            addTransportDuration('backgroundToPopupMs', popupReceivedAt - backgroundSentAt);
            addTransportDuration('endToEndMs', popupProcessingFinishedAt - emittedAt);
        };
        const createTransportSummary = (completionResult) => ({
            hidden: completionResult?.performance ?? null,
            popupTransport: Object.fromEntries(Object.entries(transportMetrics).map(([name, value]) => [
                name,
                Number.isFinite(value) ? Math.round(value) : value
            ])),
            popupPipelineDetail: Object.fromEntries(Object.entries(popupPipelineDetail).map(([name, value]) => [
                name,
                Number.isFinite(value) ? Math.round(value) : value
            ])),
            note: 'Transport timings are wall-clock batch latencies; the hidden summary contains the non-overlapping DeepScan phase percentages.'
        });
        const recordPopupPipelineDetail = (metrics) => {
            if (!metrics || typeof metrics !== 'object') return;

            const summedMetrics = [
                'rawCandidates',
                'newURLCandidates',
                'preparedCandidates',
                'candidateSelectionMs',
                'candidatePreparationMs',
                'fileInfoRequests',
                'fileInfoFailures',
                'fileInfoMs',
                'dimensionRequests',
                'dimensionCacheHits',
                'dimensionFailures',
                'dimensionMs',
                'candidateStoreMs',
                'analyzerMs',
                'visibleResultStoreMs',
                'listReconciliationMs',
                'listSortMs',
                'postListUiMs',
                'totalMs'
            ];

            popupPipelineDetail.batches += 1;
            summedMetrics.forEach((name) => {
                if (Number.isFinite(metrics[name])) popupPipelineDetail[name] += metrics[name];
            });
            popupPipelineDetail.maxCandidatePreparationMs = Math.max(
                popupPipelineDetail.maxCandidatePreparationMs,
                metrics.candidatePreparationMs ?? 0
            );
            popupPipelineDetail.maxAnalyzerMs = Math.max(
                popupPipelineDetail.maxAnalyzerMs,
                metrics.analyzerMs ?? 0
            );
            popupPipelineDetail.maxListReconciliationMs = Math.max(
                popupPipelineDetail.maxListReconciliationMs,
                metrics.listReconciliationMs ?? 0
            );
            popupPipelineDetail.maxTotalMs = Math.max(
                popupPipelineDetail.maxTotalMs,
                metrics.totalMs ?? 0
            );
            console.info('[DeepScan Popup Pipeline]', metrics);
        };
        let batchQueue = Promise.resolve();
        let resolveCompletion = null;
        let completionResult = null;

        const completion = new Promise((resolve) => {resolveCompletion = resolve;});

        const session = {
            scanId,
            controller: new AbortController(),
            cancelled: false,
            finished: false,
            finish: (result) => {
                if (session.finished) return;

                session.finished = true;
                window.chrome.runtime.onMessage.removeListener(onMessage);
                if (this.#activeDeepScan === session) this.#activeDeepScan = null;
                resolveCompletion(result);
            }
        };

        const processCandidates = async (
            foundCandidates,
            diagnostic = null,
            popupReceivedAt = Date.now()
        ) => {
            if (session.cancelled || session.controller.signal.aborted) return;

            const popupProcessingStartedAt = Date.now();
            const pipelineStartedAt = performance.now();
            try {
                const newCandidates = [];
                for (const candidate of foundCandidates ?? []) {
                    if (typeof candidate?.url !== 'string') continue;

                    const existingCandidate = candidatesByURL.get(candidate.url);
                    if (existingCandidate && getPixelCount(candidate) <= getPixelCount(existingCandidate)) {
                        continue;
                    }

                    candidatesByURL.set(candidate.url, candidate);
                    newCandidates.push(candidate);
                }
                if (newCandidates.length === 0 || typeof onCandidates !== 'function') {
                    return;
                }

                const result = await onCandidates(
                    newCandidates,
                    session.controller.signal,
                    diagnostic,
                    shouldMeasurePopupPipeline
                );
                recordPopupPipelineDetail(result?.popupPipeline);

                if ((result === false || result?.continue === false) ||
                    session.cancelled || session.controller.signal.aborted) {
                    session.cancelled = true;
                    session.controller.abort();
                    session.finish({status: 'cancelled'});
                    void window.chrome.runtime.sendMessage({
                        target: ISOLATED_DEEP_SCAN_TARGET,
                        action: 'cancel',
                        scanId
                    }).catch(() => undefined);
                }
            } finally {
                recordTransportBatch(
                    diagnostic,
                    popupReceivedAt,
                    popupProcessingStartedAt,
                    Date.now()
                );
            }
        };

        const onMessage = (message, _sender, sendResponse) => {
            if (message?.target !== ISOLATED_DEEP_SCAN_TARGET || message.source !== 'background') return;
            if (message.scanId !== scanId) return;
            if (message.popupClientId && message.popupClientId !== this.#deepScanClientId) return;

            if (message.action === 'batch' && Array.isArray(message.candidates)) {
                const popupReceivedAt = Date.now();
                batchQueue = batchQueue.then(() => processCandidates(
                    message.candidates,
                    message.diagnostic ?? null,
                    popupReceivedAt
                )).catch(() => {
                    session.cancelled = true;
                    session.controller.abort();
                    session.finish({status: 'failed'});
                    void window.chrome.runtime.sendMessage({
                        target: ISOLATED_DEEP_SCAN_TARGET,
                        action: 'cancel',
                        scanId
                    }).catch(() => undefined);
                });
                return;
            }

            if (message.action === 'complete') {
                sendResponse?.({success: true, scanId, clientId: this.#deepScanClientId ?? null});
                void batchQueue.then(() => {
                    session.finish(message);
                });
            }
        };

        this.#activeDeepScan = session;
        window.chrome.runtime.onMessage.addListener(onMessage);

        try {
            if (!session.cancelled) {
                const response = await window.chrome.runtime.sendMessage({
                    target: ISOLATED_DEEP_SCAN_TARGET,
                    action: 'start',
                    scanId,
                    url: scanContext.url,
                    tabId: scanContext.tabId,
                    minimumImageWidth: imageFilter.minWidth,
                    minimumImageHeight: imageFilter.minHeight,
                    allowProtectedDeepScan,
                    debugSettings: {
                        debugmode: debugSettings.debugmode === true,
                        logtab: debugSettings.logtab === true,
                        logpopup: debugSettings.logpopup === true,
                        logserviceworker: debugSettings.logserviceworker === true
                    },
                    ...(this.#deepScanClientId ? {popupClientId: this.#deepScanClientId} : {})
                });
                if (response?.success !== true) {
                    session.finish({status: 'failed'});
                }

                completionResult = await completion;
            }
        } catch {
            session.finish({status: 'failed'});
        } finally {
            session.finish({status: 'finished'});
            console.info('[DeepScan Performance]', createTransportSummary(completionResult));
            // ✏️ EDIT 2026-10-11: Keep the context until ImageFinder logged DeepScan RESULT.
        }

        return Array.from(candidatesByURL.values());
    }

}
