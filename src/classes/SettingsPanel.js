/**
 * @file SettingsPanel.js
 * @module SettingsPanel
 * @version 0.1.12
 * @date 2026-10-06
 * @author Jens-Olaf-Mueller
 *
 * SettingsPanel - Controls the shared settings form in the options page and popup.
 * ==============================================================================
 *
 * Loads the settings form, synchronizes it with persisted data, and manages the
 * controls whose state depends on other settings. The same panel implementation
 * is used by both extension views.
 * - Key features:
 * - Form loading:             Loads the shared settings form into a container.
 * - Data synchronization:     Reads settings into the form and persists changes.
 * - Dynamic controls:         Enables dependent controls for the active settings.
 * - Deferred persistence:     Serializes concurrent save operations.
 * - Website profiles:         Supports deleting the profile of the active website.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link load}                             - Loads the settings form markup.
 * - {@link run}                              - Initializes the panel.
 * - {@link refresh}                          - Synchronizes the form with settings.
 * - {@link updateUI}                         - Updates dependent control states.
 * - {@link setDefaultDownloadFolder}         - Stores missing download folders.
 * - {@link enqueue}                          - Queues a settings save operation.
 * - {@link waitForPendingSave}               - Waits for the queued save operation.
 * - {@link deleteCurrentWebsiteProfile}      - Deletes the active profile.
 * - {@link notifySettingsChanged}            - Notifies the settings consumer.
 * - {@link getFormData}                      - Reads the form into settings data.
 * - {@link setFormData}                      - Writes settings data into the form.
 * - {@link getValue}                         - Reads a single form control value.
 * - {@link setValue}                         - Writes a single form control value.
 * - {@link openBrowserDownloadSettings}      - Opens browser download settings.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #setEventListeners()}             - Registers panel event listeners.
 * - {@link #updateImageSizeControls()}       - Updates image-size controls.
 * - {@link #updateDeepScanControls()}        - Updates DeepScan controls.
 * - {@link #updateDebugControls()}           - Updates debug-log controls.
 * - {@link #updateDownloadFolderControls()}  - Updates download-folder controls.
 * - {@link #updateExcludeListControls()}     - Updates exclude-list controls.
 * - {@link #updateWebsiteProfileControls()}  - Updates website-profile controls.
 * - {@link #updateDeleteProfileButton()}     - Updates the delete-profile button.
 * - {@link #log()}                           - Logs panel messages and errors.
 */
export class SettingsPanel {
    // ✏️ EDIT 2026-10-06: Sorted and documented the SettingsPanel class API.
    #pendingSave = Promise.resolve();

    /**
     * @param {Settings} settings - The initialized settings storage.
     * @param {HTMLFormElement} form - The settings form to manage.
     * @param {Object} [options={}] - Optional panel configuration.
     * @param {Function|null} [options.onSettingsChanged=null] - Callback after a saved change.
     */
    constructor(settings, form, {onSettingsChanged = null} = {}) {
        this.settings = settings;
        this.form = form;
        this.onSettingsChanged = onSettingsChanged;
        this.DOM = {};
        this.hasEventListeners = false;

        this.form.querySelectorAll('[id]').forEach(elm => this.DOM[elm.id] = elm);
        this.downloadFolderRadios = this.form.querySelectorAll('input[name="downloadFolder"]');
    }

    /**
     * Loads the shared settings form into a target container.
     *
     * @param {string|HTMLElement} container - The target element or its ID.
     * @returns {Promise<HTMLFormElement>} The inserted settings form.
     * @throws {Error} When the container or form markup is unavailable.
     */
    static async load(container) {
        const target = typeof container === 'string'
            ? document.getElementById(container)
            : container;

        if (!target) {
            throw new Error('Settings form container not found');
        }

        const response = await fetch(new URL('../../ui/settings-form.html', import.meta.url));
        if (!response.ok) {
            throw new Error('Cannot load settings form');
        }

        target.innerHTML = await response.text();
        return target.querySelector('#frmSettings');
    }

    /**
     * Initializes the settings storage, form values, and event listeners.
     *
     * @param {Object} [options={}] - Initialization options.
     * @param {boolean} [options.loadSettings=true] - Whether to load persisted settings first.
     * @returns {Promise<void>}
     */
    async run({loadSettings = true} = {}) {
        if (loadSettings) await this.settings.run();

        await this.setDefaultDownloadFolder();
        await this.refresh();
        this.#setEventListeners();
    }

