import { Settings } from './Settings_class.js';
import ImageScanner from './ImageScanner.js';
import { IMAGE_TYPES } from '../image-types.js';
import Progressbar from './Progressbar.js';

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
        this.scanner = new ImageScanner(this.settings);
        // Internal scan candidates may later remain available for analysis when excluded from the visible image list.
        this.candidates = new Map();
        this.images = new Map();
        this.progressbar = new Progressbar(this.DOM.divProgressbar);
        this.isSavingAll = false;
        this.currentBlobPreview = null;
        this.#updateLED();

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
            const fileInfo = await this.scanner.getFileInfo(item.dataset.url);

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
        this.candidates.clear();
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
        this.#updateLED();
    }

    async scan() {
        this.clear();
        this.sortState = {criterion: null, direction: 'asc'};
        this.DOM.divToolbarTopLeft.querySelectorAll('button').forEach(sortButton => {
            sortButton.classList.remove('sorted');
        });
        this.DOM.spnStatusBar.style.display = 'none';
        this.info = 'Scanning...';

        try {
            const scanResults = await this.scanner.scan({
                onStart: count => this.progressbar.show(count),
                onProgress: () => this.progressbar.update()
            });

            this.#setScanResults(scanResults);

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
            this.#updateLED();

        } catch (error) {
            console.warn('Cannot scan this page:', this.scanner.currentTab?.url);
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
        this.candidates.delete(item.dataset.imageId);
        item.remove();

        this.DOM.imgPreview.removeAttribute('src');
        this.DOM.btnDownload.disabled = true;
        this.DOM.btnDelete.disabled = true;
        this.DOM.btnSaveAll.disabled = (this.images.size === 0);
        this.DOM.btnClear.disabled = (this.images.size === 0);
        this.#updateLED();
    }

    #setScanResults(scanResults) {
        scanResults.forEach((image) => {
            this.candidates.set(image.id, image);
            this.images.set(image.id, image);
        });
    }

    #updateLED() {
        this.DOM.divLED.textContent = this.images.size;
    }
}
