import Analyzer from './classes/Analyzer.js';

const OFFSCREEN_TARGET = 'image-finder-offscreen';
const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';
const OFFSCREEN_ANALYZER_EVENT_TARGET = 'image-finder-offscreen-analyzer-event';

const objectUrlsByToken = new Map();
const tokensByDownloadId = new Map();
let isolatedDeepScanHost = null;
const analyzersBySession = new Map();

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !/^data:/i.test(dataUrl)) {
        throw new Error('The download data URL is invalid');
    }

    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error('Cannot convert data image to Blob');

    return response.blob();
}

function releaseObjectUrl(token) {
    const objectUrl = objectUrlsByToken.get(token);
    if (!objectUrl) return false;

    objectUrlsByToken.delete(token);
    for (const [downloadId, downloadToken] of tokensByDownloadId) {
        if (downloadToken === token) tokensByDownloadId.delete(downloadId);
    }

    URL.revokeObjectURL(objectUrl);
    return true;
}

function getIsolatedDeepScanHost() {
    if (isolatedDeepScanHost) return isolatedDeepScanHost;
    if (typeof globalThis.createIsolatedDeepScanHost !== 'function') {
        throw new Error('The isolated DeepScan host is unavailable');
    }

    isolatedDeepScanHost = globalThis.createIsolatedDeepScanHost({
        emit: (event) => chrome.runtime.sendMessage({
            target: ISOLATED_DEEP_SCAN_TARGET,
            source: 'isolated-host',
            ...event
        })
    });
    return isolatedDeepScanHost;
}

function getAnalyzer(sessionId, analysisGeneration) {
    if (typeof sessionId !== 'string' || !sessionId || !Number.isInteger(analysisGeneration)) {
        throw new Error('The offscreen analyzer session is invalid');
    }

    const analyzersByGeneration = analyzersBySession.get(sessionId) ?? new Map();
    analyzersBySession.set(sessionId, analyzersByGeneration);
    analyzersByGeneration.forEach((analyzer, generation) => {
        if (generation < analysisGeneration) {
            analyzer.cancel();
            analyzersByGeneration.delete(generation);
        }
    });

    let analyzer = analyzersByGeneration.get(analysisGeneration);
    if (!analyzer) {
        analyzer = new Analyzer();
        analyzersByGeneration.set(analysisGeneration, analyzer);
    }
    return analyzer;
}

function resetAnalyzerSession(sessionId, analysisGeneration) {
    const analyzersByGeneration = analyzersBySession.get(sessionId);
    if (!analyzersByGeneration) return;

    analyzersByGeneration.forEach((analyzer, generation) => {
        if (generation < analysisGeneration) {
            analyzer.cancel();
            analyzersByGeneration.delete(generation);
        }
    });
    if (analyzersByGeneration.size === 0) analyzersBySession.delete(sessionId);
}

function releaseAnalyzerSession(sessionId) {
    const analyzersByGeneration = analyzersBySession.get(sessionId);
    if (!analyzersByGeneration) return false;

    analyzersByGeneration.forEach((analyzer) => analyzer.cancel());
    analyzersBySession.delete(sessionId);
    return true;
}

function createAnalysisEventEmitter({sessionId, requestId}) {
    const deliveries = [];
    const progressByStage = new Map();
    const emit = (event) => {
        const delivery = chrome.runtime.sendMessage({
            target: OFFSCREEN_ANALYZER_EVENT_TARGET,
            sessionId,
            requestId,
            ...event
        }).catch(() => undefined);
        deliveries.push(delivery);
    };

    return {
        emitActivity: (activity, isActive) => emit({
            action: 'activity',
            activity,
            isActive
        }),
        emitProgress: (stage, completed, total) => {
            const step = Math.max(1, Math.ceil(total / 100));
            const previous = progressByStage.get(stage) ?? 0;
            const isFirstUpdate = completed === 1 && previous === 0;
            if (completed < total && !isFirstUpdate && completed - previous < step) return;

            progressByStage.set(stage, completed);
            emit({action: 'progress', stage, completed, total});
        },
        flush: () => Promise.all(deliveries)
    };
}