    /**
     * Synchronizes form values and dependent controls with the current settings.
     *
     * @returns {Promise<void>}
     */
    async refresh() {
        this.setFormData(this.settings.data);
        const protectedDeepScanWasCleared = this.#updateDeepScanControls();

        if (protectedDeepScanWasCleared) {
            await this.settings.save(this.getFormData());
        }

        await this.updateUI();
    }

    /**
     * Updates the states of all settings controls that depend on other values.
     *
     * @returns {Promise<void>}
     */
    async updateUI() {
        this.#updateDeepScanControls();
        this.#updateDebugControls();
        this.#updateImageSizeControls();
        this.#updateDownloadFolderControls();
        this.#updateExcludeListControls();
        this.#updateWebsiteProfileControls();
        await this.#updateDeleteProfileButton();
    }

    /**
     * Stores a detected default download folder and initializes the user folder when needed.
     *
     * @returns {Promise<void>}
     */
    async setDefaultDownloadFolder() {
        const downloads = this.settings.get('downloads', null, {});
        let defaultFolder = downloads.defaultFolder ?? '';
        let nextDownloads = downloads;

        if (!defaultFolder) {
            try {
                defaultFolder = await this.settings.getMostLikelyDownloadFolder();
            } catch (error) {
                this.#log('Could not determine download folder:', 'warn', error);
                return;
            }

            if (!defaultFolder) return;
            nextDownloads = {...nextDownloads, defaultFolder};
        }

        if (!nextDownloads.userFolder) {
            nextDownloads = {...nextDownloads, userFolder: defaultFolder};
        }

        if (nextDownloads === downloads) return;

        await this.settings.save({
            ...this.settings.data,
            downloads: nextDownloads
        });
    }

    /**
     * Queues an operation after the preceding settings save has settled.
     *
     * @param {() => Promise<unknown>} operation - The save-related operation to queue.
     * @returns {Promise<unknown>} The queued operation result.
     */
    enqueue(operation) {
        const nextSave = this.#pendingSave
            .catch(() => undefined)
            .then(operation);

        this.#pendingSave = nextSave;
        return nextSave;
    }

    /**
     * Waits until the current queued settings save has settled.
     *
     * @returns {Promise<void>}
     */
    async waitForPendingSave() {
        await this.#pendingSave;
    }

    /**
     * Deletes the stored settings profile for the current website.
     *
     * @returns {Promise<void>}
     */
    async deleteCurrentWebsiteProfile() {
        return this.enqueue(async () => {
            await this.settings.deleteCurrentWebsiteProfile();
            await this.refresh();
            await this.notifySettingsChanged();
        });
    }

    /**
     * Notifies the settings consumer after a persisted settings change.
     *
     * @returns {Promise<void>}
     */
    async notifySettingsChanged() {
        if (typeof this.onSettingsChanged === 'function') {
            await this.onSettingsChanged(this.settings.data);
        }
    }

    /**
     * Reads the complete settings form into a copy of the current settings data.
     *
     * @returns {Object} The settings data represented by the form controls.
     */
    getFormData() {
        const data = Object.fromEntries(
            Object.entries(this.settings.data ?? {}).map(([sectionName, section]) => [
                sectionName,
                {...section}
            ])
        );
        const fieldsets = this.form.querySelectorAll('fieldset[name]');

        fieldsets.forEach(fs => {
            const sectionName = fs.name;
            data[sectionName] ??= {};

            fs.querySelectorAll('input[name], select[name], textarea[name]').forEach(ctr => {
                const value = this.getValue(ctr);
                if (value !== undefined) data[sectionName][ctr.name] = value;
            });
        });

        return data;
    }

    /**
     * Writes settings data into the matching form controls.
     *
     * @param {Object} data - The settings data to display.
     * @returns {void}
     */
    setFormData(data) {
        this.form.querySelectorAll('fieldset[name]').forEach(fs => {
            const section = data[fs.name];
            if (!section) return;

            fs.querySelectorAll('input[name], select[name], textarea[name]').forEach(ctr => {
                if (ctr.name in section) this.setValue(ctr, section[ctr.name]);
            });
        });
    }

    /**
     * Reads a normalized value from a supported settings form control.
     *
     * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} control - The control to read.
     * @returns {boolean|number|string|undefined} The normalized control value.
     */
    getValue(control) {
        switch (control.type) {
            case 'checkbox':
                return control.checked;

            case 'radio':
                return control.checked ? control.value : undefined;

            case 'number':
            case 'range':
                return Number(control.value);

            default:
                return control.value;
        }
    }

