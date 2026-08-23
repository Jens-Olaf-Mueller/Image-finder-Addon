import { Settings } from './Settings_class.js';
import Progressbar from './Progressbar.js';
import { scanImages } from './content.js';

const DEFAULT_BYTES_PER_PIXEL = 0.1;
const UTF8_ENCODER = new TextEncoder();

export class ImageFinder {

    get selectedItem() {
        return this.DOM.lstImages.querySelector('.selected') || null;
    }

    get selectedImage() {
        const imageId = this.selectedItem?.dataset.imageId;
        return imageId ? this.images.get(imageId) ?? null : null;
    }

    get listItems() {
        return Array.from(this.DOM.lstImages.querySelectorAll('li')) || [];
    }

    get listIndex() {
        const items = Array.from(this.DOM.lstImages.querySelectorAll('li'));
        return items.indexOf(this.selectedItem);
    }

    get downloadButtonState() {
        return (this.settings.get('downloads') ?? {}).disableDownloadWhenDone === true;
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

    get statusBar() { return this.DOM.spnStatusBar?.innerHTML; }
    set statusBar(text) {
        if (typeof text === 'string') this.DOM.spnStatusBar.innerHTML = text;
    }

    get info() { return this.DOM.h2_Preview.textContent; }
    set info(text) {
        if (typeof text === 'string') this.DOM.h2_Preview.textContent = text;
    }

    DOM = {};
    sortState = {
        criterion: null,
        direction: 'asc'
    };

    constructor() {
        // register all DOM elements with ID
        document.querySelectorAll('[id]').forEach(elmt => {
            this.DOM[elmt.id] = elmt;
        });
        this.settings = new Settings();
        this.images = new Map();
        this.progressbar = new Progressbar(this.DOM.divProgressbar);
        this.isSavingAll = false;
        this.currentBlobPreview = null;

        console.dir(this)
    }

    async run(onSettingsReady = null) {
        await this.setWebsiteOriginFromActiveTab();
        await this.settings.run();
        if (typeof onSettingsReady === 'function') await onSettingsReady();
        this.setEventListeners();
        if (this.settings.get('common', 'scanOnStart', true)) await this.scan();
    }

    async setWebsiteOriginFromActiveTab() {
        try {
            const [tab] = await window.chrome.tabs.query({
                active: true,
                currentWindow: true
            });

            this.settings.setWebsiteOrigin(tab?.url);
        } catch {
            this.settings.setWebsiteOrigin(null);
        }
    }

    setEventListeners() {
        this.DOM.divToolbar.addEventListener('click', e => this.onButtonClick(e));
        this.DOM.divToolbarTopLeft.addEventListener('click', e => this.onSortButtonClick(e));
        this.DOM.lstImages.addEventListener('click', e => this.onListItemClick(e));
        this.DOM.lstImages.addEventListener('keydown', e => this.onKeyPress(e));
    }

    onSortButtonClick(e) {
        const button = e.target.closest('button');
        if (!button || !this.DOM.divToolbarTopLeft.contains(button)) return;

        this.DOM.divToolbarTopLeft.querySelectorAll('button').forEach(sortButton => {
            sortButton.classList.remove('sorted');
        });
        button.classList.add('sorted');

        const criterion = button.dataset.sort;
        this.sort(criterion);
    }

    sort(criterion) {
        if (!['filename', 'type', 'size', 'dimensions'].includes(criterion)) return;

        const direction = this.sortState.criterion === criterion &&
            this.sortState.direction === 'asc'
            ? 'desc'
            : 'asc';
        const directionFactor = direction === 'asc' ? 1 : -1;
        const selectedItem = this.selectedItem;
        const compareFileNames = (first, second) => String(first.fileName ?? '')
            .localeCompare(String(second.fileName ?? ''), undefined, {sensitivity: 'base'});
        const getKnownSize = image => {
            const size = image.fileSize ?? image.estimatedSize;
            return Number.isFinite(size) ? size : null;
        };

        const items = this.listItems;
        items.sort((firstItem, secondItem) => {
            const first = this.images.get(firstItem.dataset.imageId);
            const second = this.images.get(secondItem.dataset.imageId);
            if (!first || !second) return 0;

            let comparison = 0;

            switch (criterion) {
                case 'filename':
                    comparison = compareFileNames(first, second);
                    break;

                case 'type':
                    comparison = String(first.imageType ?? '')
                        .localeCompare(String(second.imageType ?? ''), undefined, {sensitivity: 'base'}) ||
                        compareFileNames(first, second);
                    break;

                case 'size': {
                    const firstSize = getKnownSize(first);
                    const secondSize = getKnownSize(second);
                    const firstSizeUnknown = firstSize === null;
                    const secondSizeUnknown = secondSize === null;

                    if (firstSizeUnknown || secondSizeUnknown) {
                        if (firstSizeUnknown && secondSizeUnknown) return 0;
                        return firstSizeUnknown ? 1 : -1;
                    }

                    comparison = firstSize - secondSize;
                    break;
                }

                case 'dimensions':
                    comparison = (first.width * first.height) - (second.width * second.height) ||
                        compareFileNames(first, second);
                    break;
            }

            return comparison * directionFactor;
        });

        this.DOM.lstImages.append(...items);
        this.sortState = {criterion, direction};
        selectedItem?.scrollIntoView({block: 'nearest'});
    }

    async onKeyPress(e) {
        const items = this.listItems;
        if (!items.length) return;

        e.preventDefault();
        let index = this.listIndex;
        switch (e.key) {
            case 'ArrowUp':
                index = index <= 0 ? items.length - 1 : index - 1;
                break;
            case 'ArrowDown':
                index = index < 0 || index >= items.length - 1 ? 0 : index + 1;
                break;
            case 'Home':
                index = 0;
                break;
            case 'End':
                index = items.length - 1;
                break;
            case 'Delete':
                this.deleteImage(this.selectedItem);
                return;
            case 'Enter':
                await this.saveImage(this.selectedItem);
                return;
            default:
                return;
        }

        const item = items[index];
        this.selectedItem?.classList.remove('selected');
        item.classList.add('selected');

        item.scrollIntoView({ block: 'nearest' });
        await this.#showImage(item);
    }

    async #showImage(item) {
        const imageId = item?.dataset.imageId;
        const image = imageId ? this.images.get(imageId) ?? null : null;
        if (!image) return;

        if (image.source === 'blobimages') {
            const cachedPreview = this.currentBlobPreview?.imageId === imageId
                ? this.currentBlobPreview.dataUrl
                : null;

            if (cachedPreview) {
                this.DOM.imgPreview.src = cachedPreview;
            } else {
                this.currentBlobPreview = null;
                this.DOM.imgPreview.removeAttribute('src');

                const response = await window.chrome.runtime.sendMessage({
                    action: 'resolveBlobImage',
                    tabId: image.tabId,
                    blobUrl: image.url
                });

                if (this.selectedItem?.dataset.imageId !== imageId) return;
                if (response?.success !== true || typeof response.dataUrl !== 'string') {
                    throw new Error(response?.error || 'Cannot resolve Blob image for preview');
                }

                this.currentBlobPreview = {imageId, dataUrl: response.dataUrl};
                this.DOM.imgPreview.src = response.dataUrl;
            }
        } else {
            this.currentBlobPreview = null;
            this.DOM.imgPreview.src = item.dataset.url;
        }

        this.DOM.h2_Preview.style.display = 'none';
        this.DOM.btnDelete.disabled = false;
        const downloadOff = this.downloadButtonState && item.classList.contains('saved');
        this.DOM.btnDownload.disabled = false || downloadOff;

        if (image.fileSize === null &&
            image.source !== 'dataimages' &&
            image.source !== 'blobimages') {
            const fileInfo = await this.getFileInfo(item.dataset.url);

            if (this.selectedItem?.dataset.imageId !== imageId) return;

            image.fileSize = fileInfo?.size ?? null;
        }

        if (this.selectedItem?.dataset.imageId !== imageId) return;

        const size = image.fileSize >= 1048576
            ? `${parseInt(image.fileSize / 1024 / 1024)} MB`
            : image.fileSize ? `${parseInt(image.fileSize / 1024)} KB` : '??? KB';
        const exactSize = Number.isFinite(image.fileSize) && image.fileSize > 0
            ? ` (${image.fileSize.toLocaleString()} bytes)`
            : '';
        const icon = IMAGE_TYPES[image.imageType].icon;
        const dims = `${image.width} × ${image.height} px`;
        this.statusBar = `
            <img id="imgTypeInfoIcon" src="${icon}" alt="${image.imageType}" style="height: 1.25rem; transform: translateY(4px)" title="${image.imageType.toUpperCase()} image, Resolution: ${dims}, Size: ${size}${exactSize}">
               ${dims} [${size}]`;
        this.DOM.spnStatusBar.style.display = 'block';
    }