window.chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== OFFSCREEN_TARGET) return undefined;

    if (message.action === 'createObjectUrl') {
        dataUrlToBlob(message.dataUrl).then(
            (blob) => {
                const token = crypto.randomUUID();
                const objectUrl = URL.createObjectURL(blob);
                objectUrlsByToken.set(token, objectUrl);
                sendResponse({success: true, token, objectUrl});
            },
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message.action === 'associateDownload') {
        const {downloadId, token} = message;
        if (!Number.isInteger(downloadId) || !objectUrlsByToken.has(token)) {
            sendResponse({success: false, error: 'Cannot associate the download with its Blob URL'});
            return undefined;
        }

        tokensByDownloadId.set(downloadId, token);
        sendResponse({success: true});
        return undefined;
    }

    if (message.action === 'releaseObjectUrl') {
        sendResponse({success: true, released: releaseObjectUrl(message.token)});
        return undefined;
    }

    if (message.action === 'releaseObjectUrlForDownload') {
        const token = tokensByDownloadId.get(message.downloadId);
        sendResponse({success: true, released: token ? releaseObjectUrl(token) : false});
        return undefined;
    }

    if (message.action === 'startDeepScan') {
        Promise.resolve(getIsolatedDeepScanHost().start(message.job)).then(
            (result) => sendResponse({success: true, ...result}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message.action === 'cancelDeepScan') {
        Promise.resolve(getIsolatedDeepScanHost().cancel(message.scanId)).then(
            (cancelled) => sendResponse({success: true, cancelled}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message.action === 'resetAnalyzerSession') {
        resetAnalyzerSession(message.sessionId, message.analysisGeneration);
        sendResponse({success: true});
        return undefined;
    }

    if (message.action === 'releaseAnalyzerSession') {
        sendResponse({success: true, released: releaseAnalyzerSession(message.sessionId)});
        return undefined;
    }

    if (message.action === 'analyzeCandidates') {
        const {
            sessionId,
            analysisGeneration,
            requestId,
            candidates,
            filters,
            incremental,
            previousVisibleImageIds
        } = message;
        if (typeof requestId !== 'string' || !requestId || !Array.isArray(candidates)) {
            sendResponse({success: false, error: 'The offscreen analyzer request is invalid'});
            return undefined;
        }

        const emitter = createAnalysisEventEmitter({sessionId, requestId});
        const analyzer = getAnalyzer(sessionId, analysisGeneration);
        Promise.resolve().then(() => analyzer.filterCandidates(candidates, {
            filters: filters ?? {},
            incremental: incremental === true,
            previousVisibleImageIds: new Set(previousVisibleImageIds),
            onActivityChange: emitter.emitActivity,
            onBlurProgress: (completed, total) =>
                emitter.emitProgress('blurScanner', completed, total),
            onDuplicateFinderProgress: (completed, total) =>
                emitter.emitProgress('duplicateFinder', completed, total)
        })).then(
            async (results) => {
                await emitter.flush();
                if (!results) {
                    sendResponse({success: true, results: [], candidateUpdates: [], cancelled: true});
                    return;
                }

                sendResponse({
                    success: true,
                    results: results.map(({candidateEntry, replacesExistingResult}) => ({
                        candidateId: candidateEntry[0],
                        replacesExistingResult
                    })),
                    candidateUpdates: analyzer.getCandidateUpdates(),
                    performanceSummary: analyzer.getPerformanceSummary()
                });
            },
            async (error) => {
                await emitter.flush();
                sendResponse({success: false, error: getErrorMessage(error)});
            }
        );
        return true;
    }

    sendResponse({success: false, error: `Unknown offscreen action "${message.action}"`});
    return undefined;
});
