import { Settings } from './Settings.js';
import ImageScanner from './ImageScanner.js';
import AnalyzerClient from './AnalyzerClient.js';
import ResultStore from './ResultStore.js';
import Popup from './Popup.js';
import { ScanContext } from './ScanContext.js';
import ScanController from './ScanController.js';

export class MediaController {
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
        // ✴️ NEW 2026-10-10: Keeps scan lifecycle and activity state outside the application controller.
        this.scanController = new ScanController(this.scanner, {
            onActivityChange: () => this.#updateLEDActivity(),
            onScanRunningChange: (state) => this.popup.setScanRunning(state),
            // ✏️ EDIT 2026-10-10: Explicit scan aborts must hide normal scan progress immediately.
            onScanStopped: () => this.popup.hideProgress()
        });
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
        if (!this.scanController.isActivityRunning('deepScan') && !this.isDeepScanRunning) return false;

        return this.stopScan({endReason});
    }

    async stopScan({endReason = 'user-abort'} = {}) {
        if (!this.isScanRunning) return false;

        this.analyzerClient.clear();
        this.popup.setInfo('Image preview');
        return this.scanController.stop({endReason});
    }

    get isDeepScanRunning() {
        return this.scanController.isDeepScanRunning;
    }

    get isScanRunning() {
        return this.scanController.isScanRunning;
    }

    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        return this.scanController.cancelDeepScan({endReason});
    }

    setDeepScanClientId(clientId) {
        this.scanController.setDeepScanClientId(clientId);
    }

    // ✏️ EDIT 2026-10-09: Delegates selected image preview preparation to Popup and MediaPreview.
    async #showMediaPreview(imageId, scanGeneration = null) {
        if (scanGeneration !== null && !this.scanController.isCurrent(scanGeneration)) return;

        const image = imageId ? this.images.get(imageId) ?? null : null;
        if (!image) return;

        this.#updateSelectedMediaActions(imageId);

        const previewVisible = await this.popup.showImagePreview(image, {
            isCurrent: () => (scanGeneration === null || this.scanController.isCurrent(scanGeneration)) &&
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
            this.scanController.invalidate();
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
        this.scanController.startActivity(type, scanGeneration);
    }

    stopActivity(type, scanGeneration = null) {
        this.scanController.stopActivity(type, scanGeneration);
    }

    // ✏️ EDIT 2026-10-10: Delegates scan lifecycle, cancellation, and activity state to ScanController.
    async scan() {
        let deepScanInitialVisibleImages = 0;
        let deepScanInitialCandidates = 0;

        return this.scanController.scan({
            scanContext: this.scanContext,
            onPrepare: () => {
                this.clearMedia({invalidateScan: false});
                this.popup.resetSortState();
                this.popup.showAddonVersion();
                this.popup.resetScanProgress();
            },
            onNormalScanStart: (count) => this.popup.showScanProgress(count),
            onNormalScanProgress: () => this.popup.updateScanProgress(),
            onNormalScanResults: async (scanResults, scan) => {
                this.resultStore.addCandidates(scanResults);
                let visibleImagesUpdated = false;

                try {
                    visibleImagesUpdated = await this.#refreshVisibleImages(scan.generation, {
                        initialSort: true,
                        showFilteringProgress: true
                    });
                } finally {
                    this.popup.finishFilteringProgress();
                }

                return visibleImagesUpdated;
            },
            shouldStartDeepScan: () => {
                const allowBackgroundScan = this.settings.get('common', 'allowBackgroundScan', false);

                return allowBackgroundScan === true &&
                    this.scanContext.isScannable && Number.isInteger(this.scanContext.tabId);
            },
            onDeepScanStart: () => {
                deepScanInitialVisibleImages = this.images.size;
                deepScanInitialCandidates = this.candidates.size;
                this.popup.setInfo('Image preview');
            },
            onDeepScanCandidates: (rawCandidates, signal, diagnostic, scan) =>
                this.#processDeepScanCandidates(rawCandidates, signal, diagnostic, scan.generation),
            onDeepScanFinished: ({failed, candidateCount}) => {
                const completionInfo = `Deep scan completed after ${this.popup.deepScanElapsedTime}`;

                console.info('[DeepScan RESULT]', {
                    status: failed ? 'failed' : 'completed',
                    deepScanCandidates: candidateCount,
                    visibleImages: this.images.size,
                    newVisibleImages: Math.max(0, this.images.size - deepScanInitialVisibleImages),
                    candidates: this.candidates.size,
                    newCandidates: Math.max(0, this.candidates.size - deepScanInitialCandidates)
                });

                return completionInfo;
            },
            onScanCompleted: ({deepScanStarted, deepScanCompletion}) => {
                this.popup.setInfo(deepScanStarted
                    ? deepScanCompletion ?? 'Image preview'
                    : this.images.size > 0
                        ? 'Image preview'
                        : 'No images found!');
            },
            onScanError: () => {
                console.warn('Cannot scan this page:', this.scanner.currentTab?.url);
                this.popup.setInfo('Page not allowed to scan!');
            },
            onFinalize: (scan) => {
                this.#finalizeDeepScanUI(scan.generation);
                this.popup.hideProgress();
            }
        });
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

    // ✏️ EDIT 2026-10-10: Uses the canonical profile subfolder for browser download filenames.
    getDownloadTarget() {
        const downloads = this.settings.get('downloads') ?? {};
        const userFolder = String(downloads.userFolder ?? '')
            .trim()
            .replaceAll('\\', '/')
            .replace(/^\/+|\/+$/g, '');
        const defaultFolder = String(downloads.defaultFolder ?? '')
            .trim()
            .replaceAll('\\', '/')
            .replace(/\/+$/, '');
        const relativeFolder = /^[A-Za-z]:\//.test(userFolder) ? '' : userFolder;
        const effectiveFolder = downloads.downloadFolder === 'user'
            ? [defaultFolder, relativeFolder].filter(Boolean).join('/')
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

    // ✴️ NEW 2026-10-10: Processes one DeepScan batch while ScanController owns its lifecycle.
    async #processDeepScanCandidates(rawCandidates, signal, diagnostic, scanGeneration) {
        if (signal?.aborted || !this.scanController.isCurrent(scanGeneration)) return false;

        const visibleImagesBefore = this.images.size;
        const visibleURLsBefore = new Set(
            Array.from(this.images.values(), (item) => item.url)
        );
        const {
            newCandidates,
            existingCandidatesUpdated,
            existingCandidateUpgradeCount,
            updatedCandidateIds
        } = this.resultStore.getNewURLCandidates(rawCandidates);
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
            ? await this.scanner.createCandidates(newCandidates, this.scanContext.tabId, {signal})
            : [];
        if (signal?.aborted || !this.scanController.isCurrent(scanGeneration)) return false;
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
            ...candidates.map((item) => item.id)
        ]);
        const visibleImagesUpdated = await this.#refreshVisibleImages(scanGeneration, {
            incrementalAnalysis: true,
            analysisCandidateIds
        });

        if (!diagnostic) return visibleImagesUpdated;

        const visibleWinnersFromBatch = candidates.filter((item) =>
            this.images.has(item.id)
        ).length;
        const visibleNewURLs = Array.from(this.images.values()).filter((item) =>
            !visibleURLsBefore.has(item.url)
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
        if (!visibleResultChanges || !this.scanController.isCurrent(scanGeneration)) return false;

        const {selectedMediaId, previousSelectedMediaId} = this.#renderImages(visibleResultChanges);
        if (!this.scanController.isCurrent(scanGeneration)) return false;

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

        return this.scanController.isCurrent(scanGeneration);
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
            isCurrent: () => this.scanController.isCurrent(scanGeneration),
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
        if (!analyzedCandidates || !this.scanController.isCurrent(scanGeneration)) return false;

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
        if (!this.scanController.isCurrent(scanGeneration) ||
            this.scanController.isActivityRunning('deepScan')) return;

        this.#updateLEDActivity();
    }

    #updateLEDActivity() {
        this.popup.setActivity(this.scanController.activity, this.images.size);
    }
}
