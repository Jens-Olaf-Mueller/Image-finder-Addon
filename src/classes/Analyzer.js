import BlurScanner from './BlurScanner.js';
import DuplicateFinder from './DuplicateFinder.js';

const HASH_SEGMENT_WIDTHS = [13, 13, 13, 13, 12];

/**
 * Analyzes image candidates incrementally in the offscreen document.
 */
export default class Analyzer {
    #analysisStore = new Map();
    #blurScanner;
    #duplicateFinder;
    #recordsById = new Map();
    #acceptedCandidateIds = new Set();
    #duplicateGroups = new Set();
    #candidateIdsByURL = new Map();
    #candidateIdsByHashSegment = new Map();
    #blurAcceptedByURL = new Map();
    #changedCandidateIds = new Set();
    #filterKey = null;
    #cancelled = false;
    #lastPerformanceSummary = null;

    constructor() {
        this.#blurScanner = new BlurScanner(this.#analysisStore);
        this.#duplicateFinder = new DuplicateFinder(this.#analysisStore);
        this.#duplicateFinder.mode = 'strict';
    }

    clear() {
        this.#resetState();
    }

    // ✴️ NEW 2026-10-09: Removes locally deleted candidates from the incremental analyzer state.
    removeCandidates(candidateIds) {
        if (!Array.isArray(candidateIds)) return 0;

        let removedCount = 0;
        new Set(candidateIds).forEach((candidateId) => {
            const record = this.#recordsById.get(candidateId);
            if (!record) return;

            this.#removeFromDuplicateGroup(record);
            this.#removeFromDuplicateIndex(record);
            this.#analysisStore.delete(candidateId);
            this.#recordsById.delete(candidateId);
            this.#acceptedCandidateIds.delete(candidateId);
            this.#changedCandidateIds.delete(candidateId);
            removedCount += 1;
        });

        return removedCount;
    }

    cancel() {
        this.#cancelled = true;
    }

