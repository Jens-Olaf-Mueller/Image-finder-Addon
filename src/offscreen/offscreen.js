import Analyzer from './classes/Analyzer.js';

const OFFSCREEN_TARGET = 'image-finder-offscreen';
const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';
const OFFSCREEN_ANALYZER_EVENT_TARGET = 'image-finder-offscreen-analyzer-event';

const objectUrlsByToken = new Map();
const tokensByDownloadId = new Map();
const mediaZipBlobChunksByTransferId = new Map();
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

// ✴️ NEW 2026-10-15: Restores one bounded, tab-local Blob transfer for the current ZIP entry.
function takeMediaZipBlobBytes(transferId) {
    const chunks = mediaZipBlobChunksByTransferId.get(transferId);
    if (!chunks) throw new Error('The page Blob ZIP transfer is unavailable');

    mediaZipBlobChunksByTransferId.delete(transferId);
    const parts = chunks.map(chunk => Uint8Array.from(atob(chunk), char => char.charCodeAt(0)));
    const byteLength = parts.reduce((total, part) => total + part.byteLength, 0);
    const bytes = new Uint8Array(byteLength);
    let offset = 0;

    for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
    }

    return bytes.buffer;
}

// ✴️ NEW 2026-10-15: Requests one page-local Blob through the bounded source-tab transfer.
async function resolvePageBlobZipBytes(media, jobId) {
    const transferId = crypto.randomUUID();

    try {
        const response = await window.chrome.runtime.sendMessage({
            target: OFFSCREEN_TARGET,
            source: 'offscreen',
            action: 'resolveMediaZipBlob',
            jobId,
            tabId: media.tabId,
            blobUrl: media.url,
            transferId
        });
        if (response?.success !== true) {
            throw new Error(response?.error || 'Cannot resolve the page Blob for ZIP creation');
        }

        return takeMediaZipBlobBytes(transferId);
    } finally {
        mediaZipBlobChunksByTransferId.delete(transferId);
    }
}

// ✏️ EDIT 2026-10-15: Resolves page-local Blob images through the bounded source-tab transfer.
async function resolveMediaZipBytes(media, jobId) {
    if (!media || typeof media.url !== 'string' || !media.url.trim()) {
        throw new Error('The ZIP media URL is invalid');
    }

    const source = media.source;
    if (source === 'dataimages') {
        return (await dataUrlToBlob(media.url)).arrayBuffer();
    }
    if (source === 'blobimages') {
        return resolvePageBlobZipBytes(media, jobId);
    }

    // ✴️ NEW 2026-10-15: Fetches protected media with the browser credentials available to the extension.
    const response = await fetch(media.url, {credentials: 'include'});
    if (!response.ok) throw new Error(`Cannot fetch media for ZIP: ${response.status}`);

    return response.arrayBuffer();
}

// ✴️ NEW 2026-10-15: Keeps duplicate ZIP entries while giving each archive name a unique suffix.
function getUniqueZipFileName(fileName, usedNames) {
    const baseName = String(fileName ?? '')
        .trim()
        .split(/[\\/]/)
        .pop();
    if (!baseName) throw new Error('The ZIP media file name is invalid');

    const extensionIndex = baseName.lastIndexOf('.');
    const stem = extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName;
    const extension = extensionIndex > 0 ? baseName.slice(extensionIndex) : '';

    let number = 1;
    let candidate = baseName;
    while (usedNames.has(candidate)) {
        number += 1;
        candidate = `${stem} (${number})${extension}`;
    }

    usedNames.add(candidate);
    return candidate;
}

// ✴️ NEW 2026-10-15: Reports compact ZIP preparation updates without transferring archive data.
function emitZipProgress(jobId, progress) {
    if (typeof jobId !== 'string' || !jobId) return;

    void window.chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        source: 'offscreen',
        action: 'zipProgress',
        jobId,
        progress
    }).catch(() => undefined);
}

