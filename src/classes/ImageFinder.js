import { Settings } from './Settings.js';
import ImageScanner from './ImageScanner.js';
import { MediaType } from './MediaType.js';
import Progressbar from './Progressbar.js';
import Analyzer from './Analyzer.js';
import ResultStore from './ResultStore.js';
import { ScanContext } from './ScanContext.js';
import { getAddonVersionName } from '../addon-info.js';

const SORT_BUTTON_TITLES = Object.freeze({
    filename: 'Sort by filename',
    type: 'Sort by image type',
    size: 'Sort by file size',
    dimensions: 'Sort by dimensions',
    cronologic: 'Sort chronologically'
});
const SORT_DIRECTION_TITLES = Object.freeze({
    asc: 'ascending',
    desc: 'descending'
});
const REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY = 'reopenPopupAfterRestart';
// ✏️ EDIT 2026-10-05: Resolve progress colors through theme variables.
const SCAN_PROGRESS_COLOR = 'var(--adn-progressbar-bg-scan, #32CD32)';
const FILTER_PROGRESS_COLOR = 'var(--adn-progressbar-bg-filter, tomato)';
export class ImageFinder {
    #activityCounts = {
        scanner: 0,
        duplicateFinder: 0,
        blurScanner: 0,
        deepScan: 0
    };
    #scanGeneration = 0;
    #deepScanTitleInterval = null;
    #scanController = null;

    #deepScanStartedAt = null;
    get deepScanElapsedTime() {
        if (this.#deepScanStartedAt === null) return '0:00';
        const seconds = Math.max(0, Math.floor((Date.now() - this.#deepScanStartedAt) / 1000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    get selectedItem() {
        return this.DOM.lstImages.querySelector('.selected') || null;
    }

    get selectedImage() {
        const imageId = this.selectedItem?.dataset.imageId;
        return imageId ? this.images.get(imageId) ?? null : null;
    }

    get candidates() {
        return this.resultStore.candidates;
    }

    get images() {
        return this.resultStore.images;
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
        this.resultStore = new ResultStore();
        this.analyzer = new Analyzer();
        this.progressbar = new Progressbar(this.DOM.divProgressbar);
        this.settingsPanel = null;
        this.isSavingAll = false;
        this.currentBlobPreview = null;
        window.chrome?.downloads?.onChanged?.addListener((delta) => {
            this.#handleDownloadChanged(delta);
        });
        window.addEventListener('pagehide', () => this.#stopDeepScanTitleTimer(), {once: true});
        this.#showAddonVersion();
        this.#updateLED();
        this.#updateLEDActivity();

        console.dir(this)
    }

    async run(onSettingsReady = null) {
        await this.setWebsiteURLFromActiveTab();
        await this.settings.run();
        this.#applyThemeMode();
        if (typeof onSettingsReady === 'function') await onSettingsReady();
        this.updateDownloadTitles();
        this.setEventListeners();
        if (this.settings.get('common', 'scanOnStart', true)) await this.scan();
    }

    setSettingsPanel(settingsPanel) {
        this.settingsPanel = settingsPanel;
    }

    async setWebsiteURLFromActiveTab() {
        try {
            const [tab] = await window.chrome.tabs.query({
                active: true,
                currentWindow: true
            });

            this.scanContext.tab = tab;
            this.settings.websiteURL = tab?.url;
        } catch {
            this.scanContext.clear();
            this.settings.websiteURL = null;
        }
    }

    setEventListeners() {
        this.DOM.divToolbar.addEventListener('click', e => this.onButtonClick(e));
        this.DOM.divToolbarTopLeft.addEventListener('click', e => this.onSortButtonClick(e));
        this.DOM.lstImages.addEventListener('click', e => this.onListItemClick(e));
        this.DOM.lstImages.addEventListener('keydown', e => this.onKeyPress(e));
        this.DOM.chkTheme?.addEventListener('change', () => {
            void this.#setThemeMode(this.DOM.chkTheme.checked ? 'dark' : 'light');
        });
        document.addEventListener('keydown', e => {
            this.#onSettingsKeyDown(e);
        }, true);
    }

    onSortButtonClick(e) {
        const button = e.target.closest('button');
        if (!button || !button.dataset.sort || !this.DOM.divToolbarTopLeft.contains(button)) return;

        this.sort(button.dataset.sort);
    }

    async stopDeepScan({endReason = 'cancelled'} = {}) {
        if (this.#activityCounts.deepScan === 0 && !this.isDeepScanRunning) return false;

        return this.stopScan({endReason});
    }

    async stopScan({endReason = 'user-abort'} = {}) {
        if (!this.isScanRunning) return false;

        this.#scanGeneration += 1;
        this.#scanController?.abort();
        this.#scanController = null;
        this.#resetScanActivities();
        this.#setSearchButtonActive(false);
        this.info = 'Image preview';
        await this.cancelDeepScan({endReason});
        return true;
    }

    get isDeepScanRunning() {
        return this.scanner.isDeepScanRunning;
    }

    get isScanRunning() {
        return this.#scanController !== null || this.isDeepScanRunning ||
            Object.values(this.#activityCounts).some((count) => count > 0) ||
            this.DOM.btnSearch?.value === 'true';
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        return this.scanner.cancelDeepScan({endReason});
    }

    setDeepScanClientId(clientId) {
        this.scanner.setDeepScanClientId(clientId);
    }

    sort(criterion, initialDirection = null) {
        if (!['filename', 'type', 'size', 'dimensions', 'cronologic'].includes(criterion)) return;

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

                case 'cronologic':
                    comparison = first.discoveryOrder - second.discoveryOrder;
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
        this.#updateOpenDownloadFolderButton();

        item.scrollIntoView({ block: 'nearest' });
        await this.#showImage(item);
    }

    async #showImage(item, scanGeneration = null) {
        if (scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) return;

        const imageId = item?.dataset.imageId;
        const image = imageId ? this.images.get(imageId) ?? null : null;
        if (!image) return;

        this.#updateOpenDownloadFolderButton();

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
        this.DOM.spnStatusBar.style.display = 'none';
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
        const mediaType = MediaType.getType(image.imageType);
        const icon = mediaType?.icon ?? '../assets/icons/icon512.png';
        const mediaTypeName = mediaType?.type ?? image.mediaType ?? 'image';
        const dims = `${image.width} × ${image.height} px`;
        this.statusBar = `
            <img id="imgTypeInfoIcon" src="${icon}" alt="${image.imageType}" style="height: 1.25rem;" title="${image.imageType.toUpperCase()} ${mediaTypeName}, Resolution: ${dims}, Size: ${size}${exactSize}">
               ${dims} [${size}]`;
        this.DOM.spnStatusBar.style.display = 'flex';
    }

    async onListItemClick(e) {
        const item = e.target.closest('li');
        if (!item) return;

        this.info = 'Image preview';
        this.selectedItem?.classList.remove('selected');
        item.classList.add('selected');
        this.DOM.lstImages.focus();
        this.#updateOpenDownloadFolderButton();

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
                if (this.DOM.btnSearch.value === 'true') {
                    await this.stopScan({endReason: 'user-abort'});
                } else {
                    await this.scan();
                }
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

            case 'opendownloadfolder':
                await this.openSelectedDownloadFolder();
                break;

            case 'delete':
                this.deleteImage(item);
                break;

            case 'clear':
                this.clear();
                break;

            case 'tabreload':
                await this.reloadCurrentTab();
                break;

            case 'restart':
                await this.#restartExtension();
                break;

            default:
                break;
        }
    }

    async #restartExtension() {
        try {
            await window.chrome.storage.local.set({
                [REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY]: Date.now()
            });
        } catch (error) {
            console.warn('[Restart] Cannot schedule popup reopening after restart:', error);
        }

        window.chrome.runtime.reload();
    }

    async toggleSettingsPanel() {
        if (this.#isSettingsPanelOpen()) {
            await this.#closeSettingsPanel();
            return;
        }

        await this.#openSettingsPanel();
    }

    async #openSettingsPanel() {
        await this.stopScan({endReason: 'settings-open'});

        this.DOM.btnSettings.value = 'true';
        this.DOM.divSettingsPanel.classList.add('open');
        this.DOM.divToolbarActions.hidden = true;
        this.DOM.divProgressbar.hidden = true;
        this.DOM.spnStatusBar.hidden = true;
        this.DOM.btnRestart.hidden = false;
        this.DOM.btnDefaultSettings.hidden = false;
        this.DOM.btnDefaultSettings.disabled = false;

        await this.settingsPanel?.refresh();
    }

    async #closeSettingsPanel() {
        if (!this.#isSettingsPanelOpen()) return;

        this.DOM.btnSettings.value = 'false';
        this.DOM.divSettingsPanel.classList.remove('open');
        this.DOM.divToolbarActions.hidden = false;
        this.DOM.divProgressbar.hidden = false;
        this.DOM.spnStatusBar.hidden = false;
        this.#showAddonVersion();
        this.DOM.btnRestart.hidden = true;
        this.DOM.btnDefaultSettings.hidden = true;
        this.DOM.btnDefaultSettings.disabled = true;

        await this.settingsPanel?.waitForPendingSave();
        this.updateDownloadTitles();
        this.#updateLEDActivity();
    }

    #isSettingsPanelOpen() {
        return this.DOM.btnSettings.value === 'true';
    }

    #onSettingsKeyDown(event) {
        if (!this.#isSettingsPanelOpen() || event.key !== 'Enter' || event.isComposing) return;

        event.preventDefault();
        event.stopPropagation();
        void this.#closeSettingsPanel();
    }

    async resetSettingsToDefaults() {
        if (this.DOM.btnSettings.value !== 'true') return;

        await this.settingsPanel?.waitForPendingSave();
        await this.settings.resetToDefaults();
        this.#applyThemeMode();
        await this.settingsPanel?.refresh();
        this.updateDownloadTitles();
    }

    #applyThemeMode(mode = this.settings.getThemeMode()) {
        const themeMode = mode === 'dark' ? 'dark' : 'light';

        document.documentElement.dataset.mode = themeMode;
        if (this.DOM.chkTheme) this.DOM.chkTheme.checked = themeMode === 'dark';
    }

    async #setThemeMode(mode) {
        const themeMode = mode === 'dark' ? 'dark' : 'light';

        this.#applyThemeMode(themeMode);

        try {
            await this.settings.setThemeMode(themeMode);
        } catch (error) {
            console.warn('Cannot save theme mode:', error);
        }
    }

    async reloadCurrentTab() {
        await this.stopScan({endReason: 'tab-reload'});

        await window.chrome.tabs.reload();
    }

    clear({invalidateScan = true} = {}) {
        if (invalidateScan) {
            void this.scanner.cancelDeepScan();
            this.#scanGeneration += 1;
            this.#scanController?.abort();
            this.#scanController = null;
            this.#resetScanActivities();
            this.#setSearchButtonActive(false);
        }

        this.resultStore.clear();
        this.analyzer.clear();
        this.currentBlobPreview = null;
        this.DOM.lstImages.innerHTML = '';
        this.DOM.imgPreview.removeAttribute('src');
        this.DOM.h2_Preview.style.display = 'block';
        this.info = 'Image preview';
        this.#showAddonVersion();
        this.DOM.btnDownload.disabled = true;
        this.DOM.btnSaveAll.disabled = true;
        this.DOM.btnDelete.disabled = true;
        this.DOM.btnClear.disabled = true;
        this.#updateOpenDownloadFolderButton();
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
        this.#scanController?.abort();
        const scanController = new AbortController();
        this.#scanController = scanController;
        const scanGeneration = this.#scanGeneration + 1;
        this.#scanGeneration = scanGeneration;
        this.#setSearchButtonActive(true);
        let scanCompleted = false;
        let scannerActivityActive = false;
        let deepScanActivityActive = false;
        let deepScanStarted = false;
        let deepScanCompletionInfo = null;
        let deepScanInitialVisibleImages = 0;
        let deepScanInitialCandidates = 0;
        let deepScanCandidateCount = 0;
        let deepScanFailed = false;

        this.#resetScanActivities();
        this.startActivity('scanner', scanGeneration);
        scannerActivityActive = true;
        try {
            this.clear({invalidateScan: false});
            this.sortState = {criterion: null, direction: 'asc'};
            this.#updateSortButtons();
            this.#showAddonVersion();
            this.progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
            this.progressbar.reset();

            const scanResults = await this.scanner.scan({
                onStart: count => this.#showProgressbar(count),
                onProgress: () => this.progressbar.update(),
                signal: scanController.signal
            });
            if (!this.#isCurrentScan(scanGeneration)) return;

            this.scanContext.tab = this.scanner.currentTab;

            this.resultStore.addCandidates(scanResults);
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

                deepScanStarted = true;
                deepScanInitialVisibleImages = this.images.size;
                deepScanInitialCandidates = this.candidates.size;
                this.stopActivity('scanner', scanGeneration);
                scannerActivityActive = false;
                this.info = 'Image preview';
                this.startActivity('deepScan', scanGeneration);
                deepScanActivityActive = true;

                try {
                    const deepScanCandidates = await this.scanner.scanDeepImages(this.scanContext, async (
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
                            this.resultStore.getNewURLCandidates(rawCandidates);
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

                        this.resultStore.addCandidates(candidates, {markerOrigin: 'deepScan'});
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
                    deepScanCandidateCount = deepScanCandidates.length;
                } catch (error) {
                    if (this.#isCurrentScan(scanGeneration)) {
                        console.warn('Cannot deep scan this page:', error);
                    }
                    deepScanFailed = true;
                } finally {
                    deepScanCompletionInfo = this.#deepScanStartedAt === null ? null
                        : `Deep scan completed after ${this.deepScanElapsedTime}`;
                    if (this.#isCurrentScan(scanGeneration)) {
                        console.info('[DeepScan RESULT]', {
                            status: deepScanFailed ? 'failed' : 'completed',
                            deepScanCandidates: deepScanCandidateCount,
                            visibleImages: this.images.size,
                            newVisibleImages: Math.max(
                                0,
                                this.images.size - deepScanInitialVisibleImages
                            ),
                            candidates: this.candidates.size,
                            newCandidates: Math.max(
                                0,
                                this.candidates.size - deepScanInitialCandidates
                            )
                        });
                    }
                    this.stopActivity('deepScan', scanGeneration);
                    deepScanActivityActive = false;
                    this.#finalizeDeepScanUI(scanGeneration);
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
                this.info = deepScanStarted
                    ? deepScanCompletionInfo ?? 'Image preview'
                    : this.images.size > 0
                        ? 'Image preview'
                        : 'No images found!';
            }
            this.#finalizeDeepScanUI(scanGeneration);
            if (this.#isCurrentScan(scanGeneration)) {
                this.#hideProgressbar();
                if (this.#scanController === scanController) {
                    this.#scanController = null;
                }
                this.#setSearchButtonActive(false);
            }
        }
    }

    async saveImage(item) {
        const image = this.selectedImage;
        if (!item || !image) return;

        try {
            const downloadId = await this.downloadImage(image);
            this.#trackDownload(item.dataset.imageId, downloadId);
        } catch (error) {
            console.warn('Cannot download image:', image.url, error);
            this.#updateOpenDownloadFolderButton();
        }
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
                this.#trackDownload(result.imageId, result.downloadId);
                if (!item) continue;
            }
        } catch (error) {
            console.warn('Cannot download image list:', error);
        } finally {
            this.isSavingAll = false;
            this.DOM.btnSaveAll.disabled = (this.images.size === 0);
            this.#updateOpenDownloadFolderButton();
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
        this.#updateOpenDownloadFolderButton();
    }

    async openSelectedDownloadFolder() {
        const imageId = this.selectedItem?.dataset.imageId;
        const download = imageId ? this.resultStore.getDownload(imageId) : null;
        if (!imageId || !download?.completed || !Number.isInteger(download.downloadId)) {
            this.#updateOpenDownloadFolderButton();
            return;
        }

        try {
            const downloads = await window.chrome.downloads.search({id: download.downloadId});
            if (downloads[0]?.state !== 'complete') {
                this.#setDownloadState(imageId, download.downloadId, downloads[0]?.state ?? 'failed');
                return;
            }

            await window.chrome.downloads.show(download.downloadId);
        } catch (error) {
            console.warn('Cannot open download folder:', error);
            this.#setDownloadState(imageId, download.downloadId, 'failed');
        }
    }

    deleteImage(item) {
        if (!item) return;

        if (this.currentBlobPreview?.imageId === item.dataset.imageId) {
            this.currentBlobPreview = null;
        }

        this.resultStore.deleteResult(item.dataset.imageId);
        item.remove();

        this.DOM.imgPreview.removeAttribute('src');
        this.DOM.h2_Preview.style.display = 'block';
        this.#showAddonVersion();
        if (this.#activityCounts.deepScan > 0) this.#updateDeepScanTitle();
        this.DOM.btnDownload.disabled = true;
        this.DOM.btnDelete.disabled = true;
        this.DOM.btnSaveAll.disabled = (this.images.size === 0);
        this.DOM.btnClear.disabled = (this.images.size === 0);
        this.#updateOpenDownloadFolderButton();
        this.#updateLED();
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

    #setSearchButtonActive(active) {
        const button = this.DOM.btnSearch;
        const isActive = active === true;

        button.value = isActive ? 'true' : 'false';
        button.title = isActive ? 'Stop scan' : 'Find images';
        button.setAttribute('aria-label', button.title);
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
            const marker = document.createElement('span');
            const label = document.createElement('span');

            item.title = image.fileName;
            item.dataset.imageId = imageId;
            item.dataset.url = image.url;
            marker.className = 'result-marker';
            marker.dataset.state = this.resultStore.getVisibleResultMarkerState(
                imageId,
                image,
                renderState.savedImageIds
            );
            marker.setAttribute('aria-hidden', 'true');
            label.className = 'result-label';
            label.textContent = image.fileName;
            item.append(marker, label);
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
            this.#showAddonVersion();
            this.DOM.btnDownload.disabled = true;
            this.DOM.btnDelete.disabled = true;
        }

        this.#updateOpenDownloadFolderButton();

        return selectedItem;
    }

    async #refreshVisibleImages(scanGeneration, {initialSort = false, showFilteringProgress = false} = {}) {
        const visibleImagesUpdated = await this.#setVisibleImages(scanGeneration, {
            showFilteringProgress
        });
        if (!visibleImagesUpdated || !this.#isCurrentScan(scanGeneration)) return false;

        const renderState = this.#captureRenderState();
        const selectedItem = this.#renderImages(renderState);
        if (!this.#isCurrentScan(scanGeneration)) return false;

        if (initialSort && !this.sortState.criterion) {
            this.sort('cronologic', 'asc');
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
        this.#updateOpenDownloadFolderButton();
        this.#updateLED();
    }

    #createFilteringProgress(candidates) {
        const filters = this.settings.get('filters') ?? {};
        const runsBlurScanner = filters.ignoreBlurredImages === true && candidates.length > 0;
        const runsDuplicateFinder = filters.ignoreDuplicates === true && candidates.length >= 2;
        const stages = [
            ...(runsBlurScanner ? ['blurScanner'] : []),
            ...(runsDuplicateFinder ? ['duplicateFinder'] : [])
        ];

        if (stages.length === 0) return null;

        this.progressbar.backgroundColor = FILTER_PROGRESS_COLOR;
        this.#showProgressbar(100);

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
            onDuplicateFinderProgress: (completed, total) => updateStage('duplicateFinder', completed, total)
        };
    }

    #finishFilteringProgress() {
        this.progressbar.setValue(this.progressbar.max);
        this.#hideProgressbar();
        this.progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
    }

    #showProgressbar(max) {
        this.DOM.spnStatusBar.style.display = 'none';
        this.progressbar.show(max);
    }

    #hideProgressbar() {
        this.progressbar.hide();
        this.#showAddonVersion();
    }

    async #setVisibleImages(scanGeneration, {showFilteringProgress = false} = {}) {
        const previousVisibleImageIds = new Set(this.images.keys());
        const candidates = Array.from(this.candidates);
        const filteringProgress = showFilteringProgress
            ? this.#createFilteringProgress(candidates)
            : null;
        const analyzedCandidates = await this.analyzer.filterCandidates(candidates, {
            filters: this.settings.get('filters') ?? {},
            previousVisibleImageIds,
            isCurrent: () => this.#isCurrentScan(scanGeneration),
            onActivityChange: (activity, isActive) => {
                if (isActive) {
                    this.startActivity(activity, scanGeneration);
                } else {
                    this.stopActivity(activity, scanGeneration);
                }
            },
            onBlurProgress: filteringProgress?.onBlurProgress,
            onDuplicateFinderProgress: filteringProgress?.onDuplicateFinderProgress
        });
        if (!analyzedCandidates || !this.#isCurrentScan(scanGeneration)) return false;

        const visibleCandidates = analyzedCandidates.map(({
            candidateEntry,
            replacesExistingResult
        }) => {
            this.resultStore.resolvePendingResultMarker(candidateEntry, replacesExistingResult);
            return candidateEntry;
        });

        this.resultStore.replaceVisibleResults(visibleCandidates);

        return true;
    }

    #updateLED() {
        this.DOM.divLED.textContent = this.images.size;
    }

    #trackDownload(imageId, downloadId) {
        if (!imageId || !Number.isInteger(downloadId)) return;

        if (!this.resultStore.trackDownload(imageId, downloadId)) return;
        this.#updateOpenDownloadFolderButton();
        void this.#refreshDownloadState(imageId, downloadId);
    }

    async #refreshDownloadState(imageId, downloadId) {
        try {
            const downloads = await window.chrome.downloads.search({id: downloadId});
            this.#setDownloadState(imageId, downloadId, downloads[0]?.state ?? 'failed');
        } catch (error) {
            console.warn('Cannot read download status:', error);
            this.#setDownloadState(imageId, downloadId, 'failed');
        }
    }

    #handleDownloadChanged(delta) {
        const state = delta?.state?.current;
        if (!Number.isInteger(delta?.id) || !state) return;

        this.resultStore.getImageIdsForDownload(delta.id).forEach((imageId) => {
            this.#setDownloadState(imageId, delta.id, state);
        });
    }

    #setDownloadState(imageId, downloadId, state) {
        const download = this.resultStore.updateDownloadState(imageId, downloadId, state);
        if (!download) return;

        const completed = download.completed;

        const item = this.listItems.find(li => li.dataset.imageId === imageId);
        if (completed) {
            item?.classList.add('saved');
            const marker = item?.querySelector('.result-marker');
            if (marker) marker.dataset.state = 'downloaded';
        }
        if (this.selectedItem === item) {
            this.DOM.btnDownload.disabled = this.downloadButtonState && completed;
        }
        this.#updateOpenDownloadFolderButton();
    }

    #updateOpenDownloadFolderButton() {
        const button = this.DOM.btnOpenDownloadFolder;
        if (!button) return;

        const imageId = this.selectedItem?.dataset.imageId;
        const download = imageId ? this.resultStore.getDownload(imageId) : null;
        button.disabled = !(
            Number.isInteger(download?.downloadId) && download.completed === true
        );
    }

    #showAddonVersion() {
        if (this.selectedItem) return;

        this.DOM.spnStatusBar.textContent = `Image Finder – ${getAddonVersionName()}`;
        this.DOM.spnStatusBar.style.display = 'flex';
    }

    #finalizeDeepScanUI(scanGeneration) {
        if (!this.#isCurrentScan(scanGeneration) || this.#activityCounts.deepScan > 0) return;

        this.#updateLEDActivity();
    }

    #updateSortButtons() {
        this.DOM.divToolbarTopLeft.querySelectorAll('button[data-sort]').forEach(sortButton => {
            const criterion = sortButton.dataset.sort;
            const isActive = criterion === this.sortState.criterion;
            const title = SORT_BUTTON_TITLES[criterion];

            sortButton.classList.toggle('sorted', isActive);
            if (!title) return;

            const direction = isActive ? this.sortState.direction : 'asc';
            sortButton.value = direction;
            sortButton.title = isActive
                ? `${title} ${SORT_DIRECTION_TITLES[direction]}`
                : title;
        });
    }

    #updateLEDActivity() {
        const activity = this.#activityCounts.deepScan > 0
            ? 'deepScan'
            : this.#activityCounts.blurScanner > 0
                ? 'blurScanner'
            : this.#activityCounts.duplicateFinder > 0
                ? 'duplicateFinder'
                    : this.#activityCounts.scanner > 0
                        ? 'scanner'
                        : 'none';

        this.DOM.divLED.classList.toggle('active', activity !== 'none');
        this.DOM.divLED.classList.toggle('flash-led', activity === 'deepScan');
        this.DOM.divLED.dataset.activity = activity;
        if (activity === 'deepScan') {
            if (this.#deepScanStartedAt === null) this.#startDeepScanTitleTimer();
            this.#updateDeepScanTitle();
        } else if (activity === 'none') {
            this.#stopDeepScanTitleTimer();
            this.DOM.divLED.title = `Images found: ${this.images.size}`;
        } else {
            this.#stopDeepScanTitleTimer();
            this.DOM.divLED.removeAttribute('title');
        }
        if (activity === 'scanner') {
            this.info = 'Scanning...';
        } else if (activity === 'blurScanner' || activity === 'duplicateFinder') {
            this.info = 'Applying filters...';
        }
    }

    #startDeepScanTitleTimer() {
        this.#stopDeepScanTitleTimer();
        this.#deepScanStartedAt = Date.now();
        this.#deepScanTitleInterval = setInterval(() => {
            if (this.#activityCounts.deepScan === 0) {
                this.#stopDeepScanTitleTimer();
                return;
            }
            this.#updateDeepScanTitle();
        }, 1000);
    }

    #stopDeepScanTitleTimer() {
        if (this.#deepScanTitleInterval !== null) {
            clearInterval(this.#deepScanTitleInterval);
            this.#deepScanTitleInterval = null;
        }
        this.#deepScanStartedAt = null;
    }

    #updateDeepScanTitle() {
        if (this.#deepScanStartedAt === null) return;

        const title = `Deep scan running... ${this.deepScanElapsedTime}`;
        this.DOM.divLED.title = title;
        this.info = title;
    }
}
