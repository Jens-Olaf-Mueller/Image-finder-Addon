/**
 * Tracks source-relevant DOM changes during one hidden DeepScan run.
 */
export default class DeepScanDOMState {
    #scanDocument;
    #mutationAttributes;
    #onActivity;
    #observer = null;
    #pendingRoots = new Set();
    #dirtyGenericRoots = new Set();
    #knownGenericRoots = new Set();
    #knownDirectTargets = new Set();
    #metrics = {
        relevantMutations: 0,
        childListMutations: 0,
        attributeMutations: 0,
        imageLoadEvents: 0,
        fullScopes: 0,
        deltaScopes: 0,
        emptyDeltaScopes: 0,
        deltaRoots: 0,
        dirtyGenericRoots: 0
    };

    /**
     * @param {Document} [scanDocument=document] Document of the hidden DeepScan context.
     * @param {string[]} [mutationAttributes=[]] Attributes which can provide a media source.
     * @param {Function|null} [onActivity=null] Receives source-relevant DOM activity.
     */
    constructor({scanDocument = document, mutationAttributes = [], onActivity = null} = {}) {
        this.#scanDocument = scanDocument;
        this.#mutationAttributes = mutationAttributes;
        this.#onActivity = typeof onActivity === 'function' ? onActivity : null;
    }

    /** Starts observing source-relevant DOM changes and image loads. */
    start() {
        if (this.#observer || !this.#scanDocument?.documentElement ||
            typeof MutationObserver !== 'function') {
            return;
        }

        this.#observer = new MutationObserver((records) => this.#handleMutations(records));
        this.#observer.observe(this.#scanDocument.documentElement, {
            subtree: true,
            childList: true,
            attributes: true,
            attributeFilter: this.#mutationAttributes
        });
        this.#scanDocument.addEventListener('load', this.#onImageLoad, true);
    }

    /** Stops observation while retaining counters for the final performance summary. */
    stop() {
        this.#observer?.disconnect();
        this.#observer = null;
        this.#scanDocument?.removeEventListener('load', this.#onImageLoad, true);
    }

    /**
     * Registers a generic carousel root after discovery.
     * @param {Element|null} root Discovered carousel root.
     */
    registerGenericRoot(root) {
        if (root?.nodeType === Node.ELEMENT_NODE) this.#knownGenericRoots.add(root);
    }

    /**
     * Registers a direct PhotoSwipe target after discovery.
     * @param {Element|null} target Discovered direct PhotoSwipe target.
     */
    registerDirectTarget(target) {
        if (target?.nodeType === Node.ELEMENT_NODE) this.#knownDirectTargets.add(target);
    }

    /**
     * Marks a processed generic root as clean for the current collection.
     * @param {Element|null} root Processed carousel root.
     */
    markGenericRootProcessed(root) {
        this.#dirtyGenericRoots.delete(root);
    }

    /**
     * Returns the DOM scope for one source collection.
     * @param {'initial'|'delta'|'final'} [phase='delta'] Collection phase.
     * @returns {{phase: string, roots: Element[]|Document[], dirtyGenericRoots: Set<Element>}}
     */
    consumeScope(phase = 'delta') {
        if (phase === 'initial' || phase === 'final') {
            this.#pendingRoots.clear();
            this.#dirtyGenericRoots.clear();
            this.#metrics.fullScopes += 1;
            return {
                phase,
                roots: [this.#scanDocument],
                dirtyGenericRoots: new Set()
            };
        }

        const roots = this.#getMinimalRoots(this.#pendingRoots);
        const dirtyGenericRoots = new Set(this.#dirtyGenericRoots);
        this.#pendingRoots.clear();
        this.#dirtyGenericRoots.clear();
        this.#metrics.deltaScopes += 1;
        this.#metrics.deltaRoots += roots.length;
        this.#metrics.dirtyGenericRoots += dirtyGenericRoots.size;
        if (roots.length === 0 && dirtyGenericRoots.size === 0) {
            this.#metrics.emptyDeltaScopes += 1;
        }

        return {phase, roots, dirtyGenericRoots};
    }

    /** Returns collection and observer counters for the DeepScan performance summary. */
    getMetrics() {
        return {
            ...this.#metrics,
            knownGenericRoots: this.#knownGenericRoots.size,
            knownDirectTargets: this.#knownDirectTargets.size,
            pendingRoots: this.#pendingRoots.size,
            pendingGenericRoots: this.#dirtyGenericRoots.size
        };
    }

    // Captures image loads which do not necessarily change an attribute value.
    #onImageLoad = (e) => {
        const elm = e.target;
        if (elm?.nodeType !== Node.ELEMENT_NODE || !['IMG', 'SOURCE'].includes(elm.tagName)) {
            return;
        }

        this.#metrics.imageLoadEvents += 1;
        this.#queueElement(elm);
        this.#onActivity?.({records: [], imageLoads: 1});
    };

    // Converts relevant mutations into narrow source-collection roots.
    #handleMutations(records) {
        const relevantRecords = records.filter((record) => this.#isRelevantMutation(record));
        if (relevantRecords.length === 0) return;

        relevantRecords.forEach((record) => {
            if (record.type === 'attributes') {
                this.#metrics.attributeMutations += 1;
                this.#queueElement(record.target);
                return;
            }

            this.#metrics.childListMutations += 1;
            Array.from(record.addedNodes ?? []).forEach((node) => this.#queueNode(node));
            this.#markKnownRootsDirty(record.target);
        });
        this.#metrics.relevantMutations += relevantRecords.length;
        this.#onActivity?.({records: relevantRecords, imageLoads: 0});
    }

    // Queues an added element or every added element of a document fragment.
    #queueNode(node) {
        if (!node || this.#isGeneratedScrollAnchor(node)) return;
        if (node.nodeType === Node.ELEMENT_NODE) {
            this.#queueElement(node);
            return;
        }
        if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;

        Array.from(node.children ?? []).forEach((elm) => this.#queueElement(elm));
    }

    // Queues the smallest known target ancestor or the changed element itself.
    #queueElement(elm) {
        if (elm?.nodeType !== Node.ELEMENT_NODE || this.#isGeneratedScrollAnchor(elm)) return;

        const genericRoot = this.#getKnownAncestor(elm, this.#knownGenericRoots);
        if (genericRoot) this.#dirtyGenericRoots.add(genericRoot);

        const directTarget = this.#getKnownAncestor(elm, this.#knownDirectTargets);
        this.#pendingRoots.add(directTarget ?? elm);
    }

    // Marks known generic carousel roots dirty without widening the image scan scope.
    #markKnownRootsDirty(node) {
        const root = this.#getKnownAncestor(node, this.#knownGenericRoots);
        if (root) this.#dirtyGenericRoots.add(root);
    }

    // Returns the closest tracked ancestor across open shadow-root boundaries.
    #getKnownAncestor(node, knownElements) {
        let elm = node?.nodeType === Node.ELEMENT_NODE
            ? node
            : node?.parentElement ?? null;
        while (elm) {
            if (knownElements.has(elm)) return elm;
            elm = elm.parentElement ?? elm.getRootNode?.().host ?? null;
        }
        return null;
    }

    // Removes delta roots already covered by another queued ancestor.
    #getMinimalRoots(roots) {
        const rootSet = new Set(Array.from(roots).filter((elm) => elm?.isConnected !== false));
        return Array.from(rootSet).filter((elm) => {
            let parent = elm.parentElement ?? elm.getRootNode?.().host ?? null;
            while (parent) {
                if (rootSet.has(parent)) return false;
                parent = parent.parentElement ?? parent.getRootNode?.().host ?? null;
            }
            return true;
        });
    }

    // Ignores the temporary nodes used only to move the hidden DeepScan viewport.
    #isGeneratedScrollAnchor(node) {
        return node?.nodeType === Node.ELEMENT_NODE &&
            node.hasAttribute?.('data-image-finder-scroll-anchor');
    }

    // Limits observation to mutations that can reveal a new media source.
    #isRelevantMutation(record) {
        if (record.type === 'attributes') {
            return !this.#isGeneratedScrollAnchor(record.target);
        }

        return Array.from(record.addedNodes ?? []).some((node) => !this.#isGeneratedScrollAnchor(node) && (
            node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.DOCUMENT_FRAGMENT_NODE
        ));
    }
}
