function isScannableURL(url) {
    try {
        return ['http:', 'https:'].includes(new URL(url).protocol);
    } catch {
        return false;
    }
}

function isValidURL(url) {
    try {
        new URL(url);
        return true;
    } catch {
        return false;
    }
}

export class ScanContext {
    #tabId = null;
    #url = null;

    constructor(tab = null) {
        this.setTab(tab);
    }

    get tabId() {
        return this.#tabId;
    }

    get url() {
        return this.#url;
    }

    get isScannable() {
        return isScannableURL(this.#url);
    }

    setTab(tab) {
        if (!Number.isInteger(tab?.id) || typeof tab.url !== 'string' || !tab.url ||
            !isValidURL(tab.url)) {
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
