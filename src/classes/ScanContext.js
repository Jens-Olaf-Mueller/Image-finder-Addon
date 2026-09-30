export class ScanContext {
    #tabId = null;
    get tabId() { return this.#tabId; }

    #url = null;
    get url() { return this.#url; }

    get isScannable() {
        try {
            return ['http:', 'https:'].includes(new URL(this.#url).protocol);
        } catch {
            return false;
        }
    }

    constructor(tab = null) {
        this.setTab(tab);
    }

    static #isValidURL(url) {
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    setTab(tab) {
        if (!Number.isInteger(tab?.id) || typeof tab.url !== 'string' || !tab.url ||
            !ScanContext.#isValidURL(tab.url)) {
            return this.clear();
        }

        this.#tabId = tab.id;
        this.#url = tab.url;
        return this;
    }

    clear() {
        this.#tabId = null;
        this.#url = null;
        return this;
    }

    toJSON() {
        return {
            tabId: this.tabId,
            url: this.url
        };
    }
}