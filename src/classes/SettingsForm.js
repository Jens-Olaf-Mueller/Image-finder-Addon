export async function loadSettingsForm(container) {
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

export class SettingsForm {
    #pendingSave = Promise.resolve();

    constructor(settings, form, {onSettingsChanged = null} = {}) {
        this.settings = settings;
        this.form = form;
        this.onSettingsChanged = onSettingsChanged;
        this.DOM = {};
        this.hasEventListeners = false;

        this.form.querySelectorAll('[id]').forEach((element) => {
            this.DOM[element.id] = element;
        });
        this.downloadFolderRadios = this.form.querySelectorAll(
            'input[name="downloadFolder"]'
        );
    }

    async run({loadSettings = true} = {}) {
        if (loadSettings) await this.settings.run();

        await this.setDefaultDownloadFolder();
        await this.refresh();
        this.setEventListeners();
    }

    async refresh() {
        this.setFormData(this.settings.data);
        await this.updateUI();
    }

    async setDefaultDownloadFolder() {
        const downloads = this.settings.get('downloads', null, {});
        let defaultFolder = downloads.defaultFolder ?? '';
        let nextDownloads = downloads;

        if (!defaultFolder) {
            try {
                defaultFolder = await this.settings.getMostLikelyDownloadFolder();
            } catch (error) {
                console.warn('Could not determine download folder:', error);
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

    setEventListeners() {
        if (this.hasEventListeners) return;

        this.form.addEventListener('change', () => {
            const data = this.getFormData();

            this.enqueue(async () => {
                await this.settings.save(data);
                await this.refresh();
                await this.notifySettingsChanged();
            }).catch(error => {
                console.warn('Cannot save settings:', error);
            });
        });
        this.DOM.btnDownloadFolder.addEventListener('click', () => {
            this.openBrowserDownloadSettings().catch(error => {
                console.warn('Cannot open browser download settings:', error);
            });
        });
        this.DOM.btnDeleteProfile?.addEventListener('click', () => {
            this.deleteCurrentWebsiteProfile().catch(error => {
                console.warn('Cannot delete website profile:', error);
            });
        });
        this.hasEventListeners = true;
    }

    enqueue(operation) {
        const nextSave = this.#pendingSave
            .catch(() => undefined)
            .then(operation);

        this.#pendingSave = nextSave;
        return nextSave;
    }

    async waitForPendingSave() {
        await this.#pendingSave;
    }

    async updateUI() {
        this.updateImageSizeControls();
        this.updateDownloadFolderControls();
        this.updateExcludeListControls();
        this.updateWebsiteProfileControls();
        await this.updateDeleteProfileButton();
    }

    updateImageSizeControls() {
        const disabled = !this.DOM.chkIgnoreSizes.checked;

        this.DOM.inpMinWidth.disabled = disabled;
        this.DOM.inpMinHeight.disabled = disabled;
        this.DOM.inpMinimumFileSize.disabled = disabled;
        this.DOM.spnMinSize.toggleAttribute('disabled', disabled);
    }

    updateDownloadFolderControls() {
        const selected = Array.from(this.downloadFolderRadios)
            .find((radio) => radio.checked);
        const disabled = selected?.value !== 'user';

        this.DOM.inpUserFolder.disabled = disabled;
        this.DOM.btnDownloadFolder.disabled = disabled;
    }

    updateExcludeListControls() {
        this.DOM.inpExcludeList.disabled = !this.DOM.chkExcludeList.checked;
    }

    updateWebsiteProfileControls() {
        this.DOM.inpKeepSettingsForDays.disabled = !this.DOM.chkSaveSettingsForURL.checked;
    }

    async updateDeleteProfileButton() {
        if (!this.DOM.btnDeleteProfile) return;

        this.DOM.btnDeleteProfile.disabled = !(await this.settings.hasCurrentWebsiteProfile());
    }

    async deleteCurrentWebsiteProfile() {
        return this.enqueue(async () => {
            await this.settings.deleteCurrentWebsiteProfile();
            await this.refresh();
            await this.notifySettingsChanged();
        });
    }

    async notifySettingsChanged() {
        if (typeof this.onSettingsChanged === 'function') {
            await this.onSettingsChanged(this.settings.data);
        }
    }

    getFormData() {
        const data = {};
        const fieldsets = this.form.querySelectorAll('fieldset[name]');

        fieldsets.forEach((fieldset) => {
            const sectionName = fieldset.name;
            data[sectionName] = {};

            fieldset.querySelectorAll('input[name], select[name], textarea[name]').forEach(
                (control) => {
                    const value = this.getControlValue(control);

                    if (value !== undefined) {
                        data[sectionName][control.name] = value;
                    }
                }
            );
        });

        return data;
    }

    setFormData(data) {
        this.form.querySelectorAll('fieldset[name]').forEach((fieldset) => {
            const section = data[fieldset.name];
            if (!section) return;

            fieldset.querySelectorAll('input[name], select[name], textarea[name]').forEach(
                (control) => {
                    if (control.name in section) {
                        this.setControlValue(control, section[control.name]);
                    }
                }
            );
        });
    }

    getControlValue(control) {
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

    setControlValue(control, value) {
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

    async openBrowserDownloadSettings() {
        const isFirefox = typeof browser !== 'undefined' &&
            typeof browser.runtime?.getBrowserInfo === 'function';

        if (isFirefox) {
            console.info('Firefox does not allow extensions to open privileged about: settings pages.');
            return;
        }

        await window.chrome.tabs.create({url: 'chrome://settings/downloads'});
    }
}
