import { abortPhotoSwipeImages, scanImages, scanPhotoSwipeImages } from '../content.js';
import { getImageType } from '../image-types.js';

const DEFAULT_BYTES_PER_PIXEL = 0.1;
const UTF8_ENCODER = new TextEncoder();
const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';

export default class ImageScanner {
    #imageDimensionsByURL = new Map();
    #activeDeepScan = null;
    #deepScanClientId = null;

    get isDeepScanRunning() {
        return this.#activeDeepScan !== null;
    }

    get filter() {
        const fileSize = this.settings.get('filesizes') ?? {};
        const imageTypes = this.settings.get('imagetypes') ?? {};
        const extensions = Object.entries(imageTypes).filter(([_, enabled]) => enabled).map(([ext]) => ext);

        return {
            ignoreSize: fileSize.ignoresizes ?? true,
            minWidth: fileSize.minwidth ?? 200,
            minHeight: fileSize.minheight ?? 200,
            minSize: (fileSize.minimumfilesize ?? 128) * 1024,
            extensions: new Set(extensions)
        };
    }

    constructor(settings) {
        this.settings = settings;
        this.currentTab = null;
    }

    setDeepScanClientId(clientId) {
        this.#deepScanClientId = typeof clientId === 'string' && clientId
            ? clientId
            : null;
    }

    async scan({onStart = null, onProgress = null} = {}) {
        this.currentTab = null;
        this.#imageDimensionsByURL.clear();
        const [tab] = await window.chrome.tabs.query({
            active: true,
            currentWindow: true
        });
        this.currentTab = tab ?? null;

        const filters = this.settings.get('filters') ?? {};
        const result = await window.chrome.scripting.executeScript({
            target: {tabId: tab.id},
            func: scanImages,
            args: [filters.ignoreHiddenImages === true]
        });
        const filesFound = result[0]?.result ?? [];

        return this.createCandidates(filesFound, tab.id, {onStart, onProgress});
    }

    async createCandidates(
        filesFound,
        tabId,
        {onStart = null, onProgress = null, signal = null} = {}
    ) {
        if (!Array.isArray(filesFound) || !Number.isInteger(tabId)) return [];

        const isActive = () => signal?.aborted !== true;
        const filter = this.filter;
        const sources = this.settings.get('sources') ?? {};
        const images = [];

        onStart?.(filesFound.length);

        for (const image of filesFound) {
            if (!isActive()) break;
            try {
                if (sources[image.source] === false) continue;
                const dataImage = image.source === 'dataimages'
                    ? this.getDataImageInfo(image.url)
                    : null;
                if (image.source === 'dataimages' && !dataImage) continue;

                const blobImage = image.source === 'blobimages';
                const blobImageType = blobImage && typeof image.mimeType === 'string'
                    ? getImageType(image.mimeType)
                    : null;

                const url = dataImage || blobImage ? null : new URL(image.url);
                const candidateFileName = dataImage
                    ? `data-image.${dataImage.imageType}`
                    : blobImage
                        ? 'blob-image'
                        : decodeURIComponent(url.pathname.split('/').pop());
                if (this.isExcluded(candidateFileName)) continue;

                let fileInfo = dataImage
                        ? {size: dataImage.size}
                        : blobImage
                            ? {size: image.fileSize ?? null, type: image.mimeType ?? null}
                            : null,
                    imageType = dataImage?.imageType ?? blobImageType ??
                        (!blobImage && candidateFileName.includes('.')
                            ? candidateFileName.split('.').pop().toLowerCase()
                            : null);
                if (imageType === 'jpeg') imageType = 'jpg';

                // Keine oder unbekannte Extension → MIME-Type ermitteln
                if (!imageType || !filter.extensions.has(imageType)) {
                    if (dataImage || blobImage) continue;

                    fileInfo = await this.getFileInfo(image.url, signal);
                    if (!isActive()) break;
                    if (!fileInfo?.type) continue;
                    imageType = getImageType(fileInfo.type);
                    if (!imageType || !filter.extensions.has(imageType)) continue;
                }

                let width = image.width,
                    height = image.height,
                    dimensionsKnown = width > 0 && height > 0;

                if (!dimensionsKnown) {
                    const dimensions = await this.getImageDimensions(image.url, signal);
                    if (!isActive()) break;
                    if (!dimensions) continue;

                    width = dimensions.width;
                    height = dimensions.height;
                    dimensionsKnown = true;
                }

                const isValid = (dimensionsKnown && width >= filter.minWidth && height >= filter.minHeight);
                let estimatedSize = null;
                if (filter.ignoreSize && !isValid) {
                    fileInfo ??= await this.getFileInfo(image.url, signal);
                    if (!isActive()) break;
                    if (fileInfo?.size != null) {
                        if (fileInfo.size < filter.minSize) continue;
                    } else if (dimensionsKnown) {
                        estimatedSize = width * height * DEFAULT_BYTES_PER_PIXEL;
                        if (estimatedSize < filter.minSize) continue;
                    }
                }

                if (!isActive()) break;
                const imageId = crypto.randomUUID();
                const fileName = dataImage
                    ? `data-image-${imageId}.${imageType}`
                    : blobImage
                        ? `blob-image-${imageId}.${imageType}`
                        : candidateFileName;
                const candidate = {
                    id: imageId,
                    url: image.url,
                    fileName,
                    imageType,
                    width,
                    height,
                    fileSize: fileInfo?.size ?? null,
                    estimatedSize,
                    source: image.source,
                    tabId,
                    visuallyBlurred: image.visuallyBlurred === true
                };
                images.push(candidate);
            } catch (error) {
                console.warn('Cannot process image:', image.url, error);
            } finally {
                onProgress?.();
            }
        }

        return images;
    }

