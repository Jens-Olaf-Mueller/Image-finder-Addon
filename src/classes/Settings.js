const WEBSITE_PROFILES_STORAGE_KEY = 'websiteProfiles';
const MIN_PROFILE_DURATION_DAYS = 1;
const MAX_PROFILE_DURATION_DAYS = 365;
const MILLISECONDS_PER_DAY = 86400000;
const PIXEL_BLUR_SETTINGS_VERSION = 2;
const DOWNLOAD_FOLDER_PROBE_TIMEOUT_MS = 10000;
const DOWNLOAD_FOLDER_PROBE_FILE_PREFIX = 'image-finder-download-folder-probe-';

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
 * - Folder detection:            Detects the configured browser download folder.
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
 * - {@link setDefaultDownloadFolder}         - Stores the shared browser download folder.
 * - {@link detectDefaultDownloadFolder}      - Detects the configured browser download folder.
 *
 * - {@link getMediaMode} - Returns the globally selected media mode.
 * - {@link setMediaMode} - Saves the globally selected media mode.
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
 * - {@link #waitForDownloadCompletion()}     - Waits for the temporary folder probe download.
 * - {@link #normalizeFolderPath()}           - Normalizes a browser-reported folder path.
 * - {@link #normalizeDownloadSubfolder()}    - Converts legacy folders to a download subfolder.
 * - {@link #normalizeDownloadSettings()}     - Normalizes the complete download settings section.
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

            // ✏️ EDIT 2026-10-10: Profiles inherit the shared browser folder instead of storing one.
            const sharedDefaultFolder = this.#globalData.downloads?.defaultFolder ||
                nextData.downloads.defaultFolder;

            nextData.downloads = Settings.#normalizeDownloadSettings(
                nextData.downloads,
                sharedDefaultFolder
            );
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

    // ✴️ NEW 2026-10-14: Keeps the last selected popup media mode in global settings.
    /**
     * Returns the global popup media mode without a website-profile override.
     *
     * @returns {1|2|3} The image, video, or audio media mode.
     */
    getMediaMode() {
        const mediaMode = Number(this.#globalData.common?.mediaMode);
        return [1, 2, 3].includes(mediaMode) ? mediaMode : 1;
    }

    /**
     * Saves the global popup media mode independently from a website profile.
     *
     * @param {number} mode The requested image, video, or audio mode.
     * @returns {Promise<1|2|3>} The persisted media mode.
     */
    async setMediaMode(mode) {
        const mediaMode = [1, 2, 3].includes(Number(mode)) ? Number(mode) : 1;
        const globalData = Settings.#normalizeSettings({
            ...this.#globalData,
            common: {
                ...(this.#globalData.common ?? {}),
                mediaMode
            }
        });

        this.#globalData = Settings.#cloneData(globalData);
        if (!this.#activeWebsiteProfile) this.data = Settings.#cloneData(globalData);
        await window.chrome.storage.local.set({
            [this.storageKey]: Settings.#cloneData(globalData)
        });
        return mediaMode;
    }

    // ✴️ NEW 2026-10-10: Keeps the browser download folder global while profiles retain subfolders.
    /**
     * Stores the browser's download folder globally and migrates the active profile to it.
     *
     * @param {string} folder - Absolute browser download folder reported by a completed download.
     * @returns {Promise<Object>} The normalized active settings data.
     */
    async setDefaultDownloadFolder(folder) {
        const defaultFolder = Settings.#normalizeFolderPath(folder);
        if (!defaultFolder) return this.data;

        const normalizeData = (data) => {
            const nextData = Settings.#cloneData(data);

            nextData.downloads = Settings.#normalizeDownloadSettings(
                nextData.downloads,
                defaultFolder
            );
            return nextData;
        };

        const nextGlobalData = normalizeData(this.#globalData);
        const nextData = normalizeData(this.data);
        const globalDataChanged = JSON.stringify(nextGlobalData) !== JSON.stringify(this.#globalData);
        const activeDataChanged = JSON.stringify(nextData) !== JSON.stringify(this.data);

        this.#globalData = nextGlobalData;
        this.data = nextData;
        if (globalDataChanged) {
            await window.chrome.storage.local.set({
                [this.storageKey]: Settings.#cloneData(this.#globalData)
            });
        }

        if (!this.#activeWebsiteProfile || !activeDataChanged) return this.data;

        const keepSettingsForDays = this.#getProfileDuration(
            this.data.common.keepSettingsForDays
        );
        if (keepSettingsForDays !== null) {
            await this.#saveWebsiteProfile(keepSettingsForDays);
        }

        return this.data;
    }

    // ✏️ EDIT 2026-10-15: Uses a temporary direct download instead of guessing from the history.
    /**
     * Detects the configured browser download folder through a temporary empty file.
     *
     * The Chrome Downloads API reports the absolute filename for the probe, so its parent
     * directory is the actual browser default rather than an arbitrary extension subfolder.
     * The probe file and its history entry are removed before this method resolves.
     *
     * @returns {Promise<string>} The detected browser download folder, or an empty string.
     */
    async detectDefaultDownloadFolder() {
        const filename = `${DOWNLOAD_FOLDER_PROBE_FILE_PREFIX}${crypto.randomUUID()}.txt`;
        let downloadID = null;
        let isCompleted = false;

        try {
            downloadID = await window.chrome.downloads.download({
                url: 'data:text/plain;charset=utf-8,',
                filename,
                conflictAction: 'uniquify',
                saveAs: false
            });

            const download = await Settings.#waitForDownloadCompletion(downloadID);
            isCompleted = true;

            return Settings.#normalizeFolderPath(
                download.filename.replace(/[\\/][^\\/]+$/, '')
            );
        } finally {
            if (Number.isInteger(downloadID)) {
                if (!isCompleted) {
                    await window.chrome.downloads.cancel(downloadID).catch(() => undefined);
                }

                if (isCompleted) {
                    await window.chrome.downloads.removeFile(downloadID).catch(() => undefined);
                }

                await window.chrome.downloads.erase({id: downloadID}).catch(() => undefined);
            }
        }
    }

    // Loads global data, applies migrations, and selects an active website profile.
    async #load() {
        const stored = await window.chrome.storage.local.get([
            this.storageKey,
            WEBSITE_PROFILES_STORAGE_KEY
        ]);
        const savedGlobalData = stored[this.storageKey];
        const globalMigration = Settings.#migrateSettings(savedGlobalData ?? {});
        const globalData = Settings.#normalizeSettings(globalMigration.data);
        const profileMigration = Settings.#migrateWebsiteProfiles(
            stored[WEBSITE_PROFILES_STORAGE_KEY],
            globalData
        );
        const changes = {};

        if (globalMigration.migrated || !Settings.#hasCompleteSettings(savedGlobalData) ||
            JSON.stringify(globalData) !== JSON.stringify(savedGlobalData)) {
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
            // ✏️ EDIT 2026-10-10: Profiles inherit the global browser download folder.
            this.data = Settings.#mergeData(globalData, profile.settings);
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
            Date.now() + keepSettingsForDays * MILLISECONDS_PER_DAY,
            this.#globalData.downloads?.defaultFolder
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

    // ✴️ NEW 2026-10-15: Waits for the direct download-folder probe before cleaning it up.
    /**
     * Resolves the final DownloadItem for a successful temporary probe download.
     *
     * @param {number} downloadID - The DownloadItem identifier to observe.
     * @returns {Promise<chrome.downloads.DownloadItem>} The completed probe download.
     */
    static async #waitForDownloadCompletion(downloadID) {
        const findDownload = async () => {
            const [download] = await window.chrome.downloads.search({id: downloadID});
            return download ?? null;
        };

        return new Promise((resolve, reject) => {
            let isSettled = false;
            let timeoutID = null;
            const finish = (callback, value) => {
                if (isSettled) return;

                isSettled = true;
                window.clearTimeout(timeoutID);
                window.chrome.downloads.onChanged.removeListener(onDownloadChanged);
                callback(value);
            };
            const onDownloadChanged = (delta) => {
                if (delta.id !== downloadID || !delta.state) return;

                if (delta.state.current === 'interrupted') {
                    finish(reject, new Error('Download folder probe was interrupted'));
                    return;
                }
                if (delta.state.current !== 'complete') return;

                findDownload().then(download => {
                    if (download) {
                        finish(resolve, download);
                    } else {
                        finish(reject, new Error('Completed download folder probe was not found'));
                    }
                }).catch(error => finish(reject, error));
            };

            window.chrome.downloads.onChanged.addListener(onDownloadChanged);
            timeoutID = window.setTimeout(() => {
                finish(reject, new Error('Download folder probe timed out'));
            }, DOWNLOAD_FOLDER_PROBE_TIMEOUT_MS);

            findDownload().then(download => {
                if (download?.state === 'complete') {
                    finish(resolve, download);
                } else if (download?.state === 'interrupted') {
                    finish(reject, new Error('Download folder probe was interrupted'));
                }
            }).catch(error => finish(reject, error));
        });
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

    // ✴️ NEW 2026-10-10: Normalizes global download paths and profile-local subfolders.
    // Normalizes a browser-reported absolute download folder path.
    static #normalizeFolderPath(folder) {
        return String(folder ?? '')
            .trim()
            .replaceAll('\\', '/')
            .replace(/\/+$/, '');
    }

    // Converts a legacy full path or a user value to a canonical /subfolder value.
    static #normalizeDownloadSubfolder(userFolder, defaultFolder = '') {
        const normalizedUserFolder = Settings.#normalizeFolderPath(userFolder);
        const normalizedDefaultFolder = Settings.#normalizeFolderPath(defaultFolder);

        if (!normalizedUserFolder) return '';
        if (!normalizedDefaultFolder) return normalizedUserFolder;
        if (normalizedUserFolder === normalizedDefaultFolder) return '';
        if (normalizedUserFolder.startsWith(`${normalizedDefaultFolder}/`)) {
            const relativeFolder = normalizedUserFolder.slice(normalizedDefaultFolder.length)
                .replace(/^\/+/, '');

            return relativeFolder ? `/${relativeFolder}` : '';
        }
        if (/^[A-Za-z]:\//.test(normalizedUserFolder)) return '';

        return `/${normalizedUserFolder.replace(/^\/+/, '')}`;
    }

    // Normalizes shared folder metadata and the profile-local download subfolder.
    static #normalizeDownloadSettings(downloads = {}, defaultFolder = '') {
        const normalizedDefaultFolder = Settings.#normalizeFolderPath(
            defaultFolder || downloads.defaultFolder
        );

        return {
            ...downloads,
            defaultFolder: normalizedDefaultFolder,
            userFolder: Settings.#normalizeDownloadSubfolder(
                downloads.userFolder,
                normalizedDefaultFolder
            )
        };
    }

    // Migrates incomplete settings data and fills in defaults.
    static #normalizeSettings(data) {
        const {data: migratedData} = Settings.#migrateSettings(data);
        const normalizedData = Settings.#mergeData(DEFAULT_SETTINGS, migratedData);

        normalizedData.downloads = Settings.#normalizeDownloadSettings(normalizedData.downloads);
        return normalizedData;
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

    // ✏️ EDIT 2026-10-10: Creates a profile without a browser-specific download folder.
    static #createProfile(settings, expiresAt, defaultFolder = '') {
        const profileSettings = Settings.#normalizeSettings(settings);
        const profileDefaultFolder = profileSettings.downloads.defaultFolder || defaultFolder;
        const downloadSettings = Settings.#normalizeDownloadSettings(
            profileSettings.downloads,
            profileDefaultFolder
        );
        const profileDownloads = {...downloadSettings};

        delete profileDownloads.defaultFolder;

        profileSettings.downloads = profileDownloads;
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
        migratedProfiles[normalizedOrigin] = Settings.#createProfile(
            originSettings,
            expiresAt,
            globalData.downloads.defaultFolder
        );

        if (!Settings.#isObject(profile.urls)) return migratedProfiles;

        Object.entries(profile.urls).forEach(([pathname, urlProfile]) => {
            if (!Settings.#isObject(urlProfile)) return;

            const profileURL = Settings.#normalizeWebsiteURL(pathname, normalizedOrigin);
            if (!profileURL) return;

            const pathSettings = Settings.#mergeData(
                originSettings,
                Settings.#migrateSettings(urlProfile.settings).data
            );
            migratedProfiles[profileURL] = Settings.#createProfile(
                pathSettings,
                expiresAt,
                globalData.downloads.defaultFolder
            );
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
                profile.expiresAt,
                globalData.downloads.defaultFolder
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
        // ✴️ NEW 2026-10-14: Starts in image mode until the user chooses another media type.
        mediaMode: 1,
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
