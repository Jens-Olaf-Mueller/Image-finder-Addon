const WEBSITE_PROFILES_STORAGE_KEY = 'websiteProfiles';
const MIN_PROFILE_DURATION_DAYS = 1;
const MAX_PROFILE_DURATION_DAYS = 365;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const PIXEL_BLUR_SETTINGS_VERSION = 2;
const WEBSITE_PROFILE_SCOPE_ORIGIN = 'origin';
const WEBSITE_PROFILE_SCOPE_PATHNAME = 'pathname';

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function migrateBlurSettings(data) {
    const savedFilters = data?.filters;
    const hasSetting = (key) => savedFilters &&
        Object.prototype.hasOwnProperty.call(savedFilters, key);
    const hasLegacyScanBlurSetting = hasSetting('scanBlurredImages');
    const hasUnmarkedIgnoreBlurredSetting = hasSetting('ignoreBlurredImages') &&
        savedFilters.blurSettingsVersion !== PIXEL_BLUR_SETTINGS_VERSION;

    if (!hasLegacyScanBlurSetting && !hasUnmarkedIgnoreBlurredSetting) {
        return {data, migrated: false};
    }

    const filters = {...savedFilters};
    delete filters.scanBlurredImages;
    delete filters.ignoreBlurredImages;
    delete filters.blurSettingsVersion;

    return {
        data: {
            ...data,
            filters: {
                ...filters,
                ignoreBlurredImages: true,
                blurSettingsVersion: PIXEL_BLUR_SETTINGS_VERSION
            }
        },
        migrated: true
    };
}

function migrateDuplicateSettings(data) {
    const savedFilters = data?.filters;
    const hasLegacySetting = savedFilters &&
        Object.prototype.hasOwnProperty.call(savedFilters, 'removeDuplicates');

    if (!hasLegacySetting) return {data, migrated: false};

    const filters = {...savedFilters};

    if (!Object.prototype.hasOwnProperty.call(filters, 'ignoreDuplicates')) {
        filters.ignoreDuplicates = filters.removeDuplicates;
    }
    delete filters.removeDuplicates;

    return {
        data: {
            ...data,
            filters
        },
        migrated: true
    };
}

function migrateSettings(data) {
    const blurMigration = migrateBlurSettings(data);
    const duplicateMigration = migrateDuplicateSettings(blurMigration.data);

    return {
        data: duplicateMigration.data,
        migrated: blurMigration.migrated || duplicateMigration.migrated
    };
}

function removeObsoleteGlobalWebsiteProfileScope(data) {
    if (!isObject(data?.common) || !Object.prototype.hasOwnProperty.call(
        data.common,
        'websiteProfileScope'
    )) {
        return {data, migrated: false};
    }

    const common = {...data.common};
    delete common.websiteProfileScope;

    return {
        data: {
            ...data,
            common
        },
        migrated: true
    };
}

function normalizeWebsiteProfileScopeValue(scope) {
    return scope === WEBSITE_PROFILE_SCOPE_PATHNAME
        ? WEBSITE_PROFILE_SCOPE_PATHNAME
        : WEBSITE_PROFILE_SCOPE_ORIGIN;
}

function getStoredWebsiteProfileScope(settings) {
    const scope = settings?.common?.websiteProfileScope;

    return [WEBSITE_PROFILE_SCOPE_ORIGIN, WEBSITE_PROFILE_SCOPE_PATHNAME].includes(scope)
        ? scope
        : null;
}

function withWebsiteProfileScope(settings, scope) {
    const normalizedScope = normalizeWebsiteProfileScopeValue(scope);
    const currentSettings = isObject(settings) ? settings : {};
    const currentCommon = isObject(currentSettings.common)
        ? currentSettings.common
        : {};

    if (currentCommon.websiteProfileScope === normalizedScope) return currentSettings;

    return {
        ...currentSettings,
        common: {
            ...currentCommon,
            websiteProfileScope: normalizedScope
        }
    };
}