    async deepScan(image = null) {
        // Future API: image scans one image; null scans the whole document in the background.
        return null;
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        const session = this.#activeDeepScan;
        if (!session) return false;

        const normalizedEndReason = ['user-abort', 'popup-closed'].includes(endReason)
            ? endReason
            : 'cancelled';
        session.cancelled = true;
        session.controller.abort();
        session.finish({status: 'cancelled', endReason: normalizedEndReason});
        if (session.photoSwipeScanActive) {
            void window.chrome.scripting.executeScript({
                target: {tabId: session.tabId},
                func: abortPhotoSwipeImages,
                args: [session.scanId]
            }).catch(() => undefined);
        }
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

    async scanDeepImages(scanContext, onCandidates = null) {
        if (!scanContext?.isScannable || !Number.isInteger(scanContext.tabId)) {
            return [];
        }

        const filters = this.settings.get('filters') ?? {};
        const allowProtectedDeepScan = this.settings.get(
            'common',
            'allowProtectedDeepScan',
            false
        ) === true;
        const candidatesByURL = new Map();
        await this.cancelDeepScan();

        const scanId = crypto.randomUUID();
        let batchQueue = Promise.resolve();
        let resolveCompletion = null;
        const completion = new Promise((resolve) => {
            resolveCompletion = resolve;
        });
        const session = {
            scanId,
            tabId: scanContext.tabId,
            controller: new AbortController(),
            cancelled: false,
            photoSwipeScanActive: false,
            finished: false,
            finish: (result) => {
                if (session.finished) return;

                session.finished = true;
                window.chrome.runtime.onMessage.removeListener(onMessage);
                if (this.#activeDeepScan === session) this.#activeDeepScan = null;
                resolveCompletion(result);
            }
        };
        const sendPipelineDiagnostic = (diagnostic, result) => {
            if (!diagnostic) return;

            void window.chrome.runtime.sendMessage({
                target: ISOLATED_DEEP_SCAN_TARGET,
                action: 'diagnostic-result',
                scanId,
                diagnostic,
                result: {
                    scannerNewURLs: result.scannerNewURLs ?? 0,
                    imageFinderNewURLs: result.imageFinderNewURLs ?? 0,
                    acceptedCandidates: result.acceptedCandidates ?? 0,
                    existingUpgrades: result.existingUpgrades ?? 0,
                    visibleImageDelta: result.visibleImageDelta ?? 0,
                    visibleNewURLs: result.visibleNewURLs ?? 0,
                    visibleWinnersFromBatch: result.visibleWinnersFromBatch ?? 0,
                    notVisibleAfterFiltering: result.notVisibleAfterFiltering ?? 0,
                    visibleImages: Number.isFinite(result.visibleImages)
                        ? result.visibleImages
                        : 'unavailable'
                }
            }).catch(() => undefined);
        };
        const processCandidates = async (foundCandidates, diagnostic = null) => {
            if (session.cancelled || session.controller.signal.aborted) return;

            const newCandidates = [];
            for (const candidate of foundCandidates ?? []) {
                if (typeof candidate?.url !== 'string' || candidatesByURL.has(candidate.url)) continue;

                candidatesByURL.set(candidate.url, candidate);
                newCandidates.push(candidate);
            }
            if (newCandidates.length === 0 || typeof onCandidates !== 'function') {
                sendPipelineDiagnostic(diagnostic, {
                    scannerNewURLs: 0
                });
                return;
            }

            const result = await onCandidates(newCandidates, session.controller.signal, diagnostic);
            if (diagnostic && result && typeof result === 'object') {
                sendPipelineDiagnostic(diagnostic, {
                    scannerNewURLs: newCandidates.length,
                    ...result
                });
            }

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
        };
        const onMessage = (message) => {
            if (message?.target !== ISOLATED_DEEP_SCAN_TARGET || message.source !== 'background') {
                return;
            }
            if (message.scanId !== scanId) {
                return;
            }

            if (message.action === 'batch' && Array.isArray(message.candidates)) {
                batchQueue = batchQueue.then(() => processCandidates(
                    message.candidates,
                    message.diagnostic ?? null
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
                void batchQueue.then(() => session.finish(message));
            }
        };

        this.#activeDeepScan = session;
        window.chrome.runtime.onMessage.addListener(onMessage);

        try {
            try {
                session.photoSwipeScanActive = true;
                try {
                    const result = await window.chrome.scripting.executeScript({
                        target: {tabId: scanContext.tabId},
                        func: scanPhotoSwipeImages,
                        args: [{abortKey: scanId}]
                    });
                    await processCandidates(result[0]?.result ?? []);
                } finally {
                    session.photoSwipeScanActive = false;
                }
            } catch {
                // One visible PhotoSwipe target must never prevent the isolated DeepScan.
            }

            if (!session.cancelled) {
                const response = await window.chrome.runtime.sendMessage({
                    target: ISOLATED_DEEP_SCAN_TARGET,
                    action: 'start',
                    scanId,
                    url: scanContext.url,
                    tabId: scanContext.tabId,
                    ignoreHiddenImages: filters.ignoreHiddenImages === true,
                    allowProtectedDeepScan,
                    ...(this.#deepScanClientId ? {popupClientId: this.#deepScanClientId} : {})
                });
                if (response?.success !== true) {
                    session.finish({status: 'failed'});
                }

                await completion;
            }
        } catch {
            session.finish({status: 'failed'});
        } finally {
            session.finish({status: 'finished'});
        }

        return Array.from(candidatesByURL.values());
    }

    isExcluded(fileName) {
        const filters = this.settings.get('filters') ?? {};

        if (!filters.hasExcludeList) return false;

        const excludeList = filters.excludeList
            ?.split(',')
            .map(word => word.trim().toLowerCase())
            .filter(Boolean) ?? [];

        const name = fileName.toLowerCase();

        return excludeList.some(word => name.includes(word));
    }

    async getImageDimensions(url, signal = null) {
        if (this.#imageDimensionsByURL.has(url)) {
            return this.#imageDimensionsByURL.get(url);
        }

        const dimensionsPromise = new Promise((resolve) => {
            const image = new Image();

            const finish = (dimensions) => {
                clearTimeout(timeout);
                image.onload = null;
                image.onerror = null;
                signal?.removeEventListener?.('abort', onAbort);
                resolve(dimensions);
            };

            const timeout = setTimeout(() => finish(null), 10000);
            const onAbort = () => {
                try {
                    image.src = '';
                } catch {
                    // Clearing a page-owned image request is best effort.
                }
                finish(null);
            };

            image.onload = () => {
                const width = image.naturalWidth;
                const height = image.naturalHeight;

                finish(
                    width > 0 && height > 0
                        ? {width, height}
                        : null
                );
            };

            image.onerror = () => finish(null);

            try {
                image.src = url;
            } catch {
                finish(null);
            }
            if (signal?.aborted) onAbort();
            else signal?.addEventListener?.('abort', onAbort, {once: true});
        });

        this.#imageDimensionsByURL.set(url, dimensionsPromise);
        return dimensionsPromise;
    }

    async getFileInfo(url, signal = null) {
        try {
            const response = await fetch(url, {
                headers: {'Range': 'bytes=0-0'},
                ...(signal ? {signal} : {})
            });
            if (!response.ok) return null;

            const type = response.headers.get('content-type') || null;
            const contentRange = response.headers.get('content-range');

            let size = null;

            if (contentRange) {
                const total = contentRange.split('/').pop();
                if (total && total !== '*') size = Number(total) || null;
            } else {
                size = Number(response.headers.get('content-length')) || null;
            }

            await response.body?.cancel();
            return {
                size,
                type
            };

        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') return null;
            console.warn('Cannot read file info:', url, error);
            return null;
        }
    }

    getDataImageInfo(url) {
        if (typeof url !== 'string' || !/^data:image\//i.test(url)) return null;

        const commaIndex = url.indexOf(',');
        if (commaIndex === -1) return null;

        const metadata = url.slice(5, commaIndex);
        const [mime, ...parameters] = metadata.split(';');
        const imageType = getImageType(mime);
        if (!imageType) return null;

        const payload = url.slice(commaIndex + 1);
        const isBase64 = parameters.some(
            parameter => parameter.trim().toLowerCase() === 'base64'
        );

        return {
            imageType,
            size: isBase64
                ? this.getBase64PayloadSize(payload)
                : this.getPercentEncodedPayloadSize(payload)
        };
    }

    getBase64PayloadSize(payload) {
        let base64 = payload;

        try {
            if (base64.includes('%')) base64 = decodeURIComponent(base64);
        } catch {
            return null;
        }

        base64 = base64.replace(/\s/g, '');
        const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;

        return Math.max(0, Math.floor(base64.length * 3 / 4) - padding);
    }

    getPercentEncodedPayloadSize(payload) {
        let size = 0;
        let rawStart = 0;

        for (let index = 0; index < payload.length; index++) {
            const encodedByte = payload[index] === '%' &&
                /^[\da-f]{2}$/i.test(payload.slice(index + 1, index + 3));
            if (!encodedByte) continue;

            size += UTF8_ENCODER.encode(payload.slice(rawStart, index)).byteLength + 1;
            index += 2;
            rawStart = index + 1;
        }

        return size + UTF8_ENCODER.encode(payload.slice(rawStart)).byteLength;
    }
}
