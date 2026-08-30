import { scanImages } from '../content.js';
import { getImageType } from '../image-types.js';

const DEFAULT_BYTES_PER_PIXEL = 0.1;
const UTF8_ENCODER = new TextEncoder();

export default class ImageScanner {

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

    async scan({onStart = null, onProgress = null} = {}) {
        this.currentTab = null;
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
        const filter = this.filter;
        const sources = this.settings.get('sources') ?? {};
        const images = [];

        onStart?.(filesFound.length);

        for (const image of filesFound) {
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

                    fileInfo = await this.getFileInfo(image.url);
                    if (!fileInfo?.type) continue;
                    imageType = getImageType(fileInfo.type);
                    if (!imageType || !filter.extensions.has(imageType)) continue;
                }

                let width = image.width,
                    height = image.height,
                    dimensionsKnown = width > 0 && height > 0;

                if (filter.ignoreSize && !dimensionsKnown) {
                    const dimensions = await this.getImageDimensions(image.url);
                    if (dimensions) {
                        width = dimensions.width;
                        height = dimensions.height;
                        dimensionsKnown = true;
                    }
                }

                const isValid = (dimensionsKnown && width >= filter.minWidth && height >= filter.minHeight);
                let estimatedSize = null;
                if (filter.ignoreSize && !isValid) {
                    fileInfo ??= await this.getFileInfo(image.url);
                    if (fileInfo?.size != null) {
                        if (fileInfo.size < filter.minSize) continue;
                    } else if (dimensionsKnown) {
                        estimatedSize = width * height * DEFAULT_BYTES_PER_PIXEL;
                        if (estimatedSize < filter.minSize) continue;
                    }
                }

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
                    tabId: tab.id,
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

    async getImageDimensions(url) {
        return new Promise((resolve) => {
            const image = new Image();

            const finish = (dimensions) => {
                clearTimeout(timeout);
                image.onload = null;
                image.onerror = null;
                resolve(dimensions);
            };

            const timeout = setTimeout(() => finish(null), 10000);

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
        });
    }

    async getFileInfo(url) {
        try {
            const response = await fetch(url, {headers: { 'Range': 'bytes=0-0' }});
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