    getCandidateUpdates() {
        return Array.from(this.#changedCandidateIds, (candidateId) => {
            const candidate = this.#recordsById.get(candidateId)?.candidate;

            return {
                candidateId,
                visuallyBlurred: candidate?.visuallyBlurred,
                discoveryOrder: candidate?.discoveryOrder
            };
        });
    }

    // ✴️ NEW 2026-10-08: Lets the offscreen message transport the latest phase timings.
    getPerformanceSummary() {
        return this.#lastPerformanceSummary;
    }

    async filterCandidates(candidates, {
        filters = {},
        incremental = false,
        previousVisibleImageIds = new Set(),
        onActivityChange = null,
        onBlurProgress = null,
        onDuplicateFinderProgress = null
    } = {}) {
        if (!Array.isArray(candidates)) return [];

        const filterKey = this.#getFilterKey(filters);
        const canIncrementallyUpdate = incremental === true && this.#filterKey === filterKey;
        if (!canIncrementallyUpdate) this.#resetState();

        const performanceSummary = this.#createPerformanceSummary(candidates, {
            filters,
            incremental: canIncrementallyUpdate
        });
        const isCurrent = () => !this.#cancelled;
        this.#filterKey = filterKey;
        this.#changedCandidateIds.clear();
        const changedRecords = this.#storeCandidates(candidates);
        performanceSummary.candidates.changed = changedRecords.length;
        let status = 'completed';
        let visibleResults = null;

        try {
            const newlyAcceptedRecords = await this.#acceptCandidates(changedRecords, {
                filters,
                isCurrent,
                onActivityChange,
                onProgress: onBlurProgress,
                performanceSummary
            });
            if (!newlyAcceptedRecords || !isCurrent()) {
                status = 'cancelled';
                return null;
            }

            if (filters.ignoreDuplicates === true) {
                const recordsToIndex = canIncrementallyUpdate
                    ? newlyAcceptedRecords
                    : this.#getAcceptedRecords();
                const duplicatesIndexed = await this.#indexDuplicateCandidates(recordsToIndex, {
                    isCurrent,
                    onActivityChange,
                    onProgress: onDuplicateFinderProgress,
                    performanceSummary
                });
                if (!duplicatesIndexed || !isCurrent()) {
                    status = 'cancelled';
                    return null;
                }
            }

            visibleResults = this.#getVisibleResults(filters, previousVisibleImageIds);
            performanceSummary.candidates.visible = visibleResults.length;
            return visibleResults;
        } catch (error) {
            status = 'failed';
            throw error;
        } finally {
            performanceSummary.status = status;
            performanceSummary.durationMs = performance.now() - performanceSummary.startedAt;
            delete performanceSummary.startedAt;
            this.#lastPerformanceSummary = performanceSummary;
        }
    }

    #resetState() {
        this.#analysisStore.clear();
        this.#recordsById.clear();
        this.#acceptedCandidateIds.clear();
        this.#duplicateGroups.clear();
        this.#candidateIdsByURL.clear();
        this.#candidateIdsByHashSegment.clear();
        this.#blurAcceptedByURL.clear();
        this.#changedCandidateIds.clear();
        this.#filterKey = null;
        this.#lastPerformanceSummary = null;
    }

    #getFilterKey(filters) {
        return JSON.stringify({
            ignoreBlurredImages: filters.ignoreBlurredImages === true,
            ignoreDuplicates: filters.ignoreDuplicates === true
        });
    }

    // ✴️ NEW 2026-10-08: Tracks one filter request without retaining image data.
    #createPerformanceSummary(candidates, {filters, incremental}) {
        const uniqueURLs = new Set(candidates.flatMap((candidateEntry) => {
            const url = candidateEntry?.[1]?.url;
            return typeof url === 'string' && url ? [url] : [];
        }));

        return {
            status: 'running',
            startedAt: performance.now(),
            durationMs: 0,
            incremental,
            filters: {
                ignoreBlurredImages: filters.ignoreBlurredImages === true,
                ignoreDuplicates: filters.ignoreDuplicates === true
            },
            candidates: {
                supplied: candidates.length,
                uniqueURLs: uniqueURLs.size,
                changed: 0,
                visible: 0
            },
            imagePreparation: {
                cacheHits: 0,
                sourceLoadAttempts: 0,
                sourceLoadMs: 0,
                sourceLoadFailures: 0,
                normalizationRuns: 0,
                normalizationMs: 0,
                normalizationFailures: 0
            },
            blurScanner: {
                candidates: 0,
                uniqueURLMeasurements: 0,
                urlReuseCount: 0,
                accepted: 0,
                rejected: 0,
                errors: 0,
                calculationRuns: 0,
                calculationMs: 0,
                durationMs: 0
            },
            duplicateFinder: {
                candidates: 0,
                exactURLMatches: 0,
                hashCalculations: 0,
                hashCalculationMs: 0,
                errors: 0,
                groupingMs: 0,
                durationMs: 0
            }
        };
    }

    // ✴️ NEW 2026-10-08: Aggregates image loading and normalization shared by both filters.
    #recordImagePreparationTiming(performanceSummary, timing) {
        if (!timing || typeof timing !== 'object') return;

        const metrics = performanceSummary.imagePreparation;
        if (timing.stage === 'cache') {
            metrics.cacheHits += 1;
            return;
        }

        const durationMs = Number(timing.durationMs);
        const isDuration = Number.isFinite(durationMs) && durationMs >= 0;
        if (timing.stage === 'imageLoad') {
            metrics.sourceLoadAttempts += 1;
            if (isDuration) metrics.sourceLoadMs += durationMs;
            if (timing.failed === true) metrics.sourceLoadFailures += 1;
            return;
        }

        if (timing.stage === 'preparation') {
            metrics.normalizationRuns += 1;
            if (isDuration) metrics.normalizationMs += durationMs;
            if (timing.failed === true) metrics.normalizationFailures += 1;
        }
    }

    #storeCandidates(candidates) {
        const changedRecords = [];

        candidates.forEach((candidateEntry) => {
            const [candidateId, candidate] = candidateEntry ?? [];
            if (!candidateId || !candidate) return;

            const record = this.#recordsById.get(candidateId);
            if (!record) {
                const nextRecord = {
                    candidateId,
                    candidate,
                    blurAccepted: false,
                    hash: null,
                    duplicateGroup: null,
                    indexed: false
                };
                this.#recordsById.set(candidateId, nextRecord);
                changedRecords.push(nextRecord);
                return;
            }

            record.candidate = candidate;
            changedRecords.push(record);
        });

        return changedRecords;
    }

    async #acceptCandidates(records, {
        filters,
        isCurrent,
        onActivityChange,
        onProgress,
        performanceSummary
    }) {
        const newRecords = records.filter((record) => record.blurAccepted !== true);
        if (newRecords.length === 0) return [];

        if (filters.ignoreBlurredImages !== true) {
            newRecords.forEach((record) => {
                record.blurAccepted = true;
                this.#acceptedCandidateIds.add(record.candidateId);
            });
            return newRecords;
        }

        performanceSummary.blurScanner.candidates += newRecords.length;
        const blurStartedAt = performance.now();
        onActivityChange?.('blurScanner', true);
        const acceptedRecords = [];
        try {
            for (let index = 0; index < newRecords.length; index++) {
                const record = newRecords[index];
                if (!isCurrent()) return null;

                const knownBlurResult = this.#blurAcceptedByURL.get(record.candidate.url);
                if (knownBlurResult !== undefined) {
                    performanceSummary.blurScanner.urlReuseCount += 1;
                    record.blurAccepted = knownBlurResult;
                    if (knownBlurResult) {
                        this.#acceptedCandidateIds.add(record.candidateId);
                        acceptedRecords.push(record);
                        performanceSummary.blurScanner.accepted += 1;
                    } else {
                        performanceSummary.blurScanner.rejected += 1;
                    }
                    onProgress?.(index + 1, newRecords.length);
                    continue;
                }

                performanceSummary.blurScanner.uniqueURLMeasurements += 1;
                try {
                    const measurement = await this.#blurScanner.measure(
                        record.candidate.url,
                        record.candidateId,
                        {
                            onPreparationTiming: (timing) =>
                                this.#recordImagePreparationTiming(performanceSummary, timing),
                            onCalculationTiming: (durationMs) => {
                                performanceSummary.blurScanner.calculationRuns += 1;
                                performanceSummary.blurScanner.calculationMs += durationMs;
                            }
                        }
                    );
                    const classification = this.#blurScanner.classify(measurement);

                    if (classification !== 'blurred') {
                        record.blurAccepted = true;
                        this.#acceptedCandidateIds.add(record.candidateId);
                        acceptedRecords.push(record);
                        performanceSummary.blurScanner.accepted += 1;
                    } else {
                        performanceSummary.blurScanner.rejected += 1;
                    }
                } catch (error) {
                    console.warn('Cannot analyze image blur:', record.candidate.url, error);
                    performanceSummary.blurScanner.errors += 1;
                    record.blurAccepted = true;
                    this.#acceptedCandidateIds.add(record.candidateId);
                    acceptedRecords.push(record);
                    performanceSummary.blurScanner.accepted += 1;
                }

                // ✴️ NEW 2026-10-08: One URL has one source image and one blur result.
                this.#blurAcceptedByURL.set(record.candidate.url, record.blurAccepted === true);

                onProgress?.(index + 1, newRecords.length);
            }
        } finally {
            performanceSummary.blurScanner.durationMs += performance.now() - blurStartedAt;
            onActivityChange?.('blurScanner', false);
        }

        return acceptedRecords;
    }

    async #indexDuplicateCandidates(records, {
        isCurrent,
        onActivityChange,
        onProgress,
        performanceSummary
    }) {
        const recordsToIndex = records.filter((record) => record.indexed !== true);
        if (recordsToIndex.length === 0) return true;

        performanceSummary.duplicateFinder.candidates += recordsToIndex.length;
        const duplicateFinderStartedAt = performance.now();
        const shouldReportActivity = this.#acceptedCandidateIds.size > 1;
        if (shouldReportActivity) onActivityChange?.('duplicateFinder', true);
        try {
            for (let index = 0; index < recordsToIndex.length; index++) {
                if (!isCurrent()) return false;

                await this.#indexDuplicateCandidate(recordsToIndex[index], performanceSummary);
                onProgress?.(index + 1, recordsToIndex.length);
            }
        } finally {
            performanceSummary.duplicateFinder.durationMs +=
                performance.now() - duplicateFinderStartedAt;
            if (shouldReportActivity) onActivityChange?.('duplicateFinder', false);
        }

        return true;
    }

    async #indexDuplicateCandidate(record, performanceSummary) {
        const matchingURLStartedAt = performance.now();
        const matchingGroups = this.#getMatchingURLGroups(record);
        performanceSummary.duplicateFinder.groupingMs += performance.now() - matchingURLStartedAt;

        if (matchingGroups.size === 0) {
            performanceSummary.duplicateFinder.hashCalculations += 1;
            try {
                record.hash = await this.#duplicateFinder.getStrictHash(
                    record.candidate.url,
                    record.candidateId,
                    {
                        onPreparationTiming: (timing) =>
                            this.#recordImagePreparationTiming(performanceSummary, timing),
                        onCalculationTiming: (durationMs) => {
                            performanceSummary.duplicateFinder.hashCalculationMs += durationMs;
                        }
                    }
                );
                const matchingHashStartedAt = performance.now();
                this.#getMatchingHashGroups(record).forEach((group) => matchingGroups.add(group));
                performanceSummary.duplicateFinder.groupingMs +=
                    performance.now() - matchingHashStartedAt;
            } catch (error) {
                console.error('Cannot analyze possible duplicate image:', record.candidate.url, error);
                performanceSummary.duplicateFinder.errors += 1;
            }
        } else {
            performanceSummary.duplicateFinder.exactURLMatches += 1;
        }

        const groupAssignmentStartedAt = performance.now();
        const targetGroup = Array.from(this.#duplicateGroups).find((group) =>
            matchingGroups.has(group)
        );
        if (targetGroup) {
            targetGroup.add(record.candidateId);
            record.duplicateGroup = targetGroup;
            matchingGroups.forEach((group) => {
                if (group === targetGroup) return;

                group.forEach((candidateId) => {
                    targetGroup.add(candidateId);
                    this.#recordsById.get(candidateId).duplicateGroup = targetGroup;
                });
                this.#duplicateGroups.delete(group);
            });
        } else {
            const group = new Set([record.candidateId]);
            record.duplicateGroup = group;
            this.#duplicateGroups.add(group);
        }

        this.#addToDuplicateIndex(record);
        record.indexed = true;
        performanceSummary.duplicateFinder.groupingMs +=
            performance.now() - groupAssignmentStartedAt;
    }

    #getMatchingURLGroups(record) {
        const matchingGroups = new Set();
        const matchingCandidateIds = this.#candidateIdsByURL.get(record.candidate.url);
        if (!matchingCandidateIds) return matchingGroups;

        matchingCandidateIds.forEach((candidateId) => {
            const matchingRecord = this.#recordsById.get(candidateId);
            if (!matchingRecord?.duplicateGroup) return;

            if (record.candidate.visuallyBlurred === false &&
                matchingRecord.candidate.visuallyBlurred !== false) {
                matchingRecord.candidate.visuallyBlurred = false;
                this.#changedCandidateIds.add(candidateId);
            }
            matchingGroups.add(matchingRecord.duplicateGroup);
        });
        return matchingGroups;
    }

    #getMatchingHashGroups(record) {
        const matchingGroups = new Set();

        this.#getHashSegmentKeys(record.hash).forEach((segmentKey) => {
            this.#candidateIdsByHashSegment.get(segmentKey)?.forEach((candidateId) => {
                const matchingRecord = this.#recordsById.get(candidateId);
                if (!matchingRecord?.duplicateGroup ||
                    !this.#duplicateFinder.isStrictHashMatch(record.hash, matchingRecord.hash)) {
                    return;
                }

                matchingGroups.add(matchingRecord.duplicateGroup);
            });
        });
        return matchingGroups;
    }

    #addToDuplicateIndex(record) {
        const candidateIdsForURL = this.#candidateIdsByURL.get(record.candidate.url) ?? new Set();
        candidateIdsForURL.add(record.candidateId);
        this.#candidateIdsByURL.set(record.candidate.url, candidateIdsForURL);

        if (typeof record.hash !== 'bigint') return;

        this.#getHashSegmentKeys(record.hash).forEach((segmentKey) => {
            const candidateIds = this.#candidateIdsByHashSegment.get(segmentKey) ?? new Set();
            candidateIds.add(record.candidateId);
            this.#candidateIdsByHashSegment.set(segmentKey, candidateIds);
        });
    }

    // ✴️ NEW 2026-10-09: Removes one candidate from every duplicate lookup structure.
    #removeFromDuplicateIndex(record) {
        const candidateIdsForURL = this.#candidateIdsByURL.get(record.candidate.url);
        candidateIdsForURL?.delete(record.candidateId);
        if (candidateIdsForURL?.size === 0) {
            this.#candidateIdsByURL.delete(record.candidate.url);
            this.#blurAcceptedByURL.delete(record.candidate.url);
        }

        if (typeof record.hash !== 'bigint') return;

        this.#getHashSegmentKeys(record.hash).forEach((segmentKey) => {
            const candidateIds = this.#candidateIdsByHashSegment.get(segmentKey);
            candidateIds?.delete(record.candidateId);
            if (candidateIds?.size === 0) this.#candidateIdsByHashSegment.delete(segmentKey);
        });
    }

    // ✴️ NEW 2026-10-09: Keeps duplicate groups valid after a candidate was deleted.
    #removeFromDuplicateGroup(record) {
        const duplicateGroup = record.duplicateGroup;
        if (!duplicateGroup) return;

        duplicateGroup.delete(record.candidateId);
        if (duplicateGroup.size === 0) this.#duplicateGroups.delete(duplicateGroup);
        record.duplicateGroup = null;
    }

    #getHashSegmentKeys(hash) {
        if (typeof hash !== 'bigint') return [];

        let offset = 0n;
        return HASH_SEGMENT_WIDTHS.map((width, index) => {
            const bitWidth = BigInt(width);
            const mask = (1n << bitWidth) - 1n;
            const segment = (hash >> offset) & mask;

            offset += bitWidth;
            return `${index}:${segment.toString(16)}`;
        });
    }

    #getAcceptedRecords() {
        return Array.from(this.#acceptedCandidateIds, (candidateId) =>
            this.#recordsById.get(candidateId)
        ).filter(Boolean);
    }

    #getVisibleResults(filters, previousVisibleImageIds) {
        if (filters.ignoreDuplicates !== true) {
            return this.#getAcceptedRecords().map((record) => ({
                candidateEntry: [record.candidateId, record.candidate],
                replacesExistingResult: false
            }));
        }

        return Array.from(this.#duplicateGroups, (group) => {
            const candidateEntries = Array.from(group, (candidateId) => {
                const record = this.#recordsById.get(candidateId);
                return [candidateId, record.candidate];
            });
            const candidateEntry = this.#selectDuplicateWinner(candidateEntries);
            const replacedResult = candidateEntries.find(([candidateId]) =>
                previousVisibleImageIds.has(candidateId) && candidateId !== candidateEntry[0]
            );
            const replacesExistingResult = Boolean(replacedResult);

            if (replacedResult && Number.isInteger(replacedResult[1].discoveryOrder) &&
                candidateEntry[1].discoveryOrder !== replacedResult[1].discoveryOrder) {
                candidateEntry[1].discoveryOrder = replacedResult[1].discoveryOrder;
                this.#changedCandidateIds.add(candidateEntry[0]);
            }

            return {candidateEntry, replacesExistingResult};
        });
    }

    #selectDuplicateWinner(group) {
        return group.reduce((winner, candidateEntry) =>
            this.#getPixelCount(candidateEntry[1]) > this.#getPixelCount(winner[1])
                ? candidateEntry
                : winner
        );
    }

    #getPixelCount(candidate) {
        const width = Number(candidate?.width);
        const height = Number(candidate?.height);

        return Number.isFinite(width) && Number.isFinite(height)
            ? Math.max(0, width) * Math.max(0, height)
            : 0;
    }
}