    async onListItemClick(e) {
        const item = e.target.closest('li');
        if (!item) return;

        this.selectedItem?.classList.remove('selected');
        item.classList.add('selected');
        this.DOM.lstImages.focus();

        try {
            await this.#showImage(item);
        } catch (error) {
            console.warn('Cannot show image:', item.dataset.url, error);
        }
    }

    async onButtonClick(e) {
        const btn = e.target.closest('button');
        if (!btn) return;

        const item = this.selectedItem;
        const btnName = btn.id.slice(3).toLowerCase() || '';
        switch (btnName) {
            case 'settings':
                await this.toggleSettingsPanel();
                break;

            case 'search':
                await this.scan();
                break;

            case 'scan':
                // TODO re-scan the selected image for a better version
                break;

            case 'download':
                await this.saveImage(item);
                break;

            case 'saveall':
                await this.saveAllImages();
                break;

            case 'delete':
                this.deleteImage(item);
                break;

            case 'clear':
                this.clear();
                break;

            case 'restart':
                window.chrome.runtime.reload();
                break;

            default:
                console.log(`Unhandled button: [${btnName}]`);
                break;
        }
    }

    async toggleSettingsPanel() {
        const isOpen = this.DOM.btnSettings.value === 'true';
        const nextState = String(!isOpen);
        this.DOM.btnSettings.value = nextState;
        this.DOM.divSettingsPanel.classList.toggle('open', nextState === 'true');

        if (!isOpen) return;

        await this.settings.waitForPendingSave();
        if (this.settings.get('common', 'scanOnSettingsChanged', true)) {
            await this.scan();
        }
    }

