const WEBSITE_PROFILES_STORAGE_KEY = 'websiteProfiles';
const MIN_PROFILE_DURATION_DAYS = 1;
const MAX_PROFILE_DURATION_DAYS = 365;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

export class Settings {
    #form = null;
    #boundForm = null;
    #pendingSave = Promise.resolve();
    #onFormChange = () => {
        this.#pendingSave = this.save();
    };
    #websiteOrigin = null;
    #activeWebsiteProfile = false;
    #globalData = {};

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

    setWebsiteOrigin(url) {
        try {
            const parsedUrl = new URL(url);

            this.#websiteOrigin = ['http:', 'https:'].includes(parsedUrl.protocol)
                ? parsedUrl.origin
                : null;
        } catch {
            this.#websiteOrigin = null;
        }

        return this.#websiteOrigin;
    }

    async run() {
        await this.load();
        this.bindForm();
        return this.data;
    }

    bindForm(form = this.form) {
        this.form = form;
        if (!this.form) return;

        this.setFormData(this.data);
        if (this.#boundForm === this.form) return;

        this.#boundForm?.removeEventListener('change', this.#onFormChange);
        this.form.addEventListener('change', this.#onFormChange);
        this.#boundForm = this.form;
    }

    async load() {
        const stored = await window.chrome.storage.local.get(this.storageKey);
        const savedData = stored[this.storageKey] ?? {};
        const savedFilters = savedData.filters;
        const hasLegacyBlurSetting = savedFilters &&
            Object.prototype.hasOwnProperty.call(savedFilters, 'ignoreBlurredImages');
        let migratedData = savedData;

        if (hasLegacyBlurSetting) {
            const {ignoreBlurredImages, ...filters} = savedFilters;

            if (!Object.prototype.hasOwnProperty.call(filters, 'scanBlurredImages')) {
                filters.scanBlurredImages = ignoreBlurredImages !== true;
            }

            migratedData = {...savedData, filters};
        }

        this.data = this.mergeData(DEFAULT_SETTINGS, migratedData);
        this.#globalData = this.cloneData(this.data);
        this.#activeWebsiteProfile = false;

        if (this.form || hasLegacyBlurSetting) {
            // Saves new/default controls automatically if the markup was extended.
            await window.chrome.storage.local.set({
                [this.storageKey]: this.#globalData
            });
        }

        await this.loadWebsiteProfile();

        if (this.form) {
            this.setFormData(this.data);
        }

        return this.data;
    }

    async save() {
        const nextData = this.form
            ? this.mergeData(this.data, this.getFormData())
            : this.data;
        const saveWebsiteProfile = nextData.common?.saveSettingsForURL === true &&
            this.#websiteOrigin !== null;

        if (saveWebsiteProfile) {
            const keepSettingsForDays = this.getProfileDuration(nextData.common.keepSettingsForDays);

            if (keepSettingsForDays === null) {
                console.warn('Cannot save website profile: invalid keepSettingsForDays value');
                return this.data;
            }

            this.data = nextData;
            this.#activeWebsiteProfile = true;
            await this.saveWebsiteProfile(keepSettingsForDays);
            return this.data;
        }

        if (this.#activeWebsiteProfile && this.#websiteOrigin !== null) {
            this.#activeWebsiteProfile = false;
            this.data = this.cloneData(this.#globalData);
            this.setFormData(this.data);
            await this.deleteWebsiteProfile();
            return this.data;
        }

        this.data = nextData;
        this.#globalData = this.cloneData(this.data);

        await window.chrome.storage.local.set({[this.storageKey]: this.#globalData});

        return this.data;
    }

    async waitForPendingSave() {
        await this.#pendingSave;
    }

    async loadWebsiteProfile() {
        if (!this.#websiteOrigin) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {};
        const profile = profiles[this.#websiteOrigin];

        if (!profile) return;

        const isValidProfile = profile.origin === this.#websiteOrigin &&
            profile.settings && typeof profile.settings === 'object' &&
            Number.isFinite(profile.expiresAt) && profile.expiresAt > Date.now();

        if (!isValidProfile) {
            await this.deleteWebsiteProfile(profiles);
            return;
        }

        this.data = this.mergeData(DEFAULT_SETTINGS, profile.settings);
        if (this.getProfileDuration(this.data.common.keepSettingsForDays) === null) {
            this.data.common.keepSettingsForDays = DEFAULT_SETTINGS.common.keepSettingsForDays;
        }
        this.data.common.saveSettingsForURL = true;
        this.#activeWebsiteProfile = true;
    }

    async saveWebsiteProfile(keepSettingsForDays) {
        if (!this.#websiteOrigin) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = {...(stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {})};

        profiles[this.#websiteOrigin] = {
            origin: this.#websiteOrigin,
            settings: this.cloneData(this.data),
            expiresAt: Date.now() + keepSettingsForDays * MILLISECONDS_PER_DAY
        };

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: profiles
        });
    }

    async deleteWebsiteProfile(existingProfiles = null) {
        if (!this.#websiteOrigin) return;

        const profiles = existingProfiles ?? (
            await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY)
        )[WEBSITE_PROFILES_STORAGE_KEY] ?? {};

        if (!Object.prototype.hasOwnProperty.call(profiles, this.#websiteOrigin)) return;

        const nextProfiles = {...profiles};
        delete nextProfiles[this.#websiteOrigin];

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: nextProfiles
        });
    }

    getProfileDuration(value) {
        const days = Number(value);

        return Number.isInteger(days) &&
            days >= MIN_PROFILE_DURATION_DAYS &&
            days <= MAX_PROFILE_DURATION_DAYS
            ? days
            : null;
    }

    cloneData(data) {
        return Object.fromEntries(
            Object.entries(data ?? {}).map(([sectionName, section]) => [
                sectionName,
                {...section}
            ])
        );
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
        allowBackgroundScan: false,
        scanOnSettingsChanged: true,
        saveSettingsForURL: false,
        keepSettingsForDays: 30
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
        minwidth: 16,
        minheight: 16,
        minimumfilesize: 16
    },
    imagetypes: {
        jpg: true,
        png: true,
        bmp: true,
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
        scanBlurredImages: true,
        hasExcludeList: false,
        excludeList: 'logo, avatar'
    }
};