    /**
     * Writes a value to a supported settings form control.
     *
     * @param {HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement} control - The control to update.
     * @param {boolean|number|string} value - The value to write.
     * @returns {void}
     */
    setValue(control, value) {
        switch (control.type) {
            case 'checkbox':
                control.checked = Boolean(value);
                break;

            case 'radio':
                control.checked = control.value === value;
                break;

            default:
                control.value = value;
                break;
        }
    }

    /**
     * Opens the browser download settings when the browser permits it.
     *
     * @returns {Promise<void>}
     */
    async openBrowserDownloadSettings() {
        const isFirefox = typeof browser !== 'undefined' &&
            typeof browser.runtime?.getBrowserInfo === 'function';

        if (isFirefox) {
            this.#log('Firefox does not allow extensions to open privileged about: settings pages.', 'info');
            return;
        }

        await window.chrome.tabs.create({url: 'chrome://settings/downloads'});
    }

    // Registers the settings form event listeners once.
    #setEventListeners() {
        if (this.hasEventListeners) return;

        this.form.addEventListener('change', () => {
            this.#updateDeepScanControls();
            this.#updateDebugControls();
            const data = this.getFormData();

            this.enqueue(async () => {
                await this.settings.save(data);
                await this.refresh();
                await this.notifySettingsChanged();
            }).catch(error => {
                this.#log('Cannot save settings:', 'warn', error);
            });
        });
        this.DOM.btnDownloadFolder.addEventListener('click', () => {
            this.openBrowserDownloadSettings().catch(error => {
                this.#log('Cannot open browser download settings:', 'warn', error);
            });
        });
        this.DOM.btnDeleteProfile?.addEventListener('click', () => {
            this.deleteCurrentWebsiteProfile().catch(error => {
                this.#log('Cannot delete website profile:', 'warn', error);
            });
        });
        this.hasEventListeners = true;
    }

    // Updates the dependent image-size controls.
    #updateImageSizeControls() {
        const disabled = !this.DOM.chkIgnoreSizes.checked;

        this.DOM.inpMinWidth.disabled = disabled;
        this.DOM.inpMinHeight.disabled = disabled;
        this.DOM.inpMinimumFileSize.disabled = disabled;
        this.DOM.spnMinSize.toggleAttribute('disabled', disabled);
    }

    // Updates the protected DeepScan control state.
    #updateDeepScanControls() {
        const backgroundScan = this.DOM.chkAllowBackgroundScan;
        const protectedDeepScan = this.DOM.chkAllowProtectedDeepScan;
        if (!backgroundScan || !protectedDeepScan) return false;

        const enabled = backgroundScan.checked === true;
        const wasChecked = protectedDeepScan.checked === true;

        if (!enabled) protectedDeepScan.checked = false;
        protectedDeepScan.disabled = !enabled;

        return !enabled && wasChecked;
    }

    // Updates the dependent debug-log controls.
    #updateDebugControls() {
        const debugMode = this.DOM.chkDebugmode;
        if (!debugMode) return;

        const disabled = !debugMode.checked;

        [
            this.DOM.chkLogPopupConsole,
            this.DOM.chkLogTabConsole,
            this.DOM.chkLogServiceWorkerConsole
        ].filter(Boolean).forEach(ctr => {
            ctr.disabled = disabled;
        });
    }

    // Updates the user-defined download folder controls.
    #updateDownloadFolderControls() {
        const selected = Array.from(this.downloadFolderRadios).find(rad => rad.checked);
        const disabled = selected?.value !== 'user';

        this.DOM.inpUserFolder.disabled = disabled;
        this.DOM.btnDownloadFolder.disabled = disabled;
    }

    // Updates the exclude-list input state.
    #updateExcludeListControls() {
        this.DOM.inpExcludeList.disabled = !this.DOM.chkExcludeList.checked;
    }

    // Updates the website-profile retention control.
    #updateWebsiteProfileControls() {
        this.DOM.inpKeepSettingsForDays.disabled = !this.DOM.chkSaveSettingsForURL.checked;
    }

    // Updates whether the active website profile can be deleted.
    async #updateDeleteProfileButton() {
        if (!this.DOM.btnDeleteProfile) return;

        this.DOM.btnDeleteProfile.disabled = !(await this.settings.hasCurrentWebsiteProfile());
    }

    // Logs a panel message with an optional error object.
    #log(message, method = 'info', error) {
        if (error === undefined) {
            console[method](message);
        } else {
            console[method](message, error);
        }
    }
}