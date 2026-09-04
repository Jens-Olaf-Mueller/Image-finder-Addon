const WEBSITE_PROFILES_STORAGE_KEY = 'websiteProfiles';
const MIN_PROFILE_DURATION_DAYS = 1;
const MAX_PROFILE_DURATION_DAYS = 365;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const PIXEL_BLUR_SETTINGS_VERSION = 2;

function isObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function cloneData(data) {
    return Object.fromEntries(
        Object.entries(data ?? {}).map(([sectionName, section]) => [
            sectionName,
            {...section}
        ])
    );
}

function mergeData(defaultData, savedData) {
    const mergedData = cloneData(savedData);

    Object.entries(defaultData).forEach(([sectionName, section]) => {
        mergedData[sectionName] ??= {};

        Object.entries(section).forEach(([key, defaultValue]) => {
            mergedData[sectionName][key] =
                savedData?.[sectionName]?.[key] ?? defaultValue;
        });
    });

    return mergedData;
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

function removeWebsiteProfileScope(data) {
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

function migrateSettings(data) {
    const blurMigration = migrateBlurSettings(data);
    const duplicateMigration = migrateDuplicateSettings(blurMigration.data);
    const scopeMigration = removeWebsiteProfileScope(duplicateMigration.data);

    return {
        data: scopeMigration.data,
        migrated: blurMigration.migrated || duplicateMigration.migrated ||
            scopeMigration.migrated
    };
}

function normalizeWebsiteURL(url, baseURL = undefined) {
    try {
        const parsedURL = new URL(url, baseURL);

        if (!['http:', 'https:'].includes(parsedURL.protocol)) return null;

        return `${parsedURL.origin}${parsedURL.pathname}`;
    } catch {
        return null;
    }
}

function normalizeSettings(data) {
    const {data: migratedData} = migrateSettings(data);

    return mergeData(DEFAULT_SETTINGS, migratedData);
}

function hasCompleteSettings(data) {
    if (!isObject(data)) return false;

    return Object.entries(DEFAULT_SETTINGS).every(([sectionName, section]) =>
        isObject(data[sectionName]) &&
        Object.keys(section).every(key =>
            Object.prototype.hasOwnProperty.call(data[sectionName], key)
        )
    );
}

function createProfile(settings, expiresAt) {
    const profileSettings = normalizeSettings(settings);

    profileSettings.common.saveSettingsForURL = true;
    return {
        expiresAt,
        settings: profileSettings
    };
}

function migrateLegacyProfile(origin, profile, globalData) {
    const migratedProfiles = {};
    const normalizedOrigin = normalizeWebsiteURL(origin);
    const expiresAt = profile?.expiresAt;

    if (!normalizedOrigin || !Number.isFinite(expiresAt)) return migratedProfiles;

    const originSettings = mergeData(globalData, migrateSettings(profile.settings).data);
    migratedProfiles[normalizedOrigin] = createProfile(originSettings, expiresAt);

    if (!isObject(profile.urls)) return migratedProfiles;

    Object.entries(profile.urls).forEach(([pathname, urlProfile]) => {
        if (!isObject(urlProfile)) return;

        const profileURL = normalizeWebsiteURL(pathname, normalizedOrigin);
        if (!profileURL) return;

        const pathSettings = mergeData(
            originSettings,
            migrateSettings(urlProfile.settings).data
        );
        migratedProfiles[profileURL] = createProfile(pathSettings, expiresAt);
    });

    return migratedProfiles;
}

function migrateWebsiteProfiles(profiles, globalData) {
    if (!isObject(profiles)) return {profiles: {}, migrated: profiles !== undefined};

    let migrated = false;
    const migratedProfiles = {};

    Object.entries(profiles).forEach(([profileURL, profile]) => {
        const isLegacyProfile = isObject(profile) &&
            (Object.prototype.hasOwnProperty.call(profile, 'origin') ||
                Object.prototype.hasOwnProperty.call(profile, 'urls'));

        if (isLegacyProfile) {
            Object.assign(
                migratedProfiles,
                migrateLegacyProfile(profile.origin ?? profileURL, profile, globalData)
            );
            migrated = true;
            return;
        }

        const normalizedURL = normalizeWebsiteURL(profileURL);

        if (!normalizedURL || !isObject(profile) || !Number.isFinite(profile.expiresAt) ||
            !isObject(profile.settings)) {
            migrated = true;
            return;
        }

        const normalizedProfile = createProfile(profile.settings, profile.expiresAt);
        migratedProfiles[normalizedURL] = normalizedProfile;

        if (normalizedURL !== profileURL ||
            JSON.stringify(normalizedProfile) !== JSON.stringify(profile)) {
            migrated = true;
        }
    });

    return {
        profiles: migrated ? migratedProfiles : profiles,
        migrated
    };
}

export class Settings {
    #websiteURL = null;
    #activeWebsiteProfile = false;
    #globalData = {};

    constructor(storageKey = 'settings') {
        this.storageKey = storageKey;
        this.data = {};
    }

    setWebsiteURL(url) {
        this.#websiteURL = normalizeWebsiteURL(url);
        return this.#websiteURL;
    }

    async run() {
        await this.load();
        return this.data;
    }

    async load() {
        const stored = await window.chrome.storage.local.get([
            this.storageKey,
            WEBSITE_PROFILES_STORAGE_KEY
        ]);
        const savedGlobalData = stored[this.storageKey];
        const globalMigration = migrateSettings(savedGlobalData ?? {});
        const globalData = mergeData(DEFAULT_SETTINGS, globalMigration.data);
        const profileMigration = migrateWebsiteProfiles(
            stored[WEBSITE_PROFILES_STORAGE_KEY],
            globalData
        );
        const changes = {};

        if (globalMigration.migrated || !hasCompleteSettings(savedGlobalData)) {
            changes[this.storageKey] = cloneData(globalData);
        }
        if (profileMigration.migrated) {
            changes[WEBSITE_PROFILES_STORAGE_KEY] = profileMigration.profiles;
        }

        this.#globalData = cloneData(globalData);
        this.data = cloneData(globalData);
        this.#activeWebsiteProfile = false;

        const profile = this.#websiteURL === null
            ? null
            : profileMigration.profiles[this.#websiteURL];

        if (this.isWebsiteProfileValid(profile)) {
            this.data = cloneData(profile.settings);
            this.#activeWebsiteProfile = true;
        } else if (profile) {
            const profiles = {...profileMigration.profiles};
            delete profiles[this.#websiteURL];
            changes[WEBSITE_PROFILES_STORAGE_KEY] = profiles;
        }

        if (Object.keys(changes).length > 0) {
            await window.chrome.storage.local.set(changes);
        }

        return this.data;
    }

    async save(data) {
        const nextData = normalizeSettings(data);
        const saveWebsiteProfile = nextData.common.saveSettingsForURL === true &&
            this.#websiteURL !== null;

        if (saveWebsiteProfile) {
            const keepSettingsForDays = this.getProfileDuration(
                nextData.common.keepSettingsForDays
            );

            if (keepSettingsForDays === null) {
                console.warn('Cannot save website profile: invalid keepSettingsForDays value');
                return this.data;
            }

            nextData.common.saveSettingsForURL = true;
            this.data = cloneData(nextData);
            this.#activeWebsiteProfile = true;
            await this.saveWebsiteProfile(keepSettingsForDays);
            return this.data;
        }

        if (this.#activeWebsiteProfile && this.#websiteURL !== null) {
            await this.deleteWebsiteProfile();
            this.#activeWebsiteProfile = false;
            this.data = cloneData(this.#globalData);
            return this.data;
        }

        this.data = cloneData(nextData);
        this.#globalData = cloneData(nextData);

        await window.chrome.storage.local.set({
            [this.storageKey]: cloneData(this.#globalData)
        });

        return this.data;
    }

    async resetToDefaults() {
        this.data = cloneData(DEFAULT_SETTINGS);
        this.#globalData = cloneData(DEFAULT_SETTINGS);
        this.#activeWebsiteProfile = false;

        await window.chrome.storage.local.set({
            [this.storageKey]: cloneData(this.#globalData)
        });

        return this.data;
    }

    async hasCurrentWebsiteProfile() {
        if (!this.#websiteURL) return false;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {};
        const profile = profiles[this.#websiteURL];

        if (this.isWebsiteProfileValid(profile)) return true;
        if (profile) {
            await this.deleteWebsiteProfile(profiles);
            if (this.#activeWebsiteProfile) {
                this.#activeWebsiteProfile = false;
                this.data = cloneData(this.#globalData);
            }
        }

        return false;
    }

    async saveWebsiteProfile(keepSettingsForDays) {
        if (!this.#websiteURL) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = isObject(stored[WEBSITE_PROFILES_STORAGE_KEY])
            ? {...stored[WEBSITE_PROFILES_STORAGE_KEY]}
            : {};

        profiles[this.#websiteURL] = createProfile(
            this.data,
            Date.now() + keepSettingsForDays * MILLISECONDS_PER_DAY
        );

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: profiles
        });
    }

    async deleteCurrentWebsiteProfile() {
        const wasDeleted = await this.deleteWebsiteProfile();

        this.#activeWebsiteProfile = false;
        this.data = cloneData(this.#globalData);
        return wasDeleted;
    }

    async deleteWebsiteProfile(existingProfiles = null) {
        if (!this.#websiteURL) return false;

        const profiles = existingProfiles ?? (
            await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY)
        )[WEBSITE_PROFILES_STORAGE_KEY] ?? {};

        if (!Object.prototype.hasOwnProperty.call(profiles, this.#websiteURL)) return false;

        const nextProfiles = {...profiles};
        delete nextProfiles[this.#websiteURL];

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

    isWebsiteProfileValid(profile) {
        return isObject(profile) &&
            Number.isFinite(profile.expiresAt) && profile.expiresAt > Date.now() &&
            isObject(profile.settings);
    }

    get(section, key = null, defaultValue = null) {
        if (key === null) return this.data?.[section] ?? defaultValue;
        return this.data?.[section]?.[key] ?? defaultValue;
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

            folders.set(folder, (folders.get(folder) ?? 0) + 1);
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
}

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
        ignoreDuplicates: true,
        ignoreHiddenImages: false,
        ignoreBlurredImages: true,
        blurSettingsVersion: PIXEL_BLUR_SETTINGS_VERSION,
        hasExcludeList: false,
        excludeList: 'logo, avatar'
    }
};
