const WEBSITE_PROFILES_STORAGE_KEY = 'websiteProfiles';
const MIN_PROFILE_DURATION_DAYS = 1;
const MAX_PROFILE_DURATION_DAYS = 365;
const MILLISECONDS_PER_DAY = 86400000;
const PIXEL_BLUR_SETTINGS_VERSION = 2;

/**
 * @file Settings.js
 * @module Settings
 * @version 0.1.12
 * @date 2026-10-06
 * @author Jens-Olaf-Mueller
 *
 * Settings - Persists global and website-specific extension settings.
 * ===============================================================
 *
 * Loads, validates, migrates, and saves the add-on configuration. Website
 * profiles can override global settings for the normalized URL of the active tab.
 * - Key features:
 * - Global settings:             Stores the shared extension configuration.
 * - Website profiles:            Persists settings for a specific website URL.
 * - Settings migration:          Normalizes legacy and incomplete stored data.
 * - Theme support:               Provides the validated light or dark theme mode.
 * - Folder detection:            Identifies the most likely recent download folder.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link websiteURL}                       - Gets or sets the active website URL.
 * - {@link run}                              - Loads settings from browser storage.
 * - {@link save}                             - Persists global or website settings.
 * - {@link resetToDefaults}                  - Restores the global default settings.
 * - {@link hasCurrentWebsiteProfile}         - Checks whether an active profile exists.
 * - {@link deleteCurrentWebsiteProfile}      - Deletes the active website profile.
 * - {@link get}                              - Reads a settings value with a fallback.
 * - {@link getThemeMode}                     - Returns the validated theme mode.
 * - {@link setThemeMode}                     - Saves the requested theme mode.
 * - {@link getMostLikelyDownloadFolder}      - Finds the most frequent recent folder.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #load()}                          - Loads global data and active profiles.
 * - {@link #saveWebsiteProfile()}            - Persists the active website profile.
 * - {@link #deleteWebsiteProfile()}          - Removes a website profile from storage.
 * - {@link #getProfileDuration()}            - Validates a profile retention duration.
 * - {@link #isWebsiteProfileValid()}         - Checks a profile's structure and expiry.
 * - {@link #isObject()}                      - Tests for a plain object value.
 * - {@link #cloneData()}                     - Creates a settings data copy.
 * - {@link #mergeData()}                     - Combines defaults and saved settings.
 * - {@link #migrateBlurSettings()}           - Migrates legacy blur settings.
 * - {@link #migrateDuplicateSettings()}      - Migrates legacy duplicate settings.
 * - {@link #removeWebsiteProfileScope()}     - Removes the retired profile scope.
 * - {@link #migrateSettings()}               - Runs all settings migrations.
 * - {@link #normalizeWebsiteURL()}           - Normalizes supported website URLs.
 * - {@link #normalizeSettings()}             - Migrates and completes settings data.
 * - {@link #hasCompleteSettings()}           - Checks for all known settings keys.
 * - {@link #createProfile()}                 - Creates a normalized website profile.
 * - {@link #migrateLegacyProfile()}          - Converts a legacy nested profile.
 * - {@link #migrateWebsiteProfiles()}        - Migrates and validates all profiles.
 */
export class Settings {
    #activeWebsiteProfile = false;
    #globalData = {};

    #websiteURL = null;
    /**
     * Gets or sets the normalized HTTP(S) URL used to select a website profile.
     * @type {string|null} The normalized origin and pathname, or null without a valid URL.
     */
    get websiteURL() { return this.#websiteURL; }
    set websiteURL(url) {
        this.#websiteURL = Settings.#normalizeWebsiteURL(url);
    }

    /**
     * @param {string} [storageKey='settings'] - The browser-storage key for global settings.
     */
    constructor(storageKey = 'settings') {
        this.storageKey = storageKey;
        this.data = {};
    }

    /**
     * Loads the persisted global settings and the profile for the active website.
     *
     * @returns {Promise<Object>} The active settings data.
     */
    async run() {
        await this.#load();
        return this.data;
    }

    /**
     * Normalizes and persists global settings or the active website profile.
     *
     * @param {Object} data - The settings data to save.
     * @returns {Promise<Object>} The normalized active settings data.
     */
    async save(data) {
        const nextData = Settings.#normalizeSettings(data);
        const saveWebsiteProfile = nextData.common.saveSettingsForURL === true &&
            this.#websiteURL !== null;

        if (saveWebsiteProfile) {
            const keepSettingsForDays = this.#getProfileDuration(
                nextData.common.keepSettingsForDays
            );

            if (keepSettingsForDays === null) {
                console.warn('Cannot save website profile: invalid keepSettingsForDays value');
                return this.data;
            }

            nextData.common.saveSettingsForURL = true;
            this.data = Settings.#cloneData(nextData);
            this.#activeWebsiteProfile = true;
            await this.#saveWebsiteProfile(keepSettingsForDays);
            return this.data;
        }

        if (this.#activeWebsiteProfile && this.#websiteURL !== null) {
            await this.#deleteWebsiteProfile();
            this.#activeWebsiteProfile = false;
            this.data = Settings.#cloneData(this.#globalData);
            return this.data;
        }

        this.data = Settings.#cloneData(nextData);
        this.#globalData = Settings.#cloneData(nextData);

        await window.chrome.storage.local.set({
            [this.storageKey]: Settings.#cloneData(this.#globalData)
        });

        return this.data;
    }