function migrateWebsiteProfiles(profiles) {
    if (!isObject(profiles)) return {profiles: {}, migrated: false};

    let migrated = false;
    const migratedProfiles = {...profiles};

    Object.entries(profiles).forEach(([origin, profile]) => {
        if (!isObject(profile)) return;

        let migratedProfile = profile;
        const urls = isObject(profile.urls) ? profile.urls : {};

        if (profile.urls !== urls) {
            migratedProfile = {...migratedProfile, urls};
            migrated = true;
        }

        let settings = migratedProfile.settings;

        if (isObject(settings)) {
            const settingsMigration = migrateSettings(settings);

            settings = settingsMigration.data;
            if (settingsMigration.migrated) migrated = true;
        }

        const legacyRootScope = migratedProfile.urls['/']?.websiteProfileScope;
        const legacyProfileScope = migratedProfile.websiteProfileScope;
        const scope = getStoredWebsiteProfileScope(settings) ??
            normalizeWebsiteProfileScopeValue(legacyRootScope ?? legacyProfileScope);
        const settingsWithScope = withWebsiteProfileScope(settings, scope);

        if (settingsWithScope !== migratedProfile.settings) {
            migratedProfile = {...migratedProfile, settings: settingsWithScope};
            migrated = true;
        }

        Object.entries(migratedProfile.urls).forEach(([pathname, urlProfile]) => {
            if (!isObject(urlProfile)) return;

            let migratedUrlProfile = urlProfile;

            if (isObject(urlProfile.settings)) {
                const settingsMigration = migrateSettings(urlProfile.settings);

                if (settingsMigration.migrated) {
                    migratedUrlProfile = {
                        ...migratedUrlProfile,
                        settings: settingsMigration.data
                    };
                    migrated = true;
                }
            }

            if (Object.prototype.hasOwnProperty.call(
                migratedUrlProfile,
                'websiteProfileScope'
            )) {
                const {websiteProfileScope, ...urlProfileWithoutScope} = migratedUrlProfile;

                migratedUrlProfile = urlProfileWithoutScope;
                migrated = true;
            }

            if (migratedUrlProfile === urlProfile) return;

            migratedProfile = {
                ...migratedProfile,
                urls: {
                    ...migratedProfile.urls,
                    [pathname]: migratedUrlProfile
                }
            };
        });

        if (Object.prototype.hasOwnProperty.call(migratedProfile, 'websiteProfileScope')) {
            const {websiteProfileScope, ...profileWithoutScope} = migratedProfile;

            migratedProfile = profileWithoutScope;
            migrated = true;
        }

        if (migratedProfile !== profile) {
            migratedProfiles[origin] = migratedProfile;
        }
    });

    return {
        profiles: migrated ? migratedProfiles : profiles,
        migrated
    };
}

