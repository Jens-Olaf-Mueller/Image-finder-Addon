/**
 * Base class for shared image-analysis infrastructure used by BlurScanner and ImageMatcher.
 * The injected store contains session-scoped data; concrete analysis algorithms follow later.
 */
export default class Heuristik {
    #analysisStore;

    constructor(analysisStore) {
        if (!(analysisStore instanceof Map)) {
            throw new TypeError('Heuristik requires an injected analysis store Map');
        }

        this.#analysisStore = analysisStore;
    }

    hasAnalysis(key) {
        return this.#analysisStore.has(key);
    }

    getAnalysis(key) {
        return this.#analysisStore.get(key);
    }

    setAnalysis(key, value) {
        this.#analysisStore.set(key, value);
    }

    deleteAnalysis(key) {
        return this.#analysisStore.delete(key);
    }

    clearAnalysis() {
        this.#analysisStore.clear();
    }
}
