const OFFSCREEN_TARGET = 'image-finder-offscreen';
const OFFSCREEN_ANALYZER_CONTROL_TARGET = 'image-finder-offscreen-analyzer-control';
const OFFSCREEN_ANALYZER_EVENT_TARGET = 'image-finder-offscreen-analyzer-event';

/**
 * Coordinates media analysis through the offscreen document.
 */
export default class AnalyzerClient {
    #sessionId = crypto.randomUUID();
    #analysisGeneration = 0;
    #offscreenReady = false;
    #remoteSessionInitialized = false;
    #analysisInitialized = false;
    #filterKey = null;
    #pendingRequests = new Map();
    #analysisQueue = Promise.resolve();
    #removedCandidateIds = new Set();
    #onMessage;
    #disposed = false;

    constructor() {
        this.#onMessage = (message) => this.#handleOffscreenEvent(message);
        window.chrome.runtime.onMessage.addListener(this.#onMessage);
        window.addEventListener('pagehide', () => this.dispose(), {once: true});
    }

    clear() {
        if (this.#disposed) return;

        this.#analysisGeneration += 1;
        this.#analysisInitialized = false;
        this.#filterKey = null;
        this.#removedCandidateIds.clear();
        if (!this.#remoteSessionInitialized) return;

        void this.#resetRemoteSession();
    }

    dispose() {
        if (this.#disposed) return;

        this.#disposed = true;
        window.chrome.runtime.onMessage.removeListener(this.#onMessage);
        if (!this.#remoteSessionInitialized) return;

        void this.#requestOffscreen('releaseAnalyzerSession', {
            sessionId: this.#sessionId
        }).catch(() => undefined);
    }

    async filterCandidates(candidates, {
        allCandidates = candidates,
        filters = {},
        incremental = false,
        previousVisibleImageIds = new Set(),
        isCurrent = () => true,
        onActivityChange = null,
        onBlurProgress = null,
        onDuplicateFinderProgress = null
    } = {}) {
        const runsBlurScanner = filters.ignoreBlurredImages === true && candidates.length > 0;
        const runsDuplicateFinder = filters.ignoreDuplicates === true && candidates.length > 0;
        if (!runsBlurScanner && !runsDuplicateFinder) {
            this.#analysisInitialized = false;
            this.#filterKey = null;
            return allCandidates.map((candidateEntry) => ({
                candidateEntry,
                replacesExistingResult: false
            }));
        }
        if (!isCurrent()) return null;

        return this.#queueAnalysisRequest(async () => {
            if (!isCurrent()) return null;

            await this.#ensureOffscreenDocument();
            if (!isCurrent()) return null;

            this.#remoteSessionInitialized = true;
            const filterKey = this.#getFilterKey(filters);
            const usesIncrementalAnalysis = incremental === true &&
                this.#analysisInitialized && this.#filterKey === filterKey;
            const analysisCandidates = usesIncrementalAnalysis ? candidates : allCandidates;
            const requestId = crypto.randomUUID();
            this.#pendingRequests.set(requestId, {
                isCurrent,
                onActivityChange,
                onBlurProgress,
                onDuplicateFinderProgress
            });

            try {
                const response = await this.#requestOffscreen('analyzeCandidates', {
                    sessionId: this.#sessionId,
                    analysisGeneration: this.#analysisGeneration,
                    requestId,
                    candidates: analysisCandidates,
                    filters,
                    incremental: usesIncrementalAnalysis,
                    previousVisibleImageIds: Array.from(previousVisibleImageIds)
                });
                if (!isCurrent()) return null;

                this.#analysisInitialized = true;
                this.#filterKey = filterKey;
                // ✴️ NEW 2026-10-08: Keep phase metrics with the popup where real scans are inspected.
                if (response.performanceSummary) {
                    console.info('[Analyzer Performance]', response.performanceSummary);
                }
                return this.#applyAnalysisResult(allCandidates, response);
            } finally {
                this.#pendingRequests.delete(requestId);
            }
        });
    }

    // ✴️ NEW 2026-10-09: Synchronizes a local result deletion with the offscreen analyzer.
    removeCandidates(candidateIds) {
        const uniqueCandidateIds = Array.from(new Set((candidateIds ?? []).filter(Boolean)));
        if (uniqueCandidateIds.length === 0) return Promise.resolve(0);

        uniqueCandidateIds.forEach((candidateId) => this.#removedCandidateIds.add(candidateId));
        if (!this.#remoteSessionInitialized) return Promise.resolve(0);

        const analysisGeneration = this.#analysisGeneration;
        return this.#queueAnalysisRequest(async () => {
            if (analysisGeneration !== this.#analysisGeneration) return 0;

            const response = await this.#requestOffscreen('removeAnalyzerCandidates', {
                sessionId: this.#sessionId,
                analysisGeneration,
                candidateIds: uniqueCandidateIds
            });

            return Number(response.removedCount) || 0;
        });
    }

    async #resetRemoteSession() {
        try {
            await this.#requestOffscreen('resetAnalyzerSession', {
                sessionId: this.#sessionId,
                analysisGeneration: this.#analysisGeneration
            });
        } catch (error) {
            console.warn('Cannot reset offscreen analyzer:', error);
        }
    }

    #getFilterKey(filters) {
        return JSON.stringify({
            ignoreBlurredImages: filters.ignoreBlurredImages === true,
            ignoreDuplicates: filters.ignoreDuplicates === true
        });
    }

    // ✴️ NEW 2026-10-09: Prevents deletion requests from mutating an active analyzer batch.
    #queueAnalysisRequest(operation) {
        const request = this.#analysisQueue.then(operation, operation);
        this.#analysisQueue = request.catch(() => undefined);
        return request;
    }

    async #ensureOffscreenDocument() {
        if (this.#offscreenReady) return;

        const response = await window.chrome.runtime.sendMessage({
            target: OFFSCREEN_ANALYZER_CONTROL_TARGET,
            action: 'ensureOffscreenDocument'
        });
        if (response?.success !== true) {
            throw new Error(response?.error || 'Cannot create the offscreen analyzer document');
        }

        this.#offscreenReady = true;
    }

    async #requestOffscreen(action, payload) {
        try {
            return await this.#sendOffscreenRequest(action, payload);
        } catch (error) {
            this.#offscreenReady = false;
            await this.#ensureOffscreenDocument();
            return this.#sendOffscreenRequest(action, payload, error);
        }
    }

    async #sendOffscreenRequest(action, payload, previousError = null) {
        const response = await window.chrome.runtime.sendMessage({
            target: OFFSCREEN_TARGET,
            action,
            ...payload
        });
        if (response?.success === true) return response;

        const reason = response?.error || previousError?.message ||
            `Offscreen request "${action}" failed`;
        throw new Error(reason);
    }

    #handleOffscreenEvent(message) {
        if (message?.target !== OFFSCREEN_ANALYZER_EVENT_TARGET ||
            message.sessionId !== this.#sessionId) {
            return;
        }

        const request = this.#pendingRequests.get(message.requestId);
        if (!request || !request.isCurrent()) return;

        if (message.action === 'activity') {
            request.onActivityChange?.(message.activity, message.isActive === true);
            return;
        }
        if (message.action !== 'progress') return;

        if (message.stage === 'blurScanner') {
            request.onBlurProgress?.(message.completed, message.total);
        } else if (message.stage === 'duplicateFinder') {
            request.onDuplicateFinderProgress?.(message.completed, message.total);
        }
    }

    #applyAnalysisResult(candidates, response) {
        if (!Array.isArray(response?.results)) {
            throw new Error('The offscreen analyzer returned invalid results');
        }

        const candidateEntriesById = new Map(candidates.map((candidateEntry) => [
            candidateEntry[0],
            candidateEntry
        ]));
        response.candidateUpdates?.forEach((update) => {
            const candidate = candidateEntriesById.get(update?.candidateId)?.[1];
            if (!candidate) return;

            if (Object.hasOwn(update, 'visuallyBlurred')) {
                candidate.visuallyBlurred = update.visuallyBlurred;
            }
            if (Object.hasOwn(update, 'discoveryOrder')) {
                candidate.discoveryOrder = update.discoveryOrder;
            }
        });

        return response.results.flatMap((result) => {
            if (this.#removedCandidateIds.has(result?.candidateId)) return [];

            const candidateEntry = candidateEntriesById.get(result?.candidateId);
            if (!candidateEntry) {
                throw new Error('The offscreen analyzer returned an unknown candidate');
            }

            return [{
                candidateEntry,
                replacesExistingResult: result.replacesExistingResult === true
            }];
        });
    }
}