export class Settings {
    #form = null;
    #boundForm = null;
    #pendingSave = Promise.resolve();
    #onFormChange = (event) => {
        this.#pendingSave = this.save(event.target);
    };
    #websiteOrigin = null;
    #websitePathname = null;
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
            const isWebsiteUrl = ['http:', 'https:'].includes(parsedUrl.protocol);

            this.#websiteOrigin = isWebsiteUrl
                ? parsedUrl.origin
                : null;
            this.#websitePathname = isWebsiteUrl
                ? parsedUrl.pathname
                : null;
        } catch {
            this.#websiteOrigin = null;
            this.#websitePathname = null;
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
        const {data: migratedData, migrated: settingsMigrated} =
            migrateSettings(savedData);
        const {
            data: cleanedData,
            migrated: removedObsoleteScope
        } = removeObsoleteGlobalWebsiteProfileScope(migratedData);

        this.data = this.mergeData(DEFAULT_SETTINGS, cleanedData);
        this.#globalData = this.cloneData(this.data);
        this.#activeWebsiteProfile = false;

        if (this.form || settingsMigrated || removedObsoleteScope) {
            // Saves new/default controls automatically if the markup was extended.
            await window.chrome.storage.local.set({
                [this.storageKey]: this.getPersistedGlobalData()
            });
        }

        await this.loadWebsiteProfile();

        if (this.form) {
            this.setFormData(this.data);
        }

        return this.data;
    }

    async save(changedControl = null) {
        const nextData = this.form
            ? this.mergeData(this.data, this.getFormData())
            : this.data;
        nextData.common.websiteProfileScope = this.normalizeWebsiteProfileScope(
            nextData.common.websiteProfileScope
        );

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
            await this.saveWebsiteProfile(
                keepSettingsForDays,
                this.getChangedSetting(changedControl, nextData)
            );
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

        await window.chrome.storage.local.set({
            [this.storageKey]: this.getPersistedGlobalData()
        });

        return this.data;
    }

    async resetToDefaults() {
        this.data = this.cloneData(DEFAULT_SETTINGS);
        this.#globalData = this.cloneData(DEFAULT_SETTINGS);
        this.#activeWebsiteProfile = false;
        this.setFormData(this.data);

        await window.chrome.storage.local.set({
            [this.storageKey]: this.getPersistedGlobalData()
        });

        return this.data;
    }

    async waitForPendingSave() {
        await this.#pendingSave;
    }

    async loadWebsiteProfile() {
        if (!this.#websiteOrigin) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const {
            profiles,
            migrated: requiresMigration
        } = migrateWebsiteProfiles(stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {});
        const profile = profiles[this.#websiteOrigin];

        if (!profile) {
            if (requiresMigration) {
                await window.chrome.storage.local.set({
                    [WEBSITE_PROFILES_STORAGE_KEY]: profiles
                });
            }
            return;
        }

        if (!this.isWebsiteProfileValid(profile)) {
            await this.deleteWebsiteProfile(profiles);
            return;
        }

        this.applyWebsiteProfile(profile);

        if (requiresMigration) {
            await window.chrome.storage.local.set({
                [WEBSITE_PROFILES_STORAGE_KEY]: profiles
            });
        }
    }

    async hasCurrentWebsiteProfile() {
        if (!this.#websiteOrigin) return false;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const {
            profiles,
            migrated: requiresMigration
        } = migrateWebsiteProfiles(stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {});
        const profile = profiles[this.#websiteOrigin];

        if (!this.isWebsiteProfileValid(profile)) {
            if (profile) await this.deleteWebsiteProfile(profiles);
            return false;
        }

        if (requiresMigration) {
            await window.chrome.storage.local.set({
                [WEBSITE_PROFILES_STORAGE_KEY]: profiles
            });
        }

        return true;
    }

    async saveWebsiteProfile(keepSettingsForDays, changedSetting = null) {
        if (!this.#websiteOrigin) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const {profiles: migratedProfiles} = migrateWebsiteProfiles(
            stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {}
        );
        const profiles = {...migratedProfiles};
        const currentProfile = isObject(profiles[this.#websiteOrigin])
            ? profiles[this.#websiteOrigin]
            : {};
        const profile = {
            ...currentProfile,
            origin: this.#websiteOrigin,
            urls: {...(isObject(currentProfile.urls) ? currentProfile.urls : {})},
            expiresAt: Date.now() + keepSettingsForDays * MILLISECONDS_PER_DAY
        };
        const selectedScope = this.normalizeWebsiteProfileScope(
            this.data.common.websiteProfileScope
        );
        const scopeChanged = changedSetting?.section === 'common' &&
            changedSetting.key === 'websiteProfileScope';
        const saveForPath = !scopeChanged &&
            selectedScope === WEBSITE_PROFILE_SCOPE_PATHNAME &&
            this.#websitePathname !== null;
        const originSettings = this.cloneData(currentProfile.settings);

        this.setWebsiteProfileScope(originSettings, selectedScope);

        if (saveForPath) {
            const currentUrlProfile = isObject(profile.urls[this.#websitePathname])
                ? profile.urls[this.#websitePathname]
                : {};
            const pathSettings = this.cloneData(currentUrlProfile.settings);
            const originData = this.mergeData(this.#globalData, originSettings);

            this.updateProfileSetting(pathSettings, changedSetting, originData);
            profile.urls[this.#websitePathname] = {
                ...currentUrlProfile,
                settings: pathSettings
            };
        } else {
            this.updateProfileSetting(originSettings, changedSetting, this.#globalData);
        }

        this.setWebsiteProfileScope(originSettings, selectedScope);
        profile.settings = originSettings;

        profiles[this.#websiteOrigin] = profile;

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: profiles
        });

        this.applyWebsiteProfile(profile);
    }

    async deleteCurrentWebsiteProfile() {
        const wasDeleted = await this.deleteWebsiteProfile();

        if (!wasDeleted) return false;

        this.#activeWebsiteProfile = false;
        this.data = this.cloneData(this.#globalData);
        this.setFormData(this.data);
        return true;
    }

    async deleteWebsiteProfile(existingProfiles = null) {
        if (!this.#websiteOrigin) return false;

        const profiles = existingProfiles ?? (
            await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY)
        )[WEBSITE_PROFILES_STORAGE_KEY] ?? {};

        if (!Object.prototype.hasOwnProperty.call(profiles, this.#websiteOrigin)) return false;

        const nextProfiles = {...profiles};
        delete nextProfiles[this.#websiteOrigin];

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: nextProfiles
        });

        return true;
    }

    getProfileDuration(value) {
        const days = Number(value);

        return Number.isInteger(days) &&
            days >= MIN_PROFILE_DURATION_DAYS &&
            days <= MAX_PROFILE_DURATION_DAYS
            ? days
            : null;
    }

    normalizeWebsiteProfileScope(scope) {
        return normalizeWebsiteProfileScopeValue(scope);
    }

    isWebsiteProfileValid(profile) {
        return isObject(profile) &&
            profile.origin === this.#websiteOrigin &&
            Number.isFinite(profile.expiresAt) && profile.expiresAt > Date.now() &&
            (profile.settings === undefined || isObject(profile.settings)) &&
            isObject(profile.urls);
    }

    setWebsiteProfileScope(settings, scope) {
        settings.common ??= {};
        settings.common.websiteProfileScope = this.normalizeWebsiteProfileScope(scope);
    }

    getChangedSetting(control, data) {
        if (control?.section && control?.key) {
            return {
                section: control.section,
                key: control.key,
                value: data?.[control.section]?.[control.key]
            };
        }

        if (!control?.name) return null;

        const section = control.closest('fieldset[name]')?.name;

        if (!section || (section === 'common' && control.name === 'saveSettingsForURL')) {
            return null;
        }

        return {
            section,
            key: control.name,
            value: data?.[section]?.[control.name]
        };
    }

    updateProfileSetting(profileSettings, changedSetting, baseData) {
        if (!changedSetting || changedSetting.value === undefined) return;

        const {section, key, value} = changedSetting;
        const inheritedValue = baseData?.[section]?.[key];

        if (value === inheritedValue) {
            delete profileSettings[section]?.[key];
            if (section === 'filters' && key === 'ignoreBlurredImages') {
                delete profileSettings.filters?.blurSettingsVersion;
            }
            if (Object.keys(profileSettings[section] ?? {}).length === 0) {
                delete profileSettings[section];
            }
            return;
        }

        profileSettings[section] ??= {};
        profileSettings[section][key] = value;
        if (section === 'filters' && key === 'ignoreBlurredImages') {
            profileSettings.filters.blurSettingsVersion = PIXEL_BLUR_SETTINGS_VERSION;
        }
    }

    applyWebsiteProfile(profile) {
        let effectiveSettings = this.mergeData(this.#globalData, profile.settings ?? {});
        const urlProfile = this.#websitePathname === null
            ? null
            : profile.urls?.[this.#websitePathname];

        if (isObject(urlProfile?.settings)) {
            effectiveSettings = this.mergeData(effectiveSettings, urlProfile.settings);
        }

        if (this.getProfileDuration(effectiveSettings.common.keepSettingsForDays) === null) {
            effectiveSettings.common.keepSettingsForDays = DEFAULT_SETTINGS.common.keepSettingsForDays;
        }
        effectiveSettings.common.saveSettingsForURL = true;
        this.data = effectiveSettings;
        this.#activeWebsiteProfile = true;
    }

    cloneData(data) {
        return Object.fromEntries(
            Object.entries(data ?? {}).map(([sectionName, section]) => [
                sectionName,
                {...section}
            ])
        );
    }

    getPersistedGlobalData() {
        const globalData = this.cloneData(this.#globalData);

        delete globalData.common?.websiteProfileScope;
        return globalData;
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
        keepSettingsForDays: 30,
        websiteProfileScope: WEBSITE_PROFILE_SCOPE_ORIGIN
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
        ignoreDuplicates: true,
        ignoreHiddenImages: false,
        ignoreBlurredImages: true,
        blurSettingsVersion: PIXEL_BLUR_SETTINGS_VERSION,
        hasExcludeList: false,
        excludeList: 'logo, avatar'
    }
};