    /**
     * Restores and persists the default global settings.
     *
     * @returns {Promise<Object>} The restored default settings data.
     */
    async resetToDefaults() {
        this.data = Settings.#cloneData(DEFAULT_SETTINGS);
        this.#globalData = Settings.#cloneData(DEFAULT_SETTINGS);
        this.#activeWebsiteProfile = false;

        await window.chrome.storage.local.set({
            [this.storageKey]: Settings.#cloneData(this.#globalData)
        });

        return this.data;
    }

    /**
     * Checks whether the active website has a valid, non-expired settings profile.
     *
     * @returns {Promise<boolean>} Whether a valid active website profile exists.
     */
    async hasCurrentWebsiteProfile() {
        if (!this.#websiteURL) return false;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = stored[WEBSITE_PROFILES_STORAGE_KEY] ?? {};
        const profile = profiles[this.#websiteURL];

        if (this.#isWebsiteProfileValid(profile)) return true;
        if (profile) {
            await this.#deleteWebsiteProfile(profiles);
            if (this.#activeWebsiteProfile) {
                this.#activeWebsiteProfile = false;
                this.data = Settings.#cloneData(this.#globalData);
            }
        }

        return false;
    }

    /**
     * Deletes the settings profile for the active website and restores global settings.
     *
     * @returns {Promise<boolean>} Whether a stored website profile was deleted.
     */
    async deleteCurrentWebsiteProfile() {
        const wasDeleted = await this.#deleteWebsiteProfile();

        this.#activeWebsiteProfile = false;
        this.data = Settings.#cloneData(this.#globalData);
        return wasDeleted;
    }

    /**
     * Reads a section or a value from the active settings data.
     *
     * @param {string} section - The settings section to read.
     * @param {string|null} [key=null] - The optional key within the section.
     * @param {*} [defaultValue=null] - The fallback for an unavailable value.
     * @returns {*} The resolved settings value or the fallback.
     */
    get(section, key = null, defaultValue = null) {
        if (key === null) return this.data?.[section] ?? defaultValue;
        return this.data?.[section]?.[key] ?? defaultValue;
    }

    /**
     * Returns the validated active theme mode.
     *
     * @returns {'light'|'dark'} The active theme mode.
     */
    getThemeMode() {
        return this.get('common', 'themeMode', 'light') === 'dark' ? 'dark' : 'light';
    }

    /**
     * Saves a validated light or dark theme mode.
     *
     * @param {string} mode - The requested theme mode.
     * @returns {Promise<Object>} The normalized active settings data.
     */
    async setThemeMode(mode) {
        return this.save({
            ...this.data,
            common: {
                ...(this.data.common ?? {}),
                themeMode: mode === 'dark' ? 'dark' : 'light'
            }
        });
    }

    /**
     * Finds the most frequently used folder among recent completed downloads.
     *
     * @param {number} [limit=50] - The maximum number of recent downloads to inspect.
     * @returns {Promise<string>} The likely folder path, or an empty string when unknown.
     */
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

    // Loads global data, applies migrations, and selects an active website profile.
    async #load() {
        const stored = await window.chrome.storage.local.get([
            this.storageKey,
            WEBSITE_PROFILES_STORAGE_KEY
        ]);
        const savedGlobalData = stored[this.storageKey];
        const globalMigration = Settings.#migrateSettings(savedGlobalData ?? {});
        const globalData = Settings.#mergeData(DEFAULT_SETTINGS, globalMigration.data);
        const profileMigration = Settings.#migrateWebsiteProfiles(
            stored[WEBSITE_PROFILES_STORAGE_KEY],
            globalData
        );
        const changes = {};

        if (globalMigration.migrated || !Settings.#hasCompleteSettings(savedGlobalData)) {
            changes[this.storageKey] = Settings.#cloneData(globalData);
        }
        if (profileMigration.migrated) {
            changes[WEBSITE_PROFILES_STORAGE_KEY] = profileMigration.profiles;
        }

        this.#globalData = Settings.#cloneData(globalData);
        this.data = Settings.#cloneData(globalData);
        this.#activeWebsiteProfile = false;

        const profile = this.#websiteURL === null
            ? null
            : profileMigration.profiles[this.#websiteURL];

        if (this.#isWebsiteProfileValid(profile)) {
            this.data = Settings.#cloneData(profile.settings);
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

    // Saves the current data as the active website profile.
    async #saveWebsiteProfile(keepSettingsForDays) {
        if (!this.#websiteURL) return;

        const stored = await window.chrome.storage.local.get(WEBSITE_PROFILES_STORAGE_KEY);
        const profiles = Settings.#isObject(stored[WEBSITE_PROFILES_STORAGE_KEY])
            ? {...stored[WEBSITE_PROFILES_STORAGE_KEY]}
            : {};

        profiles[this.#websiteURL] = Settings.#createProfile(
            this.data,
            Date.now() + keepSettingsForDays * MILLISECONDS_PER_DAY
        );

        await window.chrome.storage.local.set({
            [WEBSITE_PROFILES_STORAGE_KEY]: profiles
        });
    }

    // Removes the active website profile from browser storage.
    async #deleteWebsiteProfile(existingProfiles = null) {
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

    // Validates the number of days for a website profile.
    #getProfileDuration(value) {
        const days = Number(value);

        return Number.isInteger(days) &&
            days >= MIN_PROFILE_DURATION_DAYS &&
            days <= MAX_PROFILE_DURATION_DAYS
            ? days
            : null;
    }

    // Checks that a website profile has valid, non-expired settings data.
    #isWebsiteProfileValid(profile) {
        return Settings.#isObject(profile) &&
            Number.isFinite(profile.expiresAt) && profile.expiresAt > Date.now() &&
            Settings.#isObject(profile.settings);
    }

    // Tests whether a value is a non-array object.
    static #isObject(value) {
        return value !== null && typeof value === 'object' && !Array.isArray(value);
    }

    // Creates a shallow copy of all settings sections.
    static #cloneData(data) {
        return Object.fromEntries(
            Object.entries(data ?? {}).map(([sectionName, section]) => [
                sectionName,
                {...section}
            ])
        );
    }

