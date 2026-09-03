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

export class SettingsView {
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
        this.settings.form = this.form;

        if (loadSettings) {
            await this.settings.run();
        } else {
            this.settings.bindForm();
        }

        await this.setDefaultDownloadFolder();
        this.setEventListeners();
        await this.updateUI();
    }

    async setDefaultDownloadFolder() {
        let defaultFolder = this.settings.get('downloads', 'defaultFolder', '');
        let shouldSave = false;
        const changedSettings = [];

        if (!defaultFolder) {
            try {
                defaultFolder = await this.settings.getMostLikelyDownloadFolder();

                if (!defaultFolder) return;

                this.settings.data.downloads.defaultFolder = defaultFolder;
                shouldSave = true;
                changedSettings.push({section: 'downloads', key: 'defaultFolder'});
            } catch (error) {
                console.warn('Could not determine download folder:', error);
                return;
            }
        }

        if (!this.settings.get('downloads', 'userFolder', '')) {
            this.DOM.inpUserFolder.value = defaultFolder;
            this.settings.data.downloads.userFolder = defaultFolder;
            shouldSave = true;
            changedSettings.push({section: 'downloads', key: 'userFolder'});
        }

        if (shouldSave) {
            for (const changedSetting of changedSettings) {
                await this.settings.save(changedSetting);
            }
        }
    }

    setEventListeners() {
        if (this.hasEventListeners) return;

        this.DOM.chkIgnoreSizes.addEventListener('change',() => this.updateImageSizeControls());
        this.DOM.chkExcludeList.addEventListener('change',() => this.updateExcludeListControls());
        this.DOM.chkSaveSettingsForURL.addEventListener('change',() => this.updateWebsiteProfileControls());
        this.DOM.btnDownloadFolder.addEventListener('click',() => this.openBrowserDownloadSettings());
        this.DOM.btnDeleteProfile?.addEventListener('click', () => {
            this.deleteCurrentWebsiteProfile().catch(error => {
                console.warn('Cannot delete website profile:', error);
            });
        });
        this.downloadFolderRadios.forEach(rad => {
            rad.addEventListener('change', () => this.updateDownloadFolderControls());
        });
        this.form.addEventListener('change', () => {
            this.handleSettingsChange().catch(error => {
                console.warn('Cannot update settings UI:', error);
            });
        });
        this.hasEventListeners = true;
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

    async handleSettingsChange() {
        await this.settings.waitForPendingSave();
        await this.updateDeleteProfileButton();
        await this.notifySettingsChanged();
    }

    async deleteCurrentWebsiteProfile() {
        await this.settings.waitForPendingSave();
        await this.settings.deleteCurrentWebsiteProfile();
        await this.updateUI();
        await this.notifySettingsChanged();
    }

    async notifySettingsChanged() {
        if (typeof this.onSettingsChanged === 'function') {
            await this.onSettingsChanged(this.settings.data);
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