    clear() {
        this.images.clear();
        this.currentBlobPreview = null;
        this.DOM.lstImages.innerHTML = '';
        this.DOM.imgPreview.removeAttribute('src');
        this.DOM.h2_Preview.style.display = 'block';
        this.info = 'Image preview';
        this.DOM.btnDownload.disabled = true;
        this.DOM.btnSaveAll.disabled = true;
        this.DOM.btnDelete.disabled = true;
        this.DOM.btnClear.disabled = true;
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

    async scan() {
        const [tab] = await window.chrome.tabs.query({
            active: true,
            currentWindow: true
        });

        this.clear();
        this.sortState = {criterion: null, direction: 'asc'};
        this.DOM.divToolbarTopLeft.querySelectorAll('button').forEach(sortButton => {
            sortButton.classList.remove('sorted');
        });
        this.DOM.spnStatusBar.style.display = 'none';
        this.info = 'Scanning...';

        try {
            const filters = this.settings.get('filters') ?? {};
            const result = await window.chrome.scripting.executeScript({
                target: {tabId: tab.id},
                func: scanImages,
                args: [
                    filters.ignoreHiddenImages === true,
                    filters.scanBlurredImages !== false
                ]
            });
            const filesFound = result[0]?.result ?? [];
            const filter = this.filter;
            const sources = this.settings.get('sources') ?? {};
            const seenUrls = new Set();
            this.progressbar.show(filesFound.length);

            for (const image of filesFound) {
                try {
                    if (sources[image.source] === false) continue;
                    if (filters.removeDuplicates && seenUrls.has(image.url)) continue;

                    const dataImage = image.source === 'dataimages'
                        ? this.getDataImageInfo(image.url)
                        : null;
                    if (image.source === 'dataimages' && !dataImage) continue;

                    const blobImage = image.source === 'blobimages';
                    const blobImageType = blobImage && typeof image.mimeType === 'string'
                        ? this.getImageType(image.mimeType)
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
                        imageType = this.getImageType(fileInfo.type);
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
                    if (filters.removeDuplicates) seenUrls.add(image.url);

                    this.images.set(imageId, {
                        id: imageId,
                        url: image.url,
                        fileName,
                        imageType,
                        width,
                        height,
                        fileSize: fileInfo?.size ?? null,
                        estimatedSize,
                        source: image.source,
                        tabId: tab.id
                    });
                } catch (error) {
                    console.warn('Cannot process image:', image.url, error);
                } finally {
                    this.progressbar.update();
                }
            }

            this.images.forEach((image, imageId) => {
                const li = document.createElement('li');
                li.textContent = image.fileName;
                li.title = image.fileName;
                li.dataset.imageId = imageId;
                li.dataset.url = image.url;
                this.DOM.lstImages.appendChild(li);
            });

            this.progressbar.hide();
            this.DOM.btnSaveAll.disabled = (this.images.size === 0);
            this.DOM.btnClear.disabled = (this.images.size === 0);

        } catch (error) {
            console.warn('Cannot scan this page:', tab.url);
            this.info = 'Page not allowed to scan!';
            return;
        }
        this.info = 'Image preview';
    }

    async saveImage(item) {
        const image = this.selectedImage;
        if (!item || !image) return;

        // ❌
        // await window.chrome.downloads.download({
        //     url: item.dataset.url,
        //     ...this.getDownloadOptions(item.textContent)
        // });
        await this.downloadImage(image);

        item.classList.add('saved');
        this.DOM.btnDownload.disabled = this.downloadButtonState;
    }

    async saveAllImages() {
        if (this.isSavingAll) return;

        this.isSavingAll = true;
        this.DOM.btnSaveAll.disabled = true;

        try {
            const zipFileList = (this.settings.get('downloads') ?? {}).zipFileList === true;
            const images = Array.from(this.images, ([imageId, image]) => ({
                imageId,
                url: image.url,
                source: image.source,
                tabId: image.tabId,
                ...(zipFileList ? {fileName: image.fileName} : {}),
                options: this.getDownloadOptions(image.fileName)
            }));
            const request = {
                action: 'downloadImageList',
                images
            };
            if (zipFileList) {
                request.zip = {
                    enabled: true,
                    options: this.getDownloadOptions('image-finder.zip')
                };
            }

            const response = await window.chrome.runtime.sendMessage(request);

            if (response?.success !== true) {
                throw new Error(response?.error || 'Background download list failed');
            }

            for (const result of response.results ?? []) {
                if (result.success !== true) {
                    console.warn('Cannot download image:', result.url, result.error);
                    continue;
                }

                const item = this.listItems.find(
                    li => li.dataset.imageId === result.imageId
                );
                if (!item) continue;

                item.classList.add('saved');
                if (this.downloadButtonState && this.selectedItem === item) {
                    this.DOM.btnDownload.disabled = true;
                }
            }
        } catch (error) {
            console.warn('Cannot download image list:', error);
        } finally {
            this.isSavingAll = false;
            this.DOM.btnSaveAll.disabled = (this.images.size === 0);
        }
    }

    async downloadImage(image) {
        const response = await window.chrome.runtime.sendMessage({
            action: 'downloadImage',
            url: image.url,
            source: image.source,
            tabId: image.tabId,
            options: this.getDownloadOptions(image.fileName)
        });

        if (response?.success !== true) {
            throw new Error(response?.error || 'Background download failed');
        }

        return response.downloadId;
    }

    getDownloadOptions(fileName) {
        const downloads = this.settings.get('downloads') ?? {};
        const userFolder = String(downloads.userFolder ?? '')
            .trim()
            .replaceAll('\\', '/')
            .replace(/\/+$/, '');
        const defaultFolder = String(downloads.defaultFolder ?? '')
            .trim()
            .replaceAll('\\', '/')
            .replace(/\/+$/, '');

        let relativeFolder = userFolder;

        if (defaultFolder && (userFolder === defaultFolder || userFolder.startsWith(`${defaultFolder}/`))) {
            relativeFolder = userFolder.slice(defaultFolder.length).replace(/^\/+/, '');
        } else if (userFolder.startsWith('/') || /^[A-Za-z]:\//.test(userFolder)) {
            relativeFolder = '';
        }

        return {
            filename: relativeFolder ? `${relativeFolder}/${fileName}` : fileName,
            saveAs: downloads.downloadFolder !== 'user'
        };
    }

    deleteImage(item) {
        if (!item) return;

        if (this.currentBlobPreview?.imageId === item.dataset.imageId) {
            this.currentBlobPreview = null;
        }

        this.images.delete(item.dataset.imageId);
        item.remove();

        this.DOM.imgPreview.removeAttribute('src');
        this.DOM.btnDownload.disabled = true;
        this.DOM.btnDelete.disabled = true;
        this.DOM.btnSaveAll.disabled = (this.images.size === 0);
        this.DOM.btnClear.disabled = (this.images.size === 0);
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
        const imageType = this.getImageType(mime);
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

    getImageType(mime) {
        const key = mime.split(';')[0].trim().toLowerCase();
        return Object.entries(IMAGE_TYPES).find(([_, type]) => type.mime.includes(key))?.[0] ?? null;
    }
}

const IMAGE_TYPES = Object.freeze({
    jpg: {
        mime: ['image/jpeg'],
        icon: '../assets/icons/jpeg.png'
    },
    png: {
        mime: ['image/png'],
        icon: '../assets/icons/png.png'
    },
    bmp: {
        mime: ['image/bmp', 'image/x-ms-bmp'],
        icon: '../assets/icons/bmp.png'
    },
    webp: {
        mime: ['image/webp'],
        icon: '../assets/icons/webp.png'
    },
    gif: {
        mime: ['image/gif'],
        icon: '../assets/icons/gif.png'
    },
    svg: {
        mime: ['image/svg+xml'],
        icon: '../assets/icons/svg.png'
    },
    avif: {
        mime: ['image/avif'],
        icon: '../assets/icons/avif.png'
    }
});