    // Combines saved settings with their default values.
    static #mergeData(defaultData, savedData) {
        const mergedData = {};

        Object.entries(defaultData).forEach(([sectionName, section]) => {
            mergedData[sectionName] = {};

            Object.entries(section).forEach(([key, defaultValue]) => {
                mergedData[sectionName][key] =
                    savedData?.[sectionName]?.[key] ?? defaultValue;
            });
        });

        return mergedData;
    }

    // Replaces retired blurred-image settings with the current setting.
    static #migrateBlurSettings(data) {
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

    // Replaces the retired duplicate-removal setting with its successor.
    static #migrateDuplicateSettings(data) {
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

    // Removes the retired website-profile scope setting.
    static #removeWebsiteProfileScope(data) {
        if (!Settings.#isObject(data?.common) || !Object.prototype.hasOwnProperty.call(
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

    // Runs every supported settings migration in order.
    static #migrateSettings(data) {
        const blurMigration = Settings.#migrateBlurSettings(data);
        const duplicateMigration = Settings.#migrateDuplicateSettings(blurMigration.data);
        const scopeMigration = Settings.#removeWebsiteProfileScope(duplicateMigration.data);

        return {
            data: scopeMigration.data,
            migrated: blurMigration.migrated || duplicateMigration.migrated ||
                scopeMigration.migrated
        };
    }

    // Returns a normalized HTTP(S) origin and pathname, or null.
    static #normalizeWebsiteURL(url, baseURL = undefined) {
        try {
            const parsedURL = new URL(url, baseURL);

            if (!['http:', 'https:'].includes(parsedURL.protocol)) return null;

            return `${parsedURL.origin}${parsedURL.pathname}`;
        } catch {
            return null;
        }
    }

    // Migrates incomplete settings data and fills in defaults.
    static #normalizeSettings(data) {
        const {data: migratedData} = Settings.#migrateSettings(data);

        return Settings.#mergeData(DEFAULT_SETTINGS, migratedData);
    }

    // Checks that all known settings sections and keys are present.
    static #hasCompleteSettings(data) {
        if (!Settings.#isObject(data)) return false;

        const hasOnlyKnownSections = Object.keys(data).every((sectionName) =>
            Object.prototype.hasOwnProperty.call(DEFAULT_SETTINGS, sectionName)
        );
        if (!hasOnlyKnownSections) return false;

        return Object.entries(DEFAULT_SETTINGS).every(([sectionName, section]) =>
            Settings.#isObject(data[sectionName]) &&
            Object.keys(data[sectionName]).every((key) =>
                Object.prototype.hasOwnProperty.call(section, key)
            ) && Object.keys(section).every(key =>
                Object.prototype.hasOwnProperty.call(data[sectionName], key)
            )
        );
    }

    // Creates a normalized settings profile with website saving enabled.
    static #createProfile(settings, expiresAt) {
        const profileSettings = Settings.#normalizeSettings(settings);

        profileSettings.common.saveSettingsForURL = true;
        return {
            expiresAt,
            settings: profileSettings
        };
    }

    // Converts one legacy origin profile and its path profiles.
    static #migrateLegacyProfile(origin, profile, globalData) {
        const migratedProfiles = {};
        const normalizedOrigin = Settings.#normalizeWebsiteURL(origin);
        const expiresAt = profile?.expiresAt;

        if (!normalizedOrigin || !Number.isFinite(expiresAt)) return migratedProfiles;

        const originSettings = Settings.#mergeData(
            globalData,
            Settings.#migrateSettings(profile.settings).data
        );
        migratedProfiles[normalizedOrigin] = Settings.#createProfile(originSettings, expiresAt);

        if (!Settings.#isObject(profile.urls)) return migratedProfiles;

        Object.entries(profile.urls).forEach(([pathname, urlProfile]) => {
            if (!Settings.#isObject(urlProfile)) return;

            const profileURL = Settings.#normalizeWebsiteURL(pathname, normalizedOrigin);
            if (!profileURL) return;

            const pathSettings = Settings.#mergeData(
                originSettings,
                Settings.#migrateSettings(urlProfile.settings).data
            );
            migratedProfiles[profileURL] = Settings.#createProfile(pathSettings, expiresAt);
        });

        return migratedProfiles;
    }

    // Migrates, normalizes, and validates all stored website profiles.
    static #migrateWebsiteProfiles(profiles, globalData) {
        if (!Settings.#isObject(profiles)) {
            return {profiles: {}, migrated: profiles !== undefined};
        }

        let migrated = false;
        const migratedProfiles = {};

        Object.entries(profiles).forEach(([profileURL, profile]) => {
            const isLegacyProfile = Settings.#isObject(profile) &&
                (Object.prototype.hasOwnProperty.call(profile, 'origin') ||
                    Object.prototype.hasOwnProperty.call(profile, 'urls'));

            if (isLegacyProfile) {
                Object.assign(
                    migratedProfiles,
                    Settings.#migrateLegacyProfile(
                        profile.origin ?? profileURL,
                        profile,
                        globalData
                    )
                );
                migrated = true;
                return;
            }

            const normalizedURL = Settings.#normalizeWebsiteURL(profileURL);

            if (!normalizedURL || !Settings.#isObject(profile) ||
                !Number.isFinite(profile.expiresAt) || !Settings.#isObject(profile.settings)) {
                migrated = true;
                return;
            }

            const normalizedProfile = Settings.#createProfile(
                profile.settings,
                profile.expiresAt
            );
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
}

export const DEFAULT_SETTINGS = {
    common: {
        scanOnStart: true,
        themeMode: 'light',
        allowBackgroundScan: false,
        allowProtectedDeepScan: false,
        saveSettingsForURL: false,
        keepSettingsForDays: 365
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
    },
    debug: {
        debugmode: false,
        logtab: false,
        logpopup: false,
        logserviceworker: false
    }
};