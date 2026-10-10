import MediaList from './MediaList.js';
import MediaPreview from './MediaPreview.js';
import Progressbar from './Progressbar.js';

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
const SCAN_PROGRESS_COLOR = 'var(--adn-progressbar-bg-scan, #32CD32)';
const FILTER_PROGRESS_COLOR = 'var(--adn-progressbar-bg-filter, tomato)';
const REOPEN_POPUP_AFTER_RESTART_STORAGE_KEY = 'reopenPopupAfterRestart';

/**
 * Renders the popup interface and forwards user actions to application services.
 */
export default class Popup {
    #activity = 'none';
    #deepScanStartedAt = null;
    #deepScanTitleInterval = null;
    #eventHandlers = {};
    #mediaList;
    #mediaPreview;
    #progressbar;
    #settingsPanel = null;
    #sortState = {
        criterion: null,
        direction: 'asc'
    };

    /**
     * Gives the currently selected result list item.
     * @type {HTMLLIElement|null}
     */
    get selectedItem() { return this.#mediaList.selectedItem; }

    /**
     * Gives the identifier of the currently selected media result.
     * @type {String|null}
     */
    get selectedMediaId() { return this.selectedItem?.dataset.imageId ?? null; }

    /**
     * Gives all currently rendered result list items.
     * @type {HTMLLIElement[]}
     */
    get listItems() { return this.#mediaList.items; }

    /**
     * Gives the index of the selected result list item.
     * @type {Number}
     */
    get listIndex() { return this.#mediaList.selectedIndex; }

    /**
     * Gives whether the scan button represents a running scan.
     * @type {Boolean}
     */
    get isSearchActive() { return this.DOM.btnSearch?.value === 'true'; }

    /**
     * Gives whether the settings panel is currently visible.
     * @type {Boolean}
     */
    get isSettingsPanelOpen() { return this.DOM.btnSettings?.value === 'true'; }

    /**
     * Gives the active list sort state.
     * @type {{criterion: String|null, direction: String}}
     */
    get sortState() { return {...this.#sortState}; }

    /**
     * Gives the elapsed running time of the current DeepScan.
     * @type {String}
     */
    get deepScanElapsedTime() {
        if (this.#deepScanStartedAt === null) return '0:00';

        const seconds = Math.max(0, Math.floor((Date.now() - this.#deepScanStartedAt) / 1000));
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    /**
     * Gives the current preview title text.
     * @type {String}
     */
    get info() { return this.#mediaPreview.info; }

    DOM = {};

    constructor() {
        document.querySelectorAll('[id]').forEach(elmt => {
            this.DOM[elmt.id] = elmt;
        });

        this.#mediaList = new MediaList(this.DOM.lstImages);
        this.#mediaPreview = new MediaPreview(this.DOM.divPreview, this.DOM.spnStatusBar);
        this.#progressbar = new Progressbar(this.DOM.divProgressbar);
        this.#setEventListeners();
        window.addEventListener('pagehide', () => this.#stopDeepScanTitleTimer(), {once: true});
    }

    /**
     * Connects popup interactions to the application controller.
     * @param {Object} eventHandlers Callbacks for popup interactions.
     */
    setEventHandlers(eventHandlers = {}) {
        this.#eventHandlers = {...eventHandlers};
    }

    /**
     * Registers the settings form used inside this popup.
     * @param {SettingsPanel|null} settingsPanel Loaded popup settings panel.
     */
    setSettingsPanel(settingsPanel) {
        this.#settingsPanel = settingsPanel ?? null;
    }

    /**
     * Updates the theme attributes and the visible theme toggle.
     * @param {String} mode Requested theme mode.
     */
    applyThemeMode(mode) {
        const themeMode = mode === 'dark' ? 'dark' : 'light';

        document.documentElement.dataset.mode = themeMode;
        if (this.DOM.chkTheme) this.DOM.chkTheme.checked = themeMode === 'dark';
    }

    /**
     * Renders the search action based on current scan activity.
     * @param {Boolean} active Whether a scan is active.
     */
    setScanRunning(active) {
        const isActive = active === true;
        const button = this.DOM.btnSearch;

        button.value = isActive ? 'true' : 'false';
        button.title = isActive ? 'Stop scan' : 'Find images';
        button.setAttribute('aria-label', button.title);
    }

    /**
     * Renders the current scan or analyzer activity in the popup.
     * @param {String} activity Current application activity.
     * @param {Number} imageCount Number of visible results.
     */
    setActivity(activity, imageCount) {
        this.#activity = activity;
        this.DOM.divLED.classList.toggle('active', activity !== 'none');
        this.DOM.divLED.classList.toggle('flash-led', activity === 'deepScan');
        this.DOM.divLED.dataset.activity = activity;

        if (activity === 'deepScan') {
            if (this.#deepScanStartedAt === null) this.#startDeepScanTitleTimer();
            this.#updateDeepScanTitle();
        } else if (activity === 'none') {
            this.#stopDeepScanTitleTimer();
            this.DOM.divLED.title = `Images found: ${imageCount}`;
        } else {
            this.#stopDeepScanTitleTimer();
            this.DOM.divLED.removeAttribute('title');
        }

        if (activity === 'scanner') {
            this.setInfo('Scanning...');
        } else if (activity === 'blurScanner' || activity === 'duplicateFinder') {
            this.setInfo('Applying filters...');
        }
    }

    /**
     * Updates the result counter in the scanner LED.
     * @param {Number} imageCount Number of visible results.
     */
    setImageCount(imageCount) {
        this.DOM.divLED.textContent = imageCount;
    }

    /**
     * Writes the preview title text.
     * @param {String} text Preview title.
     */
    setInfo(text) {
        this.#mediaPreview.info = text;
    }

    /**
     * Shows the default addon version when no result is selected.
     */
    showAddonVersion() {
        if (this.selectedItem) return;

        this.#mediaPreview.showAddonVersion();
    }

    /**
     * Restores the empty preview state.
     */
    showPreviewPlaceholder() {
        this.#mediaPreview.showPlaceholder();
        this.showAddonVersion();
    }

    // ✏️ EDIT 2026-10-09: Delegates preview rendering to the dedicated MediaPreview component.
    /**
     * Shows an image preview and optionally enriches it with file metadata.
     * @param {Object} image Selected image result.
     * @param {Object} options Preview dependencies.
     * @returns {Promise<Boolean>} Whether the image is still the active preview.
     */
    showImagePreview(image, options = {}) {
        return this.#mediaPreview.showImage(image, options);
    }

    /**
     * Reconciles the result list with the visible media result changes.
     * @param {Map} images Visible media results.
     * @param {Object} changes Result store change set.
     * @param {Object} options Rendering options.
     * @returns {Object} Preserved selection details.
     */
    reconcileMediaList(images, changes, options = {}) {
        const renderResult = this.#mediaList.reconcile(images, changes, options);

        return {
            selectedMediaId: renderResult.selectedItem?.dataset.imageId ?? null,
            previousSelectedMediaId: renderResult.previousSelectedImageId,
            selectionRemoved: renderResult.selectionRemoved
        };
    }

    /**
     * Removes one rendered media result.
     * @param {String} imageId Result identifier.
     * @returns {Boolean} Whether a DOM item was removed.
     */
    removeMediaListItem(imageId) {
        return this.#mediaList.remove(imageId);
    }

    /**
     * Clears every rendered media result.
     */
    clearMediaList() {
        this.#mediaList.clear();
    }

    /**
     * Sorts the current media list by a visible media property.
     * @param {Map} images Visible media results.
     * @param {String} criterion Sort criterion.
     * @param {String|null} initialDirection Explicit initial sort direction.
     */
    sortMediaList(images, criterion, initialDirection = null) {
        if (!['filename', 'type', 'size', 'dimensions', 'cronologic'].includes(criterion)) {
            return;
        }

        const direction = initialDirection ?? (this.#sortState.criterion === criterion &&
            this.#sortState.direction === 'asc'
            ? 'desc'
            : 'asc');
        if (!['asc', 'desc'].includes(direction)) return;

        const directionFactor = direction === 'asc' ? 1 : -1;
        const compareFileNames = (first, second) => String(first.fileName ?? '')
            .localeCompare(String(second.fileName ?? ''), undefined, {sensitivity: 'base'});
        const getKnownSize = image => {
            const size = image.fileSize ?? image.estimatedSize;
            return Number.isFinite(size) ? size : null;
        };
        const items = this.listItems;

        items.sort((firstItem, secondItem) => {
            const first = images.get(firstItem.dataset.imageId);
            const second = images.get(secondItem.dataset.imageId);
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
                    if (firstSize === null || secondSize === null) {
                        if (firstSize === null && secondSize === null) return 0;
                        return firstSize === null ? 1 : -1;
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
        this.#sortState = {criterion, direction};
        this.#updateSortButtons();
        this.selectedItem?.scrollIntoView({block: 'nearest'});
    }

    /**
     * Applies the default or currently active sort after a list reconciliation.
     * @param {Map} images Visible media results.
     * @param {Boolean} initialSort Whether this is the first result render of a scan.
     */
    applyMediaListSort(images, initialSort) {
        if (initialSort && !this.#sortState.criterion) {
            this.sortMediaList(images, 'cronologic', 'asc');
        } else if (this.#sortState.criterion) {
            this.sortMediaList(images, this.#sortState.criterion, this.#sortState.direction);
        }
    }

    /**
     * Resets the current sorting state.
     */
    resetSortState() {
        this.#sortState = {criterion: null, direction: 'asc'};
        this.#updateSortButtons();
    }

    /**
     * Shows normal scan progress.
     * @param {Number} max Progress maximum.
     */
    showScanProgress(max) {
        this.#progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
        this.#showProgressbar(max);
    }

    /**
     * Resets normal scan progress without changing its visibility.
     */
    resetScanProgress() {
        this.#progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
        this.#progressbar.reset();
    }

    /**
     * Advances normal scan progress by one item.
     */
    updateScanProgress() {
        this.#progressbar.update();
    }

    /**
     * Creates callbacks for visible filter progress.
     * @param {Object} options Enabled filter stage options.
     * @returns {Object|null} Analyzer progress callbacks or null.
     */
    createFilteringProgress({runsBlurScanner, runsDuplicateFinder}) {
        const stages = [
            ...(runsBlurScanner ? ['blurScanner'] : []),
            ...(runsDuplicateFinder ? ['duplicateFinder'] : [])
        ];
        if (stages.length === 0) return null;

        this.#progressbar.backgroundColor = FILTER_PROGRESS_COLOR;
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

            this.#progressbar.setValue(
                progress.start + progress.span * Math.min(1, completed / total)
            );
        };

        return {
            onBlurProgress: (completed, total) => updateStage('blurScanner', completed, total),
            onDuplicateFinderProgress: (completed, total) => updateStage('duplicateFinder', completed, total)
        };
    }

    /**
     * Completes and hides filter progress.
     */
    finishFilteringProgress() {
        this.#progressbar.setValue(this.#progressbar.max);
        this.#hideProgressbar();
        this.#progressbar.backgroundColor = SCAN_PROGRESS_COLOR;
    }

    /**
     * Hides the currently visible scan progress indicator.
     */
    hideProgress() {
        this.#hideProgressbar();
    }

    /**
     * Sets the enabled state of a named popup action.
     * @param {String} action Popup action name.
     * @param {Boolean} disabled Whether the action is disabled.
     */
    setActionDisabled(action, disabled) {
        const buttonByAction = {
            download: this.DOM.btnDownload,
            saveAll: this.DOM.btnSaveAll,
            delete: this.DOM.btnDelete,
            clear: this.DOM.btnClear,
            openDownloadFolder: this.DOM.btnOpenDownloadFolder
        };
        const button = buttonByAction[action];

        if (button) button.disabled = disabled === true;
    }

    /**
     * Updates the visible download target titles.
     * @param {String} folder Effective download target folder.
     */
    updateDownloadTitles(folder) {
        this.DOM.btnDownload.title = folder
            ? `Download image to: ${folder}`
            : 'Download image';
        this.DOM.btnSaveAll.title = folder
            ? `Save all images to: ${folder}`
            : 'Save all images';
    }

    /**
     * Marks a list item as successfully downloaded.
     * @param {String} imageId Result identifier.
     */
    markMediaListItemDownloaded(imageId) {
        const item = this.listItems.find(li => li.dataset.imageId === imageId);

        item?.classList.add('saved');
        const marker = item?.querySelector('.result-marker');
        if (marker) marker.dataset.state = 'downloaded';
    }

    /**
     * Updates the actions belonging to the selected media result.
     * @param {String} imageId Result identifier.
     * @param {Object} actionState Selected media action state.
     */
    updateSelectedMediaActions(imageId, {canOpenDownloadFolder, disableDownload} = {}) {
        if (imageId !== this.selectedMediaId) return;

        if (typeof canOpenDownloadFolder === 'boolean') {
            this.setActionDisabled('openDownloadFolder', !canOpenDownloadFolder);
        }
        if (typeof disableDownload === 'boolean') {
            this.setActionDisabled('download', disableDownload);
        }
    }

    // Registers all DOM events once and handles their visible interaction semantics.
    #setEventListeners() {
        this.DOM.divToolbar.addEventListener('click', (e) => void this.#onToolbarButtonClick(e));
        this.DOM.divToolbarTopLeft.addEventListener('click', (e) => {
            const button = e.target.closest('button');
            if (!button || !button.dataset.sort || !this.DOM.divToolbarTopLeft.contains(button)) {
                return;
            }

            const criterion = button.dataset.sort;
            const direction = this.#sortState.criterion === criterion &&
                this.#sortState.direction === 'asc'
                ? 'desc'
                : 'asc';
            this.sortMediaList(this.#eventHandlers.getVisibleMedia?.() ?? new Map(), criterion, direction);
        });
        this.DOM.lstImages.addEventListener('click', (e) => {
            const item = e.target.closest('li');
            if (!item) return;

            this.#selectListItem(item, {focusList: true});
            void this.#eventHandlers.onMediaSelected?.(item.dataset.imageId);
        });
        this.DOM.lstImages.addEventListener('keydown', (e) => this.#onListKeyDown(e));
        this.DOM.chkTheme?.addEventListener('change', () => {
            const mode = this.DOM.chkTheme.checked ? 'dark' : 'light';
            this.applyThemeMode(mode);
            void this.#eventHandlers.onThemeChange?.(mode);
        });
        document.addEventListener('keydown', (e) => this.#onSettingsKeyDown(e), true);
    }

    // Maps bottom toolbar controls directly to their popup actions.
    async #onToolbarButtonClick(e) {
        const button = e.target.closest('button');
        if (!button || !this.DOM.divToolbar.contains(button)) return;

        switch (button.id) {
            case 'btnSettings':
                await this.#toggleSettingsPanel();
                break;

            case 'btnDefaultSettings':
                await this.#resetSettingsToDefaults();
                break;

            case 'btnSearch':
                if (this.isSearchActive) {
                    await this.#eventHandlers.onStopScan?.({endReason: 'user-abort'});
                } else {
                    await this.#eventHandlers.onScan?.();
                }
                break;

            case 'btnScan':
                // TODO re-scan the selected image for a better version
                break;

            case 'btnDownload':
                await this.#eventHandlers.onDownloadMedia?.(this.selectedMediaId);
                break;

            case 'btnSaveAll':
                await this.#eventHandlers.onDownloadAllMedia?.();
                break;

            case 'btnOpenDownloadFolder':
                await this.#eventHandlers.onOpenDownloadFolder?.(this.selectedMediaId);
                break;

            case 'btnDelete':
                await this.#eventHandlers.onDeleteMedia?.(this.selectedMediaId);
                break;

            case 'btnClear':
                await this.#eventHandlers.onClearMedia?.();
                break;

            case 'btnTabReload':
                await this.#eventHandlers.onReloadCurrentTab?.();
                break;

            case 'btnRestart':
                await this.#restartExtension();
                break;

            default:
                break;
        }
    }

    // Handles keyboard navigation in the result list and forwards semantic actions.
    #onListKeyDown(e) {
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
                void this.#eventHandlers.onDeleteMedia?.(this.selectedMediaId);
                return;
            case 'Enter':
                void this.#eventHandlers.onDownloadMedia?.(this.selectedMediaId);
                return;
            default:
                return;
        }

        const item = items[index];
        this.#selectListItem(item);
        void this.#eventHandlers.onMediaSelected?.(item.dataset.imageId);
    }

    // Closes the settings panel on Enter while it owns focus.
    #onSettingsKeyDown(event) {
        if (!this.isSettingsPanelOpen || event.key !== 'Enter' || event.isComposing) return;

        event.preventDefault();
        event.stopPropagation();
        void this.#closeSettingsPanel();
    }

    // Opens or closes the settings UI and delegates only setting mutations.
    async #toggleSettingsPanel() {
        if (this.isSettingsPanelOpen) {
            await this.#closeSettingsPanel();
            return;
        }

        await this.#eventHandlers.onStopScan?.({endReason: 'settings-open'});
        this.DOM.btnSettings.value = 'true';
        this.DOM.divSettingsPanel.classList.add('open');
        this.DOM.divToolbarActions.hidden = true;
        this.DOM.divProgressbar.hidden = true;
        this.DOM.spnStatusBar.hidden = true;
        this.DOM.btnRestart.hidden = false;
        this.DOM.btnDefaultSettings.hidden = false;
        this.DOM.btnDefaultSettings.disabled = false;
        await this.#settingsPanel?.refresh();
    }

    // Closes the settings UI after pending settings writes complete.
    async #closeSettingsPanel() {
        if (!this.isSettingsPanelOpen) return;

        this.DOM.btnSettings.value = 'false';
        this.DOM.divSettingsPanel.classList.remove('open');
        this.DOM.divToolbarActions.hidden = false;
        this.DOM.divProgressbar.hidden = false;
        this.DOM.spnStatusBar.hidden = false;
        this.showAddonVersion();
        this.DOM.btnRestart.hidden = true;
        this.DOM.btnDefaultSettings.hidden = true;
        this.DOM.btnDefaultSettings.disabled = true;
        await this.#settingsPanel?.waitForPendingSave();
        await this.#eventHandlers.onSettingsClosed?.();
    }

    // Resets persisted settings while keeping the settings form and theme in sync.
    async #resetSettingsToDefaults() {
        if (!this.isSettingsPanelOpen) return;

        await this.#settingsPanel?.waitForPendingSave();
        const resetState = await this.#eventHandlers.onResetSettings?.();
        if (resetState?.themeMode) this.applyThemeMode(resetState.themeMode);
        if (typeof resetState?.downloadFolder === 'string') {
            this.updateDownloadTitles(resetState.downloadFolder);
        }
        await this.#settingsPanel?.refresh();
    }

    // Restarts the extension after preserving the requested popup reopening state.
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

    // Applies popup-local selection styling and scroll positioning.
    #selectListItem(item, {focusList = false} = {}) {
        this.setInfo('Image preview');
        this.selectedItem?.classList.remove('selected');
        item.classList.add('selected');
        if (focusList) this.DOM.lstImages.focus();
        item.scrollIntoView({block: 'nearest'});
    }

    // Shows a progress bar while hiding the status text.
    #showProgressbar(max) {
        this.DOM.spnStatusBar.style.display = 'none';
        this.#progressbar.show(max);
    }

    // Hides progress and restores the default status bar state.
    #hideProgressbar() {
        this.#progressbar.hide();
        this.showAddonVersion();
    }

    // Updates sort button styling and accessible titles.
    #updateSortButtons() {
        this.DOM.divToolbarTopLeft.querySelectorAll('button[data-sort]').forEach(sortButton => {
            const criterion = sortButton.dataset.sort;
            const isActive = criterion === this.#sortState.criterion;
            const title = SORT_BUTTON_TITLES[criterion];

            sortButton.classList.toggle('sorted', isActive);
            if (!title) return;

            const direction = isActive ? this.#sortState.direction : 'asc';
            sortButton.value = direction;
            sortButton.title = isActive
                ? `${title} ${SORT_DIRECTION_TITLES[direction]}`
                : title;
        });
    }

    // Starts the visual DeepScan duration timer.
    #startDeepScanTitleTimer() {
        this.#stopDeepScanTitleTimer();
        this.#deepScanStartedAt = Date.now();
        this.#deepScanTitleInterval = setInterval(() => {
            if (this.#activity !== 'deepScan') {
                this.#stopDeepScanTitleTimer();
                return;
            }
            this.#updateDeepScanTitle();
        }, 1000);
    }

    // Stops the visual DeepScan duration timer.
    #stopDeepScanTitleTimer() {
        if (this.#deepScanTitleInterval !== null) {
            clearInterval(this.#deepScanTitleInterval);
            this.#deepScanTitleInterval = null;
        }
        this.#deepScanStartedAt = null;
    }

    // Renders the current DeepScan duration in the LED title and preview heading.
    #updateDeepScanTitle() {
        if (this.#deepScanStartedAt === null) return;

        const title = `Deep scan running... ${this.deepScanElapsedTime}`;
        this.DOM.divLED.title = title;
        this.setInfo(title);
    }
}
