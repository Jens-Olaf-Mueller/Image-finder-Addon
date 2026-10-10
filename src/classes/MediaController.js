import { Settings } from './Settings.js';
import ImageScanner from './ImageScanner.js';
import AnalyzerClient from './AnalyzerClient.js';
import ResultStore from './ResultStore.js';
import Popup from './Popup.js';
import { ScanContext } from './ScanContext.js';

export class MediaController {
    #activityCounts = {
        scanner: 0,
        duplicateFinder: 0,
        blurScanner: 0,
        deepScan: 0
    };
    #scanGeneration = 0;
    #scanController = null;

    get candidates() {
        return this.resultStore.candidates;
    }

    get images() {
        return this.resultStore.images;
    }

    get shouldDisableDownloadWhenCompleted() {
        return (this.settings.get('downloads') ?? {}).disableDownloadWhenDone === true;
    }

    constructor() {
        this.popup = new Popup();
        this.settings = new Settings();
        this.scanContext = new ScanContext();
        this.scanner = new ImageScanner(this.settings);
        this.resultStore = new ResultStore();
        this.analyzerClient = new AnalyzerClient();
        this.isSavingAll = false;
        this.popup.setEventHandlers({
            getVisibleMedia: () => this.images,
            onScan: () => this.scan(),
            onStopScan: (options) => this.stopScan(options),
            onMediaSelected: (imageId) => this.#showMediaPreviewSafely(imageId),
            onDeleteMedia: (imageId) => this.deleteMedia(imageId),
            onDownloadMedia: (imageId) => this.downloadMedia(imageId),
            onDownloadAllMedia: () => this.downloadAllMedia(),
            onOpenDownloadFolder: (imageId) => this.openMediaDownloadFolder(imageId),
            onClearMedia: () => this.clearMedia(),
            onReloadCurrentTab: () => this.reloadCurrentTab(),
            onThemeChange: (mode) => this.#setThemeMode(mode),
            onSettingsClosed: () => {
                this.updateDownloadTitles();
                this.#updateLEDActivity();
            },
            onResetSettings: () => this.resetSettingsToDefaults()
        });
        window.chrome?.downloads?.onChanged?.addListener((delta) => {
            this.#handleDownloadChanged(delta);
        });
        this.popup.showAddonVersion();
        this.#updateLED();
        this.#updateLEDActivity();

        console.dir(this)
    }

    async run(onSettingsReady = null) {
        await this.setWebsiteURLFromActiveTab();
        await this.settings.run();
        this.popup.applyThemeMode(this.settings.getThemeMode());
        if (typeof onSettingsReady === 'function') await onSettingsReady();
        this.updateDownloadTitles();
        if (this.settings.get('common', 'scanOnStart', true)) await this.scan();
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

    async stopDeepScan({endReason = 'cancelled'} = {}) {
        if (this.#activityCounts.deepScan === 0 && !this.isDeepScanRunning) return false;

        return this.stopScan({endReason});
    }

    async stopScan({endReason = 'user-abort'} = {}) {
        if (!this.isScanRunning) return false;

        this.#scanGeneration += 1;
        this.#scanController?.abort();
        this.#scanController = null;
        this.analyzerClient.clear();
        this.#resetScanActivities();
        this.#setScanRunning(false);
        this.popup.setInfo('Image preview');
        await this.cancelDeepScan({endReason});
        return true;
    }

    get isDeepScanRunning() {
        return this.scanner.isDeepScanRunning;
    }

    get isScanRunning() {
        return this.#scanController !== null || this.isDeepScanRunning ||
            Object.values(this.#activityCounts).some((count) => count > 0);
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        return this.scanner.cancelDeepScan({endReason});
    }

    setDeepScanClientId(clientId) {
        this.scanner.setDeepScanClientId(clientId);
    }

    // ✏️ EDIT 2026-10-09: Delegates selected image preview preparation to Popup and MediaPreview.
    async #showMediaPreview(imageId, scanGeneration = null) {
        if (scanGeneration !== null && !this.#isCurrentScan(scanGeneration)) return;

        const image = imageId ? this.images.get(imageId) ?? null : null;
        if (!image) return;

        this.#updateSelectedMediaActions(imageId);

        const previewVisible = await this.popup.showImagePreview(image, {
            isCurrent: () => (scanGeneration === null || this.#isCurrentScan(scanGeneration)) &&
                this.popup.selectedMediaId === imageId,
            getFileInfo: (url) => this.scanner.getFileInfo(url)
        });
        if (!previewVisible) return;

        const downloadOff = this.shouldDisableDownloadWhenCompleted &&
            this.resultStore.getDownload(imageId)?.completed === true;
        this.popup.setActionDisabled('delete', false);
        this.popup.setActionDisabled('download', downloadOff);
        this.updateDownloadTitles();
    }

    async #showMediaPreviewSafely(imageId) {
        try {
            await this.#showMediaPreview(imageId);
        } catch (error) {
            console.warn('Cannot show image:', imageId, error);
        }
    }

    async resetSettingsToDefaults() {
        await this.settings.resetToDefaults();

        return {
            themeMode: this.settings.getThemeMode(),
            downloadFolder: this.getEffectiveDownloadFolder()
        };
    }

    async #setThemeMode(mode) {
        const themeMode = mode === 'dark' ? 'dark' : 'light';

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

    clearMedia({invalidateScan = true} = {}) {
        if (invalidateScan) {
            void this.scanner.cancelDeepScan();
            this.#scanGeneration += 1;
            this.#scanController?.abort();
            this.#scanController = null;
            this.#resetScanActivities();
            this.#setScanRunning(false);
        }

        this.resultStore.clear();
        this.analyzerClient.clear();
        this.popup.clearMediaList();
        this.popup.showPreviewPlaceholder();
        this.popup.setActionDisabled('download', true);
        this.popup.setActionDisabled('saveAll', true);
        this.popup.setActionDisabled('delete', true);
        this.popup.setActionDisabled('clear', true);
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
        this.#setScanRunning(true);
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
            this.clearMedia({invalidateScan: false});
            this.popup.resetSortState();
            this.popup.showAddonVersion();
            this.popup.resetScanProgress();

            const scanResults = await this.scanner.scan({
                onStart: count => this.popup.showScanProgress(count),
                onProgress: () => this.popup.updateScanProgress(),
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
                this.popup.finishFilteringProgress();
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
                this.popup.setInfo('Image preview');
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
                            existingCandidateUpgradeCount,
                            updatedCandidateIds
                        } =
                            this.resultStore.getNewURLCandidates(rawCandidates);
                        if (newCandidates.length === 0 && !existingCandidatesUpdated) {
                            return diagnostic
                                ? {
                                    continue: true,
                                    mediaControllerNewURLs: 0,
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
                                    mediaControllerNewURLs: newCandidates.length,
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
                        const analysisCandidateIds = new Set([
                            ...updatedCandidateIds,
                            ...candidates.map((candidate) => candidate.id)
                        ]);
                        const visibleImagesUpdated = await this.#refreshVisibleImages(
                            scanGeneration,
                            {
                                incrementalAnalysis: true,
                                analysisCandidateIds
                            }
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
                            mediaControllerNewURLs: newCandidates.length,
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
                    deepScanCompletionInfo = deepScanStarted
                        ? `Deep scan completed after ${this.popup.deepScanElapsedTime}`
                        : null;
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
                this.popup.setInfo('Page not allowed to scan!');
            }
        } finally {
            if (scannerActivityActive) this.stopActivity('scanner', scanGeneration);
            if (deepScanActivityActive) this.stopActivity('deepScan', scanGeneration);
            if (scanCompleted && this.#isCurrentScan(scanGeneration)) {
                this.popup.setInfo(deepScanStarted
                    ? deepScanCompletionInfo ?? 'Image preview'
                    : this.images.size > 0
                        ? 'Image preview'
                        : 'No images found!');
            }
            this.#finalizeDeepScanUI(scanGeneration);
            if (this.#isCurrentScan(scanGeneration)) {
                this.popup.hideProgress();
                if (this.#scanController === scanController) {
                    this.#scanController = null;
                }
                this.#setScanRunning(false);
            }
        }
    }

    async downloadMedia(imageId) {
        const image = imageId ? this.images.get(imageId) ?? null : null;
        if (!image) return;

        try {
            const downloadId = await this.downloadImage(image);
            this.#trackDownload(imageId, downloadId);
        } catch (error) {
            console.warn('Cannot download image:', image.url, error);
            this.#updateSelectedMediaActions(imageId);
        }
    }

    async downloadAllMedia() {
        if (this.isSavingAll) return;

        this.isSavingAll = true;
        this.popup.setActionDisabled('saveAll', true);

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

                this.#trackDownload(result.imageId, result.downloadId);
            }
        } catch (error) {
            console.warn('Cannot download image list:', error);
        } finally {
            this.isSavingAll = false;
            this.popup.setActionDisabled('saveAll', this.images.size === 0);
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

        this.popup.updateDownloadTitles(folder);
    }

    async openMediaDownloadFolder(imageId) {
        const download = imageId ? this.resultStore.getDownload(imageId) : null;
        if (!imageId || !download?.completed || !Number.isInteger(download.downloadId)) {
            this.#updateSelectedMediaActions(imageId);
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

    // ✏️ EDIT 2026-10-09: Keeps the persistent offscreen analyzer in sync with result deletion.
    deleteMedia(imageId) {
        if (!imageId) return;

        this.resultStore.deleteResult(imageId);
        void this.analyzerClient.removeCandidates([imageId]).catch((error) => {
            console.warn('Cannot remove deleted media from analyzer:', error);
        });
        this.popup.removeMediaListItem(imageId);

        this.popup.showPreviewPlaceholder();
        this.popup.setActionDisabled('download', true);
        this.popup.setActionDisabled('delete', true);
        this.popup.setActionDisabled('saveAll', this.images.size === 0);
        this.popup.setActionDisabled('clear', this.images.size === 0);
        this.#updateLED();
        this.#updateLEDActivity();
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

    #setScanRunning(active) {
        this.popup.setScanRunning(active);
    }

    // ✏️ EDIT 2026-10-08: Reconciles only visible result changes through MediaList.
    #renderImages(resultChanges) {
        const renderResult = this.popup.reconcileMediaList(this.images, resultChanges, {
            getMarkerState: (imageId, image, savedImageIds) =>
                this.resultStore.getVisibleResultMarkerState(imageId, image, savedImageIds)
        });

        if (renderResult.selectionRemoved) {
            this.popup.showPreviewPlaceholder();
            this.popup.setActionDisabled('download', true);
            this.popup.setActionDisabled('delete', true);
        }

        return renderResult;
    }

    async #refreshVisibleImages(scanGeneration, {
        initialSort = false,
        showFilteringProgress = false,
        incrementalAnalysis = false,
        analysisCandidateIds = null
    } = {}) {
        const visibleResultChanges = await this.#setVisibleImages(scanGeneration, {
            showFilteringProgress,
            incrementalAnalysis,
            analysisCandidateIds
        });
        if (!visibleResultChanges || !this.#isCurrentScan(scanGeneration)) return false;

        const {selectedMediaId, previousSelectedMediaId} = this.#renderImages(visibleResultChanges);
        if (!this.#isCurrentScan(scanGeneration)) return false;

        this.popup.applyMediaListSort(this.images, initialSort);

        this.#updateImageListState();
        this.#updateSelectedMediaActions(selectedMediaId);
        if (selectedMediaId && selectedMediaId !== previousSelectedMediaId) {
            try {
                await this.#showMediaPreview(selectedMediaId, scanGeneration);
            } catch (error) {
                console.warn('Cannot show replacement image:', selectedMediaId, error);
            }
        }

        return this.#isCurrentScan(scanGeneration);
    }

    #updateImageListState() {
        this.popup.setActionDisabled('saveAll', this.isSavingAll || this.images.size === 0);
        this.popup.setActionDisabled('clear', this.images.size === 0);
        this.#updateLED();
    }

    async #setVisibleImages(scanGeneration, {
        showFilteringProgress = false,
        incrementalAnalysis = false,
        analysisCandidateIds = null
    } = {}) {
        const previousVisibleImageIds = new Set(this.images.keys());
        const allCandidates = Array.from(this.candidates);
        const filters = this.settings.get('filters') ?? {};
        const appliesAnalysisFilter = filters.ignoreBlurredImages === true ||
            filters.ignoreDuplicates === true;
        const usesIncrementalAnalysis = incrementalAnalysis === true && appliesAnalysisFilter;
        const candidates = usesIncrementalAnalysis
            ? allCandidates.filter(([candidateId]) => analysisCandidateIds?.has(candidateId))
            : allCandidates;
        const filteringProgress = showFilteringProgress
            ? this.popup.createFilteringProgress({
                runsBlurScanner: filters.ignoreBlurredImages === true && candidates.length > 0,
                runsDuplicateFinder: filters.ignoreDuplicates === true && candidates.length >= 2
            })
            : null;
        const analyzedCandidates = await this.analyzerClient.filterCandidates(candidates, {
            allCandidates,
            filters,
            incremental: usesIncrementalAnalysis,
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

        return this.resultStore.replaceVisibleResults(visibleCandidates);
    }

    #updateLED() {
        this.popup.setImageCount(this.images.size);
    }

    #trackDownload(imageId, downloadId) {
        if (!imageId || !Number.isInteger(downloadId)) return;

        if (!this.resultStore.trackDownload(imageId, downloadId)) return;
        this.#updateSelectedMediaActions(imageId);
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

        if (completed) {
            this.popup.markMediaListItemDownloaded(imageId);
        }
        this.#updateSelectedMediaActions(imageId);
    }

    #updateSelectedMediaActions(imageId) {
        if (!imageId) return;

        const download = imageId ? this.resultStore.getDownload(imageId) : null;
        this.popup.updateSelectedMediaActions(imageId, {
            canOpenDownloadFolder: Number.isInteger(download?.downloadId) &&
                download.completed === true,
            disableDownload: this.shouldDisableDownloadWhenCompleted &&
                download?.completed === true
        });
    }

    #finalizeDeepScanUI(scanGeneration) {
        if (!this.#isCurrentScan(scanGeneration) || this.#activityCounts.deepScan > 0) return;

        this.#updateLEDActivity();
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

        this.popup.setActivity(activity, this.images.size);
    }
}
