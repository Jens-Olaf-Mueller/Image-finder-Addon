import { MediaType } from '../../shared/classes/MediaType.js';

const DEFAULT_BYTES_PER_PIXEL = 0.1;
const UTF8_ENCODER = new TextEncoder();

// ✏️ EDIT 2026-10-13: Defines the tested global DeepScan preparation cluster size.
export const MEDIA_CLUSTER_SIZE = 8; // 6 may be more stable eventually

/**
 * Prepares discovered media sources as scan candidates and provides their metadata.
 */
export default class MediaProvider {
    #imageDimensionsByURL = new Map();

    get filter() {
        const fileSize = this.settings.get('filesizes') ?? {};
        const imageTypes = this.settings.get('imagetypes') ?? {};
        const extensions = Object.entries(imageTypes)
            .filter(([_, enabled]) => enabled)
            .map(([ext]) => ext);

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
    }

    reset() {
        this.#imageDimensionsByURL.clear();
    }

    // ✴️ NEW 2026-10-11: Prepares a batch through a bounded asynchronous request cluster.
    async prepareCandidates(filesFound, tabId, {
        onStart = null,
        onProgress = null,
        signal = null,
        metrics = null,
        clusterSize = 1
    } = {}) {
        if (!Array.isArray(filesFound) || !Number.isInteger(tabId)) return [];

        const isActive = () => signal?.aborted !== true;
        const candidates = new Array(filesFound.length);
        const normalizedClusterSize = Number.isInteger(clusterSize) && clusterSize > 0
            ? clusterSize
            : 1;
        const filter = this.filter;
        const sources = this.settings.get('sources') ?? {};
        let nextIndex = 0;

        if (metrics) metrics.suppliedCandidates = filesFound.length;
        onStart?.(filesFound.length);

        const prepareNextCandidate = async () => {
            while (isActive()) {
                const idx = nextIndex;
                nextIndex += 1;
                if (idx >= filesFound.length) return;

                const media = filesFound[idx];
                try {
                    candidates[idx] = await this.#prepareCandidate(
                        media,
                        tabId,
                        filter,
                        sources,
                        signal,
                        metrics
                    );
                } catch (error) {
                    console.warn('Cannot process image:', media?.url, error);
                } finally {
                    onProgress?.();
                }
            }
        };
        const workers = Array.from(
            {length: Math.min(normalizedClusterSize, filesFound.length)},
            () => prepareNextCandidate()
        );
        await Promise.all(workers);

