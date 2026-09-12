import { Settings } from './Settings.js';
import ImageScanner from './ImageScanner.js';
import { IMAGE_TYPES } from '../image-types.js';
import Progressbar from './Progressbar.js';
import BlurScanner from './BlurScanner.js';
import ImageMatcher from './ImageMatcher.js';
import { ScanContext } from './ScanContext.js';
const SORT_ICON_BASE_NAMES = Object.freeze({
    filename: 'sort-alphabetical',
    type: 'sort-type',
    size: 'sort-size',
    dimensions: 'sort-dims'
});
const SCAN_PROGRESS_COLOR = '#32CD32';
const FILTER_PROGRESS_COLOR = '#FF6347';

export class ImageFinder {
    #activityCounts = {
        scanner: 0,
        matcher: 0,
        blurScanner: 0,
        deepScan: 0
    };
    #scanGeneration = 0;

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
        this.scanContext = new ScanContext();
        this.scanner = new ImageScanner(this.settings);
        // Internal scan candidates may later remain available for analysis when excluded from the visible image list.
        this.candidates = new Map();
        this.images = new Map();
        // Shared session-scoped cache for future image analysis.
        this.analysisStore = new Map();
        this.blurScanner = new BlurScanner(this.analysisStore);
        this.imageMatcher = new ImageMatcher(this.analysisStore);
        this.imageMatcher.mode = 'strict';
        this.progressbar = new Progressbar(this.DOM.divProgressbar);
        this.settingsForm = null;
        this.isSavingAll = false;
        this.currentBlobPreview = null;
        this.#updateLED();
        this.#updateLEDActivity();

        console.dir(this)
    }

    async run(onSettingsReady = null) {
        await this.setWebsiteURLFromActiveTab();
        await this.settings.run();
        if (typeof onSettingsReady === 'function') await onSettingsReady();
        this.updateDownloadTitles();
        this.setEventListeners();
        if (this.settings.get('common', 'scanOnStart', true)) await this.scan();
    }

    setSettingsForm(settingsForm) {
        this.settingsForm = settingsForm;
    }

    async setWebsiteURLFromActiveTab() {
        try {
            const [tab] = await window.chrome.tabs.query({
                active: true,
                currentWindow: true
            });

            this.scanContext.setTab(tab);
            this.settings.setWebsiteURL(tab?.url);
        } catch {
            this.scanContext.clear();
            this.settings.setWebsiteURL(null);
        }
    }

    setEventListeners() {
        this.DOM.divToolbar.addEventListener('click', e => this.onButtonClick(e));
        this.DOM.divToolbarTopLeft.addEventListener('click', e => this.onSortButtonClick(e));
        this.DOM.btnStopDeepScan?.addEventListener('click', () => {
            void this.stopDeepScanByUser();
        });
        this.DOM.lstImages.addEventListener('click', e => this.onListItemClick(e));
        this.DOM.lstImages.addEventListener('keydown', e => this.onKeyPress(e));
    }

    onSortButtonClick(e) {
        const button = e.target.closest('button');
        if (!button || !button.dataset.sort || !this.DOM.divToolbarTopLeft.contains(button)) return;

        this.sort(button.dataset.sort);
    }

    async stopDeepScanByUser() {
        return this.stopDeepScan({endReason: 'user-abort'});
    }

    async stopDeepScan({endReason = 'cancelled'} = {}) {
        if (this.#activityCounts.deepScan === 0 && !this.isDeepScanRunning) return false;

        const cancellation = this.cancelDeepScan({endReason});
        this.#scanGeneration += 1;
        this.#resetScanActivities();
        return cancellation;
    }

    get isDeepScanRunning() {
        return this.scanner.isDeepScanRunning;
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        return this.scanner.cancelDeepScan({endReason});
    }

    setDeepScanClientId(clientId) {
        this.scanner.setDeepScanClientId(clientId);
    }

    sort(criterion, initialDirection = null) {
        if (!['filename', 'type', 'size', 'dimensions'].includes(criterion)) return;

        const direction = initialDirection ?? (this.sortState.criterion === criterion &&
            this.sortState.direction === 'asc'
            ? 'desc'
            : 'asc');
        if (!['asc', 'desc'].includes(direction)) return;
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
        this.#updateSortButtons();
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

    async #showImage(item, scanGeneration = null) {
        if (scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) return;

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

                if ((scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) ||
                    this.selectedItem?.dataset.imageId !== imageId) return;
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
        this.updateDownloadTitles();

        if (image.fileSize === null &&
            image.source !== 'dataimages' &&
            image.source !== 'blobimages') {
            const fileInfo = await this.scanner.getFileInfo(item.dataset.url);

            if ((scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) ||
                this.selectedItem?.dataset.imageId !== imageId) return;

            image.fileSize = fileInfo?.size ?? null;
        }

        if ((scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) ||
            this.selectedItem?.dataset.imageId !== imageId) return;

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

            case 'defaultsettings':
                await this.resetSettingsToDefaults();
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

        this.DOM.divToolbarActions.hidden = !isOpen;
        this.DOM.btnDefaultSettings.disabled = isOpen;

        if (!isOpen) {
            await this.settingsForm?.refresh();
            return;
        }

        await this.settingsForm?.waitForPendingSave();
        this.updateDownloadTitles();
        if (this.settings.get('common', 'scanOnSettingsChanged', true)) {
            await this.scan();
        }
    }

    async resetSettingsToDefaults() {
        if (this.DOM.btnSettings.value !== 'true') return;

        await this.settingsForm?.waitForPendingSave();
        await this.settings.resetToDefaults();
        await this.settingsForm?.refresh();
        this.updateDownloadTitles();
    }

    clear({invalidateScan = true} = {}) {
        if (invalidateScan) {
            void this.scanner.cancelDeepScan();
            this.#scanGeneration += 1;
            this.#resetScanActivities();
        }

        this.candidates.clear();
        this.images.clear();
        this.analysisStore.clear();
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
        this.#updateLEDActivity();
    }

    startActivity(type, scanGeneration = null) {
        if (!Object.prototype.hasOwnProperty.call(this.#activityCounts, type)) return;
        if (scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) return;

        this.#activityCounts[type] += 1;
        this.#updateLEDActivity();
    }

    stopActivity(type, scanGeneration = null) {
        if (!Object.prototype.hasOwnProperty.call(this.#activityCounts, type)) return;
        if (scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) return;

        this.#activityCounts[type] = Math.max(0, this.#activityCounts[type] - 1);
        this.#updateLEDActivity();
    }

    async scan() {
        void this.scanner.cancelDeepScan();
        const scanGeneration = this.#scanGeneration + 1;
        this.#scanGeneration = scanGeneration;
        let scanCompleted = false;
        let scannerActivityActive = false;
        let deepScanActivityActive = false;

        this.#resetScanActivities();
        this.startActivity('scanner', scanGeneration);
        scannerActivityActive = true;
        try {
            this.clear({invalidateScan: false});
            this.sortState = {criterion: null, direction: 'asc'};
            this.#updateSortButtons();
            this.DOM.spnStatusBar.style.display = 'none';
            this.progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
            this.progressbar.reset();

            const scanResults = await this.scanner.scan({
                onStart: count => this.progressbar.show(count),
                onProgress: () => this.progressbar.update()
            });
            if (!this.#isCurrentScan(scanGeneration)) return;

            this.scanContext.setTab(this.scanner.currentTab);

            this.#setScanResults(scanResults);
            let visibleImagesUpdated = false;
            try {
                visibleImagesUpdated = await this.#refreshVisibleImages(scanGeneration, {
                    initialSort: true,
                    showFilteringProgress: true
                });
            } finally {
                this.#finishFilteringProgress();
            }
            if (!visibleImagesUpdated) return;
            scanCompleted = true;

            const allowBackgroundScan = this.settings.get('common', 'allowBackgroundScan', false);
            const canDeepScan = allowBackgroundScan === true &&
                this.scanContext.isScannable && Number.isInteger(this.scanContext.tabId);

            if (canDeepScan) {
                const deepScanTabId = this.scanContext.tabId;

                this.stopActivity('scanner', scanGeneration);
                scannerActivityActive = false;
                this.info = 'Image preview';
                this.startActivity('deepScan', scanGeneration);
                deepScanActivityActive = true;

                try {
                    await this.scanner.scanDeepImages(this.scanContext, async (
                        rawCandidates,
                        signal,
                        diagnostic = null
                    ) => {
                        if (signal?.aborted || !this.#isCurrentScan(scanGeneration)) {
                            return false;
                        }

                        const visibleImagesBefore = this.images.size;
                        const visibleURLsBefore = new Set(
                            Array.from(this.images.values(), (image) => image.url)
                        );
                        const {
                            newCandidates,
                            existingCandidatesUpdated,
                            existingCandidateUpgradeCount
                        } =
                            this.#getNewURLCandidates(rawCandidates);
                        if (newCandidates.length === 0 && !existingCandidatesUpdated) {
                            return diagnostic
                                ? {
                                    continue: true,
                                    imageFinderNewURLs: 0,
                                    acceptedCandidates: 0,
                                    existingUpgrades: 0,
                                    visibleImageDelta: 0,
                                    visibleNewURLs: 0,
                                    visibleWinnersFromBatch: 0,
                                    notVisibleAfterFiltering: 0,
                                    visibleImages: this.images.size
                                }
                                : true;
                        }

                        const candidates = newCandidates.length > 0
                            ? await this.scanner.createCandidates(newCandidates, deepScanTabId, {signal})
                            : [];
                        if (signal?.aborted || !this.#isCurrentScan(scanGeneration)) return false;
                        if (candidates.length === 0 && !existingCandidatesUpdated) {
                            return diagnostic
                                ? {
                                    continue: true,
                                    imageFinderNewURLs: newCandidates.length,
                                    acceptedCandidates: 0,
                                    existingUpgrades: 0,
                                    visibleImageDelta: 0,
                                    visibleNewURLs: 0,
                                    visibleWinnersFromBatch: 0,
                                    notVisibleAfterFiltering: 0,
                                    visibleImages: this.images.size
                                }
                                : true;
                        }

                        this.#setScanResults(candidates);
                        const visibleImagesUpdated = await this.#refreshVisibleImages(
                            scanGeneration
                        );

                        if (!diagnostic) return visibleImagesUpdated;

                        const visibleWinnersFromBatch = candidates.filter((candidate) =>
                            this.images.has(candidate.id)
                        ).length;
                        const visibleNewURLs = Array.from(this.images.values()).filter((candidate) =>
                            !visibleURLsBefore.has(candidate.url)
                        ).length;

                        return {
                            continue: visibleImagesUpdated,
                            imageFinderNewURLs: newCandidates.length,
                            acceptedCandidates: candidates.length,
                            existingUpgrades: existingCandidateUpgradeCount,
                            visibleImageDelta: this.images.size - visibleImagesBefore,
                            visibleNewURLs,
                            visibleWinnersFromBatch,
                            notVisibleAfterFiltering: candidates.length - visibleWinnersFromBatch,
                            visibleImages: this.images.size
                        };
                    });
                } catch (error) {
                    if (this.#isCurrentScan(scanGeneration)) {
                        console.warn('Cannot deep scan this page:', error);
                    }
                } finally {
                    this.stopActivity('deepScan', scanGeneration);
                    deepScanActivityActive = false;
                }
            }
        } catch (error) {
            if (this.#isCurrentScan(scanGeneration)) {
                console.warn('Cannot scan this page:', this.scanner.currentTab?.url);
                this.info = 'Page not allowed to scan!';
            }
        } finally {
            if (scannerActivityActive) this.stopActivity('scanner', scanGeneration);
            if (deepScanActivityActive) this.stopActivity('deepScan', scanGeneration);
            if (scanCompleted && this.#isCurrentScan(scanGeneration)) {
                this.info = this.images.size === 0 ? 'No images found!' : 'Image preview';
            }
        }
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

    getDownloadTarget() {
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

        const isAbsoluteUserFolder = userFolder.startsWith('/') || /^[A-Za-z]:\//.test(userFolder);
        const effectiveFolder = downloads.downloadFolder === 'user' && userFolder
            ? isAbsoluteUserFolder || !defaultFolder
                ? userFolder
                : `${defaultFolder}/${userFolder}`
            : '';

        return {
            relativeFolder,
            effectiveFolder,
            saveAs: downloads.downloadFolder !== 'user'
        };
    }

    getDownloadOptions(fileName) {
        const {relativeFolder, saveAs} = this.getDownloadTarget();

        return {
            filename: relativeFolder ? `${relativeFolder}/${fileName}` : fileName,
            saveAs
        };
    }

    getEffectiveDownloadFolder() {
        return this.getDownloadTarget().effectiveFolder;
    }

    updateDownloadTitles() {
        const folder = this.getEffectiveDownloadFolder();

        this.DOM.btnDownload.title = folder
            ? `Download image to: ${folder}`
            : 'Download image';
        this.DOM.btnSaveAll.title = folder
            ? `Save all images to: ${folder}`
            : 'Save all images';
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
        });
    }

    #isCurrentScan(scanGeneration) {
        return scanGeneration === this.#scanGeneration;
    }

    #resetScanActivities() {
        Object.keys(this.#activityCounts).forEach((type) => {
            this.#activityCounts[type] = 0;
        });
        this.#updateLEDActivity();
    }

    #getNewURLCandidates(rawCandidates) {
        if (!Array.isArray(rawCandidates)) {
            return {newCandidates: [], existingCandidatesUpdated: false};
        }

        const candidatesByURL = new Map();
        this.candidates.forEach((candidate) => {
            if (typeof candidate?.url !== 'string') return;

            const matchingCandidates = candidatesByURL.get(candidate.url) ?? [];
            matchingCandidates.push(candidate);
            candidatesByURL.set(candidate.url, matchingCandidates);
        });

        const newCandidatesByURL = new Map();
        let existingCandidatesUpdated = false;
        let existingCandidateUpgradeCount = 0;
        rawCandidates.forEach((candidate) => {
            if (typeof candidate?.url !== 'string' || !candidate.url) return;

            const matchingCandidates = candidatesByURL.get(candidate.url);
            if (matchingCandidates) {
                matchingCandidates.forEach((existingCandidate) => {
                    if (candidate.visuallyBlurred === false) {
                        existingCandidate.visuallyBlurred = false;
                    }
                    if (this.#getPixelCount(candidate) <= this.#getPixelCount(existingCandidate)) {
                        return;
                    }

                    existingCandidate.width = candidate.width;
                    existingCandidate.height = candidate.height;
                    existingCandidatesUpdated = true;
                    existingCandidateUpgradeCount += 1;
                });
                return;
            }

            const alreadyAddedCandidate = newCandidatesByURL.get(candidate.url);
            if (alreadyAddedCandidate) {
                if (candidate.visuallyBlurred === false) {
                    alreadyAddedCandidate.visuallyBlurred = false;
                }
                if (this.#getPixelCount(candidate) > this.#getPixelCount(alreadyAddedCandidate)) {
                    newCandidatesByURL.set(candidate.url, {
                        ...candidate,
                        visuallyBlurred: alreadyAddedCandidate.visuallyBlurred === false
                            ? false
                            : candidate.visuallyBlurred === true
                    });
                }
                return;
            }

            newCandidatesByURL.set(candidate.url, candidate);
        });

        return {
            newCandidates: Array.from(newCandidatesByURL.values()),
            existingCandidatesUpdated,
            existingCandidateUpgradeCount
        };
    }

    #captureRenderState() {
        const selectedItem = this.selectedItem;

        return {
            selectedImageId: selectedItem?.dataset.imageId ?? null,
            selectedImageURL: selectedItem?.dataset.url ?? null,
            savedImageIds: new Set(
                this.listItems
                    .filter(item => item.classList.contains('saved'))
                    .map(item => item.dataset.imageId)
            )
        };
    }

    #renderImages(renderState) {
        let selectedItem = null;
        let selectedItemByURL = null;

        this.DOM.lstImages.innerHTML = '';
        this.images.forEach((image, imageId) => {
            const item = document.createElement('li');

            item.textContent = image.fileName;
            item.title = image.fileName;
            item.dataset.imageId = imageId;
            item.dataset.url = image.url;
            if (renderState.savedImageIds.has(imageId)) item.classList.add('saved');
            if (imageId === renderState.selectedImageId) selectedItem = item;
            if (!selectedItemByURL && image.url === renderState.selectedImageURL) {
                selectedItemByURL = item;
            }

            this.DOM.lstImages.appendChild(item);
        });

        selectedItem ??= selectedItemByURL;
        if (selectedItem) {
            selectedItem.classList.add('selected');
        } else if (renderState.selectedImageId) {
            this.currentBlobPreview = null;
            this.DOM.imgPreview.removeAttribute('src');
            this.DOM.h2_Preview.style.display = 'block';
            this.DOM.spnStatusBar.style.display = 'none';
            this.DOM.btnDownload.disabled = true;
            this.DOM.btnDelete.disabled = true;
        }

        return selectedItem;
    }

    async #refreshVisibleImages(
        scanGeneration,
        {initialSort = false, showFilteringProgress = false} = {}
    ) {
        const visibleImagesUpdated = await this.#setVisibleImages(scanGeneration, {
            showFilteringProgress
        });
        if (!visibleImagesUpdated || !this.#isCurrentScan(scanGeneration)) return false;

        const renderState = this.#captureRenderState();
        const selectedItem = this.#renderImages(renderState);
        if (!this.#isCurrentScan(scanGeneration)) return false;

        if (initialSort) {
            this.sort('dimensions', 'desc');
        } else if (this.sortState.criterion) {
            this.sort(this.sortState.criterion, this.sortState.direction);
        }

        this.#updateImageListState();
        if (selectedItem && selectedItem.dataset.imageId !== renderState.selectedImageId) {
            try {
                await this.#showImage(selectedItem, scanGeneration);
            } catch (error) {
                console.warn('Cannot show replacement image:', selectedItem.dataset.url, error);
            }
        }

        return this.#isCurrentScan(scanGeneration);
    }

    #updateImageListState() {
        this.DOM.btnSaveAll.disabled = this.isSavingAll || this.images.size === 0;
        this.DOM.btnClear.disabled = this.images.size === 0;
        this.#updateLED();
    }

    #createFilteringProgress(candidates) {
        const filters = this.settings.get('filters') ?? {};
        const runsBlurScanner = filters.ignoreBlurredImages === true && candidates.length > 0;
        const runsImageMatcher = filters.ignoreDuplicates === true && candidates.length >= 2;
        const stages = [
            ...(runsBlurScanner ? ['blurScanner'] : []),
            ...(runsImageMatcher ? ['matcher'] : [])
        ];

        if (stages.length === 0) return null;

        this.progressbar.backgroundColor = FILTER_PROGRESS_COLOR;
        this.progressbar.show(100);

        const progressByStage = Object.fromEntries(stages.map((stage, index) => [
            stage,
            {
                start: index * 100 / stages.length,
                span: 100 / stages.length
            }
        ]));
        const updateStage = (stage, completed, total) => {
            if (!Number.isFinite(total) || total <= 0) return;

            const progress = progressByStage[stage];
            if (!progress) return;

            this.progressbar.setValue(
                progress.start + progress.span * Math.min(1, completed / total)
            );
        };

        return {
            onBlurProgress: (completed, total) => updateStage('blurScanner', completed, total),
            onMatcherProgress: (completed, total) => updateStage('matcher', completed, total)
        };
    }

    #finishFilteringProgress() {
        this.progressbar.setValue(this.progressbar.max);
        this.progressbar.hide();
        this.progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
    }

    async #setVisibleImages(scanGeneration, {showFilteringProgress = false} = {}) {
        const candidates = Array.from(this.candidates);
        const filteringProgress = showFilteringProgress
            ? this.#createFilteringProgress(candidates)
            : null;
        const blurAcceptedCandidates = await this.#getBlurAcceptedCandidates(
            candidates,
            scanGeneration,
            filteringProgress?.onBlurProgress
        );
        if (!blurAcceptedCandidates || !this.#isCurrentScan(scanGeneration)) return false;

        const visibleCandidates = await this.#getDuplicateWinners(
            blurAcceptedCandidates,
            scanGeneration,
            filteringProgress?.onMatcherProgress
        );
        if (!visibleCandidates || !this.#isCurrentScan(scanGeneration)) return false;

        this.images.clear();
        visibleCandidates.forEach(([candidateId, candidate]) => {
            this.images.set(candidateId, candidate);
        });

        return true;
    }

    async #getBlurAcceptedCandidates(candidates, scanGeneration, onProgress = null) {
        const filters = this.settings.get('filters') ?? {};

        if (filters.ignoreBlurredImages !== true) return candidates;

        const acceptedCandidateIds = new Set();

        if (candidates.length === 0) return candidates;

        this.startActivity('blurScanner', scanGeneration);
        try {
            for (let index = 0; index < candidates.length; index++) {
                const [candidateId, candidate] = candidates[index];
                if (!this.#isCurrentScan(scanGeneration)) return null;

                try {
                    const measurement = await this.blurScanner.measure(candidate.url, candidateId);
                    const classification = this.blurScanner.classify(measurement);

                    if (classification !== 'blurred') {
                        acceptedCandidateIds.add(candidateId);
                    }
                } catch (error) {
                    console.warn('Cannot analyze image blur:', candidate.url, error);
                    acceptedCandidateIds.add(candidateId);
                }

                onProgress?.(index + 1, candidates.length);
            }
        } finally {
            this.stopActivity('blurScanner', scanGeneration);
        }

        return candidates.filter(([candidateId]) => acceptedCandidateIds.has(candidateId));
    }

    async #getDuplicateWinners(acceptedCandidates, scanGeneration, onProgress = null) {
        const filters = this.settings.get('filters') ?? {};

        if (filters.ignoreDuplicates !== true || acceptedCandidates.length < 2) {
            return acceptedCandidates;
        }

        this.startActivity('matcher', scanGeneration);
        try {
            const duplicateGroups = [];

            for (let index = 0; index < acceptedCandidates.length; index++) {
                const candidateEntry = acceptedCandidates[index];
                if (!this.#isCurrentScan(scanGeneration)) return null;

                const matchingGroups = [];

                for (const group of duplicateGroups) {
                    if (await this.#matchesDuplicateGroup(candidateEntry, group)) {
                        matchingGroups.push(group);
                    }
                }

                if (matchingGroups.length === 0) {
                    duplicateGroups.push([candidateEntry]);
                } else {
                    const [targetGroup, ...groupsToMerge] = matchingGroups;

                    targetGroup.push(candidateEntry);
                    groupsToMerge.forEach((group) => {
                        targetGroup.push(...group);
                        duplicateGroups.splice(duplicateGroups.indexOf(group), 1);
                    });
                }

                onProgress?.(index + 1, acceptedCandidates.length);
            }

            return duplicateGroups.map(group => this.#selectDuplicateWinner(group));
        } finally {
            this.stopActivity('matcher', scanGeneration);
        }
    }

    async #matchesDuplicateGroup([candidateId, candidate], group) {
        for (const [groupCandidateId, groupCandidate] of group) {
            if (candidate.url === groupCandidate.url) {
                if (candidate.visuallyBlurred === false) {
                    groupCandidate.visuallyBlurred = false;
                }
                return true;
            }

            try {
                const comparison = await this.imageMatcher.compare(
                    candidate.url,
                    candidateId,
                    groupCandidate.url,
                    groupCandidateId
                );

                if (this.imageMatcher.isStrictMatch(comparison)) return true;
            } catch (error) {
                console.error(
                    'Cannot compare possible duplicate images:',
                    candidate.url,
                    groupCandidate.url,
                    error
                );
            }
        }

        return false;
    }

    #selectDuplicateWinner(group) {
        return group.reduce((winner, candidateEntry) =>
            this.#getPixelCount(candidateEntry[1]) > this.#getPixelCount(winner[1])
                ? candidateEntry
                : winner
        );
    }

    #getPixelCount(candidate) {
        const width = Number(candidate?.width);
        const height = Number(candidate?.height);

        return Number.isFinite(width) && Number.isFinite(height)
            ? Math.max(0, width) * Math.max(0, height)
            : 0;
    }

    #updateLED() {
        this.DOM.divLED.textContent = this.images.size;
    }

    #updateSortButtons() {
        this.DOM.divToolbarTopLeft.querySelectorAll('button[data-sort]').forEach(sortButton => {
            const criterion = sortButton.dataset.sort;
            const isActive = criterion === this.sortState.criterion;
            const iconBaseName = SORT_ICON_BASE_NAMES[criterion];
            const icon = sortButton.querySelector('img');

            sortButton.classList.toggle('sorted', isActive);
            if (!icon || !iconBaseName) return;

            const direction = isActive ? this.sortState.direction : 'asc';
            icon.setAttribute('src', `../assets/icons/${iconBaseName}-${direction}.png`);
        });
    }

    #updateLEDActivity() {
        const activity = this.#activityCounts.deepScan > 0
            ? 'deepScan'
            : this.#activityCounts.blurScanner > 0
                ? 'blurScanner'
                : this.#activityCounts.matcher > 0
                    ? 'matcher'
                    : this.#activityCounts.scanner > 0
                        ? 'scanner'
                        : 'none';

        this.DOM.divLED.classList.toggle('active', activity !== 'none');
        this.DOM.divLED.classList.toggle('flash-led', activity === 'deepScan');
        this.DOM.divLED.dataset.activity = activity;
        if (activity === 'deepScan') {
            this.DOM.divLED.title = 'Deep scan running...';
        } else if (activity === 'none') {
            this.DOM.divLED.title = `Images found: ${this.images.size}`;
        } else {
            this.DOM.divLED.removeAttribute('title');
        }
        this.#updateDeepScanStopButton();

        if (activity === 'scanner') {
            this.info = 'Scanning...';
        } else if (activity === 'blurScanner' || activity === 'matcher') {
            this.info = 'Filtering list...';
        }
    }

    #updateDeepScanStopButton() {
        const button = this.DOM.btnStopDeepScan;
        if (!button) return;

        const deepScanIsRunning = this.#activityCounts.deepScan > 0;
        button.hidden = !deepScanIsRunning;
        button.disabled = !deepScanIsRunning;
    }
}
