/**
 * @file ScanContext.js
 * @module ScanContext
 * @version 0.1.12
 * @date 2026-10-06
 * @author Jens-Olaf-Mueller
 *
 * ScanContext - Stores the validated browser tab targeted by a scan.
 * ===============================================================
 *
 * Keeps the minimum tab state required by the scan and DeepScan workflows.
 * The context can be safely cleared when no valid active tab is available.
 * - Key features:
 * - Tab validation:             Validates a tab ID and its URL before storage.
 * - Scan eligibility:           Identifies HTTP(S) pages that can be scanned.
 * - Serialization:              Provides the state for message payloads and logs.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link tabId}               - Returns the active tab ID.
 * - {@link url}                 - Returns the active tab URL.
 * - {@link tab}                 - Sets the active tab from browser tab data.
 * - {@link isScannable}         - Checks whether the active URL uses HTTP(S).
 * - {@link clear}               - Removes the stored tab context.
 * - {@link toJSON}              - Serializes the current context.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #isValidURL()}       - Validates a URL string.
 */
export class ScanContext {
    /**
     * Returns the ID of the active scan tab.
     * @type {number|null} The active tab ID, or null without a tab context.
     */
    #tabId = null;
    get tabId() { return this.#tabId; }

    /**
     * Returns the URL of the active scan tab.
     * @type {string|null} The active tab URL, or null without a tab context.
     */
    #url = null;
    get url() { return this.#url; }

    /**
     * Stores a valid browser tab or clears the context for invalid input.
     * @type {Object|null} The browser tab data to store.
     */
    set tab(tab) {
        if (!Number.isInteger(tab?.id) || typeof tab.url !== 'string' || !tab.url ||
            !ScanContext.#isValidURL(tab.url)) {
            this.clear();
            return;
        }

        this.#tabId = tab.id;
        this.#url = tab.url;
    }

    /**
     * Checks whether the active tab URL uses a supported HTTP(S) protocol.
     * @type {boolean} Whether the active tab can be scanned.
     */
    get isScannable() {
        try {
            return ['http:', 'https:'].includes(new URL(this.#url).protocol);
        } catch {
            return false;
        }
    }

    /**
     * @param {Object|null} [tab=null] - The initial browser tab data.
     */
    constructor(tab = null) {
        this.tab = tab;
    }

    /**
     * Clears the active scan tab context.
     *
     * @returns {ScanContext} The cleared context instance.
     */
    clear() {
        this.#tabId = null;
        this.#url = null;
        return this;
    }

    /**
     * Serializes the active scan tab context.
     *
     * @returns {{tabId: number|null, url: string|null}} The serializable context data.
     */
    toJSON() {
        return {
            tabId: this.tabId,
            url: this.url
        };
    }

    // Validates that a value can be parsed as a URL.
    static #isValidURL(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }
}