        const retVal = candidates.filter(Boolean);
        if (metrics) metrics.createdCandidates = retVal.length;
        return retVal;
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
            return {size, type};
        } catch (error) {
            if (signal?.aborted || error?.name === 'AbortError') return null;
            console.warn('Cannot read file info:', url, error);
            return null;
        }
    }

    // ✴️ NEW 2026-10-11: Creates one image candidate while retaining the current image-specific filter behaviour.
    async #prepareCandidate(image, tabId, filter, sources, signal, metrics) {
        const isActive = () => signal?.aborted !== true;
        if (!isActive()) return null;

        if (sources[image.source] === false) return null;

        const dataImage = image.source === 'dataimages'
            ? this.#getDataImageInfo(image.url)
            : null;
        if (image.source === 'dataimages' && !dataImage) return null;

        const blobImage = image.source === 'blobimages';
        const blobMediaType = blobImage && typeof image.mimeType === 'string'
            ? MediaType.getType(image.mimeType)
            : null;

        const url = dataImage || blobImage ? null : new URL(image.url);
        const candidateFileName = dataImage
            ? `data-image.${dataImage.mediaType.format}`
            : blobImage
                ? 'blob-image'
                : decodeURIComponent(url.pathname.split('/').pop());
        if (this.#isExcluded(candidateFileName)) return null;

        let fileInfo = dataImage
                ? {size: dataImage.size}
                : blobImage
                    ? {size: image.fileSize ?? null, type: image.mimeType ?? null}
                    : null,
            mediaType = dataImage?.mediaType ?? blobMediaType ??
                (!blobImage && candidateFileName.includes('.')
                    ? MediaType.getType(candidateFileName.split('.').pop())
                    : null);
        let imageType = mediaType?.type === 'image' ? mediaType.format : null;

        // Keine oder unbekannte Extension → MIME-Type ermitteln
        if (!imageType || !filter.extensions.has(imageType)) {
            if (dataImage || blobImage) return null;

            const fileInfoStartedAt = performance.now();
            if (metrics) metrics.fileInfoRequests += 1;
            fileInfo = await this.getFileInfo(image.url, signal);
            if (metrics) {
                metrics.fileInfoMs += performance.now() - fileInfoStartedAt;
                if (!fileInfo?.type) metrics.fileInfoFailures += 1;
            }
            if (!isActive() || !fileInfo?.type) return null;

            mediaType = MediaType.getType(fileInfo.type);
            imageType = mediaType?.type === 'image' ? mediaType.format : null;
            if (!imageType || !filter.extensions.has(imageType)) return null;
        }

        let width = image.width,
            height = image.height,
            dimensionsKnown = width > 0 && height > 0;

        if (!dimensionsKnown) {
            const dimensionsCached = this.#imageDimensionsByURL.has(image.url);
            const dimensionsStartedAt = performance.now();
            if (metrics) {
                metrics.dimensionRequests += 1;
                if (dimensionsCached) metrics.dimensionCacheHits += 1;
            }
            const dimensions = await this.#getImageDimensions(image.url, signal);
            if (metrics) {
                metrics.dimensionMs += performance.now() - dimensionsStartedAt;
                if (!dimensions) metrics.dimensionFailures += 1;
            }
            if (!isActive() || !dimensions) return null;

            width = dimensions.width;
            height = dimensions.height;
            dimensionsKnown = true;
        }

        const isValid = dimensionsKnown && width >= filter.minWidth && height >= filter.minHeight;
        let estimatedSize = null;
        if (filter.ignoreSize && !isValid) {
            if (!fileInfo) {
                const fileInfoStartedAt = performance.now();
                if (metrics) metrics.fileInfoRequests += 1;
                fileInfo = await this.getFileInfo(image.url, signal);
                if (metrics) {
                    metrics.fileInfoMs += performance.now() - fileInfoStartedAt;
                    if (!fileInfo?.type) metrics.fileInfoFailures += 1;
                }
            }
            if (!isActive()) return null;

            if (fileInfo?.size != null) {
                if (fileInfo.size < filter.minSize) return null;
            } else if (dimensionsKnown) {
                estimatedSize = width * height * DEFAULT_BYTES_PER_PIXEL;
                if (estimatedSize < filter.minSize) return null;
            }
        }

        if (!isActive()) return null;

        const imageId = crypto.randomUUID();
        const fileName = dataImage
            ? `data-image-${imageId}.${imageType}`
            : blobImage
                ? `blob-image-${imageId}.${imageType}`
                : candidateFileName;

        return {
            id: imageId,
            url: image.url,
            fileName,
            mediaType: mediaType.type,
            imageType,
            width,
            height,
            fileSize: fileInfo?.size ?? null,
            estimatedSize,
            source: image.source,
            tabId,
            visuallyBlurred: image.visuallyBlurred === true
        };
    }

    #isExcluded(fileName) {
        const filters = this.settings.get('filters') ?? {};
        if (!filters.hasExcludeList) return false;

        const excludeList = filters.excludeList
            ?.split(',')
            .map(word => word.trim().toLowerCase())
            .filter(Boolean) ?? [];
        const name = fileName.toLowerCase();

        return excludeList.some(word => name.includes(word));
    }

    async #getImageDimensions(url, signal = null) {
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
                finish(width > 0 && height > 0 ? {width, height} : null);
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

    #getDataImageInfo(url) {
        if (typeof url !== 'string' || !/^data:image\//i.test(url)) return null;

        const commaIndex = url.indexOf(',');
        if (commaIndex === -1) return null;

        const metadata = url.slice(5, commaIndex);
        const [mime, ...parameters] = metadata.split(';');
        const mediaType = MediaType.getType(mime);
        if (!mediaType || mediaType.type !== 'image') return null;

        const payload = url.slice(commaIndex + 1);
        const isBase64 = parameters.some(
            parameter => parameter.trim().toLowerCase() === 'base64'
        );

        return {
            mediaType,
            size: isBase64
                ? this.#getBase64PayloadSize(payload)
                : this.#getPercentEncodedPayloadSize(payload)
        };
    }

    #getBase64PayloadSize(payload) {
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

    #getPercentEncodedPayloadSize(payload) {
        let size = 0;
        let rawStart = 0;

        for (let i = 0; i < payload.length; i++) {
            const encodedByte = payload[i] === '%' &&
                /^[\da-f]{2}$/i.test(payload.slice(i + 1, i + 3));
            if (!encodedByte) continue;

            size += UTF8_ENCODER.encode(payload.slice(rawStart, i)).byteLength + 1;
            i += 2;
            rawStart = i + 1;
        }

        return size + UTF8_ENCODER.encode(payload.slice(rawStart)).byteLength;
    }
}
