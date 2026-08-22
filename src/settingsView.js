export async function loadSettingsForm(container) {
    const target = typeof container === 'string'
        ? document.getElementById(container)
        : container;

    if (!target) {
        throw new Error('Settings form container not found');
    }

    const response = await fetch(new URL('../ui/settings-form.html', import.meta.url));
    if (!response.ok) {
        throw new Error('Cannot load settings form');
    }

    target.innerHTML = await response.text();
    return target.querySelector('#frmSettings');
}

export class SettingsView {
    constructor(settings, form) {
        this.settings = settings;
        this.form = form;
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
        this.updateUI();
    }

    async setDefaultDownloadFolder() {
        let defaultFolder = this.settings.get('downloads', 'defaultFolder', '');
        let shouldSave = false;

        if (!defaultFolder) {
            try {
                defaultFolder = await this.settings.getMostLikelyDownloadFolder();

                if (!defaultFolder) return;

                this.settings.data.downloads.defaultFolder = defaultFolder;
                shouldSave = true;
            } catch (error) {
                console.warn('Could not determine download folder:', error);
                return;
            }
        }

        if (!this.settings.get('downloads', 'userFolder', '')) {
            this.DOM.inpUserFolder.value = defaultFolder;
            shouldSave = true;
        }

        if (shouldSave) {
            await this.settings.save();
        }
    }

    setEventListeners() {
        if (this.hasEventListeners) return;

        this.DOM.sldMinimumFileSize.addEventListener(
            'input',
            () => this.updateMinimumFileSize()
        );
        this.DOM.chkIgnoreSizes.addEventListener(
            'change',
            () => this.updateImageSizeControls()
        );
        this.DOM.chkExcludeList.addEventListener(
            'change',
            () => this.updateExcludeListControls()
        );
        this.downloadFolderRadios.forEach((radio) => {
            radio.addEventListener('change', () => this.updateDownloadFolderControls());
        });

        this.hasEventListeners = true;
    }

    updateUI() {
        this.updateMinimumFileSize();
        this.updateImageSizeControls();
        this.updateDownloadFolderControls();
        this.updateExcludeListControls();
    }

    updateMinimumFileSize() {
        this.DOM.spnMinSize.innerText = ` ${this.DOM.sldMinimumFileSize.value} KB`;
    }

    updateImageSizeControls() {
        const disabled = !this.DOM.chkIgnoreSizes.checked;

        this.DOM.inpMinWidth.disabled = disabled;
        this.DOM.inpMinHeight.disabled = disabled;
        this.DOM.sldMinimumFileSize.disabled = disabled;
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
}