// ✏️ EDIT 2026-10-15: Creates a ZIP Blob URL locally while reporting throttled preparation progress.
async function createMediaZip(media, jobId) {
    if (typeof JSZip !== 'function') {
        throw new Error('JSZip is not available in the offscreen document');
    }

    const zip = new JSZip();
    const results = [];
    const usedNames = new Set();
    const progressStep = Math.max(1, Math.ceil(media.length / 100));
    let failed = 0;

    for (let i = 0; i < media.length; i++) {
        const item = media[i];
        try {
            const data = await resolveMediaZipBytes(item, jobId);
            const fileName = getUniqueZipFileName(item?.fileName, usedNames);
            zip.file(fileName, data);
            results.push({
                imageId: item?.imageId,
                url: item?.url,
                success: true
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.warn('Cannot add media to ZIP:', item?.url, error);
            failed += 1;
            results.push({
                imageId: item?.imageId,
                url: item?.url,
                success: false,
                error: message
            });
        }

        const completed = i + 1;
        if (completed === 1 || completed === media.length || completed % progressStep === 0) {
            emitZipProgress(jobId, {
                state: 'preparing',
                percent: completed * 100 / media.length,
                completed,
                failed
            });
        }
    }

    const successfulResults = results.filter(item => item.success);
    if (successfulResults.length === 0) {
        throw new Error('Cannot create ZIP: no media could be resolved');
    }

    let lastCompressionPercent = -1;
    emitZipProgress(jobId, {
        state: 'compressing',
        percent: 0,
        completed: media.length,
        failed
    });
    const zipBlob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/zip'
    }, (metadata) => {
        const percent = Math.min(100, Math.max(0, Number(metadata?.percent) || 0));
        const roundedPercent = Math.round(percent);
        if (roundedPercent === lastCompressionPercent) return;

        lastCompressionPercent = roundedPercent;
        emitZipProgress(jobId, {
            state: 'compressing',
            percent: roundedPercent,
            completed: media.length,
            failed
        });
    });
    const token = crypto.randomUUID();
    const objectUrl = URL.createObjectURL(zipBlob);
    objectUrlsByToken.set(token, objectUrl);

    return {token, objectUrl, results};
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
    if (message?.source === 'offscreen') return undefined;
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

    if (message.action === 'startMediaZipBlobTransfer') {
        const transferId = message.transferId;
        const byteLength = Number(message.byteLength);
        if (typeof transferId !== 'string' || !transferId ||
            !Number.isFinite(byteLength) || byteLength < 0 ||
            mediaZipBlobChunksByTransferId.has(transferId)) {
            sendResponse({success: false, error: 'The ZIP Blob transfer is invalid'});
            return undefined;
        }

        mediaZipBlobChunksByTransferId.set(transferId, []);
        sendResponse({success: true});
        return undefined;
    }

    if (message.action === 'storeMediaZipBlobChunk') {
        const transferId = message.transferId;
        const index = message.index;
        const data = message.data;
        const chunks = mediaZipBlobChunksByTransferId.get(transferId);
        if (!chunks || !Number.isInteger(index) || index !== chunks.length ||
            typeof data !== 'string' || !data) {
            sendResponse({success: false, error: 'The ZIP Blob fragment is invalid'});
            return undefined;
        }

        chunks.push(data);
        sendResponse({success: true});
        return undefined;
    }

    if (message.action === 'createMediaZip') {
        if (!Array.isArray(message.media) || message.media.length === 0) {
            sendResponse({success: false, error: 'The ZIP media list is invalid'});
            return undefined;
        }

        createMediaZip(message.media, message.jobId).then(
            (result) => sendResponse({success: true, ...result}),
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

    if (message.action === 'removeAnalyzerCandidates') {
        const {sessionId, analysisGeneration, candidateIds} = message;
        if (!Array.isArray(candidateIds)) {
            sendResponse({success: false, error: 'The analyzer removal request is invalid'});
            return undefined;
        }

        const analyzer = getAnalyzer(sessionId, analysisGeneration);
        const removedCount = analyzer.removeCandidates(candidateIds);
        sendResponse({success: true, removedCount});
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
