export class Settings {
    #form = null;
    get form() { return this.#form; }
    set form(newForm) {
        if (newForm instanceof HTMLFormElement) {
            this.#form = newForm;
        } else if (typeof newForm === 'string') {
            this.#form = document.getElementById(newForm);
        } else {
            this.#form = null;
        }
    }

    constructor(form, storageKey = 'settings') {
        this.form = form;
        this.storageKey = storageKey;
        this.data = {};
    }

    async run() {
        await this.load();

        if (this.form) this.form.addEventListener('change', () => this.save());
        return this.data;
    }

    async load() {
        const stored = await window.chrome.storage.local.get(this.storageKey);
        const savedData = stored[this.storageKey] ?? {};

        this.data = this.mergeData(DEFAULT_SETTINGS, savedData);

        if (this.form) {
            this.setFormData(this.data);

            // Saves new/default controls automatically if the markup was extended.
            await window.chrome.storage.local.set({
                [this.storageKey]: this.data
            });
        }

        return this.data;
    }

    async save() {
        if (this.form) this.data = this.mergeData(this.data, this.getFormData());

        await window.chrome.storage.local.set({
            [this.storageKey]: this.data
        });

        return this.data;
    }

    get(section, key = null, defaultValue = null) {
        if (key === null) return this.data?.[section] ?? defaultValue;
        return this.data?.[section]?.[key] ?? defaultValue;
    }

    getFormData() {
        const data = {};

        if (!this.form) return data;

        const fieldsets = this.form.querySelectorAll('fieldset[name]');

        fieldsets.forEach((fieldset) => {
            const sectionName = fieldset.name;
            data[sectionName] = {};

            const controls = fieldset.querySelectorAll(
                'input[name], select[name], textarea[name]'
            );

            controls.forEach((control) => {
                const value = this.getControlValue(control);

                if (value !== undefined) {
                    data[sectionName][control.name] = value;
                }
            });
        });

        return data;
    }

    setFormData(data) {
        if (!this.form) return;

        const fieldsets = this.form.querySelectorAll('fieldset[name]');

        fieldsets.forEach((fieldset) => {
            const section = data[fieldset.name];
            if (!section) return;

            const controls = fieldset.querySelectorAll(
                'input[name], select[name], textarea[name]'
            );

            controls.forEach((ctrl) => {
                if (!(ctrl.name in section)) return;
                this.setControlValue(ctrl, section[ctrl.name]);
            });
        });
    }

    getControlValue(control) {
        switch (control.type) {
            case 'checkbox':
                return control.checked;

            case 'radio':
                return control.checked
                    ? control.value
                    : undefined;

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

    mergeData(defaultData, savedData) {
        const mergedData = Object.fromEntries(
            Object.entries(savedData ?? {}).map(([sectionName, section]) => [
                sectionName,
                {...section}
            ])
        );

        Object.entries(defaultData).forEach(([sectionName, section]) => {
            mergedData[sectionName] ??= {};

            Object.entries(section).forEach(([key, defaultValue]) => {
                mergedData[sectionName][key] =
                    savedData?.[sectionName]?.[key] ?? defaultValue;
            });
        });

        return mergedData;
    }

    async getMostLikelyDownloadFolder(limit = 50) {
        const downloads = await window.chrome.downloads.search({
            state: 'complete',
            orderBy: ['-startTime'],
            limit
        });

        const folders = new Map();

        for (const dwnl of downloads) {
            if (!dwnl.filename) continue;

            const folder = dwnl.filename.replace(/[\\/][^\\/]+$/, '');
            if (!folder || folder === dwnl.filename) continue;

            folders.set(
                folder,
                (folders.get(folder) ?? 0) + 1
            );
        }

        let likelyFolder = '';
        let highestCount = 0;

        for (const [folder, count] of folders) {
            if (count > highestCount) {
                highestCount = count;
                likelyFolder = folder;
            }
        }

        return likelyFolder;
    }
};

export const DEFAULT_SETTINGS = {
    common: {
        scanOnStart: true,
        backGroundScan: false
    },
    downloads: {
        downloadFolder: 'prompt',
        userFolder: '',
        defaultFolder: '',
        zipFileList: false,
        disableDownloadWhenDone: false
    },
    filesizes: {
        ignoresizes: true,
        minwidth: 200,
        minheight: 200,
        minimumfilesize: 128
    },
    imagetypes: {
        jpg: true,
        png: true,
        webp: true,
        gif: true,
        svg: false,
        avif: false
    },
    sources: {
        imageelements: true,
        backgroundimages: true,
        linkedimages: true,
        dataimages: false,
        blobimages: false
    },
    filters: {
        removeDuplicates: true,
        ignoreHiddenImages: false,
        ignoreBlurredImages: false,
        hasExcludeList: false,
        excludeList: ''
    }
};