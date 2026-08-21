import { Settings } from './Settings.js';
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

    get statusBar() { return this.DOM.spnStatusBar?.textContent; }
    set statusBar(text) {
        if (typeof text === 'string') this.DOM.spnStatusBar.textContent = text;
    }

    get info() { return this.DOM.h2_Preview.textContent; }
    set info(text) {
        if (typeof text === 'string') this.DOM.h2_Preview.textContent = text;
    }

    DOM = {};

    constructor() {
        // register all DOM elements with ID
        document.querySelectorAll('[id]').forEach(elmt => {
            this.DOM[elmt.id] = elmt;
        });
        this.settings = new Settings();
        this.images = new Map();
        this.progressbar = new Progressbar(this.DOM.divProgressbar);
        this.isSavingAll = false;

        console.dir(this)
    }

    async run() {
        await this.settings.run();
        this.setEventListeners();
        if (this.settings.get('common', 'scanOnStart', true)) await this.scan();
    }

    setEventListeners() {
        this.DOM.divToolbar.addEventListener('click', e => this.onButtonClick(e));
        this.DOM.lstImages.addEventListener('click', e => this.onListItemClick(e));
        this.DOM.lstImages.addEventListener('keydown', e => this.onKeyPress(e));
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

        this.DOM.imgPreview.src = item.dataset.url;
        this.DOM.h2_Preview.style.display = 'none';
        this.DOM.btnDelete.disabled = false;
        const downloadOff = this.downloadButtonState && item.classList.contains('saved');
        this.DOM.btnDownload.disabled = false || downloadOff;

        if (image.fileSize === null && image.source !== 'dataimages') {
            const fileInfo = await this.getFileInfo(item.dataset.url);

            if (this.selectedItem?.dataset.imageId !== imageId) return;

            image.fileSize = fileInfo?.size ?? null;
        }

        if (this.selectedItem?.dataset.imageId !== imageId) return;

        const size = image.fileSize >= 1048576
            ? `${parseInt(image.fileSize / 1024 / 1024)} MB`
            : image.fileSize ? `${parseInt(image.fileSize / 1024)} KB` : '??? KB';
        this.statusBar = `${image.imageType}: ${image.width} × ${image.height} px [${size}]`;
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
                window.chrome.runtime.openOptionsPage();
                break;

            case 'search':
                await this.scan();
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
                // TODO restart AddOn
                break;

            default:
                console.log(`Unhandled button: [${btnName}]`);
                break;
        }
    }

    clear() {
        this.images.clear();
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
        this.DOM.spnStatusBar.style.display = 'none';
        this.info = 'Scanning...';

        try {
            const filters = this.settings.get('filters') ?? {};
            const result = await window.chrome.scripting.executeScript({
                target: {tabId: tab.id},
                func: scanImages,
                args: [filters.ignoreHiddenImages === true]
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

                    const url = dataImage ? null : new URL(image.url);
                    const candidateFileName = dataImage
                        ? `data-image.${dataImage.imageType}`
                        : decodeURIComponent(url.pathname.split('/').pop());
                    if (this.isExcluded(candidateFileName)) continue;

                    // ❌
                    // let fileInfo = null,
                    //     imageType = fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : null;
                    let fileInfo = dataImage ? {size: dataImage.size} : null,
                        imageType = dataImage?.imageType ??
                            (candidateFileName.includes('.')
                                ? candidateFileName.split('.').pop().toLowerCase()
                                : null);
                    if (imageType === 'jpeg') imageType = 'jpg';

                    // Keine oder unbekannte Extension → MIME-Type ermitteln
                    if (!imageType || !filter.extensions.has(imageType)) {
                        if (dataImage) continue;

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
                        source: image.source
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
            for (const [imageId, image] of this.images) {
                try {
                    await this.downloadImage(image);

                    const item = this.listItems.find(
                        li => li.dataset.imageId === imageId
                    );
                    if (!item) continue;

                    item.classList.add('saved');
                    if (this.downloadButtonState && this.selectedItem === item) {
                        this.DOM.btnDownload.disabled = true;
                    }
                } catch (error) {
                    console.warn('Cannot download image:', image.url, error);
                }
            }
        } finally {
            this.isSavingAll = false;
            this.DOM.btnSaveAll.disabled = (this.images.size === 0);
        }
    }

    async downloadImage(image) {
        let objectUrl = null;
        let downloadId = null;
        let onChanged = null;

        const releaseObjectUrl = () => {
            if (!objectUrl) return;

            if (onChanged) window.chrome.downloads.onChanged.removeListener(onChanged);
            URL.revokeObjectURL(objectUrl);
            objectUrl = null;
        };

        try {
            let downloadUrl = image.url;

            if (image.source === 'dataimages') {
                const response = await fetch(image.url);
                if (!response.ok) throw new Error('Cannot create download Blob');

                const blob = await response.blob();
                objectUrl = URL.createObjectURL(blob);
                downloadUrl = objectUrl;

                onChanged = (delta) => {
                    const state = delta.state?.current;
                    if (delta.id !== downloadId || !['complete', 'interrupted'].includes(state)) return;

                    releaseObjectUrl();
                };
                window.chrome.downloads.onChanged.addListener(onChanged);
            }

            downloadId = await window.chrome.downloads.download({
                url: downloadUrl,
                ...this.getDownloadOptions(image.fileName)
            });

            if (objectUrl) {
                try {
                    const [download] = await window.chrome.downloads.search({id: downloadId});
                    if (['complete', 'interrupted'].includes(download?.state)) releaseObjectUrl();
                } catch (error) {
                    console.warn('Cannot read download status:', downloadId, error);
                }
            }

            return downloadId;

        } catch (error) {
            releaseObjectUrl();
            throw error;
        }
    }

    getDownloadOptions(fileName) {
        const downloads = this.settings.get('downloads') ?? {};

        if (downloads.downloadFolder !== 'user') {
            return {
                filename: fileName,
                saveAs: true
            };
        }

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
            saveAs: false
        };
    }

    deleteImage(item) {
        if (!item) return;

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
        const types = {
            'image/jpeg': 'jpg',
            'image/png': 'png',
            'image/webp': 'webp',
            'image/gif': 'gif',
            'image/svg+xml': 'svg',
            'image/avif': 'avif'
        };
        return types[key] ?? null;
    }
}
