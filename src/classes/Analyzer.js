import BlurScanner from './BlurScanner.js';
import DuplicateFinder from './DuplicateFinder.js';

/**
 * Coordinates media analysis and will route work to media-specific analyzers.
 */
export default class Analyzer {
    #analysisStore = new Map();
    #blurScanner;
    #duplicateFinder;

    constructor() {
        this.#blurScanner = new BlurScanner(this.#analysisStore);
        this.#duplicateFinder = new DuplicateFinder(this.#analysisStore);
        this.#duplicateFinder.mode = 'strict';
    }

    clear() {
        this.#analysisStore.clear();
    }

    async filterCandidates(candidates, {
        filters = {},
        previousVisibleImageIds = new Set(),
        isCurrent = () => true,
        onActivityChange = null,
        onBlurProgress = null,
        onDuplicateFinderProgress = null
    } = {}) {
        const blurAcceptedCandidates = await this.#getBlurAcceptedCandidates(candidates, {
            filters,
            isCurrent,
            onActivityChange,
            onProgress: onBlurProgress
        });
        if (!blurAcceptedCandidates || !isCurrent()) return null;

        return this.#getDuplicateWinners(blurAcceptedCandidates, {
            filters,
            previousVisibleImageIds,
            isCurrent,
            onActivityChange,
            onProgress: onDuplicateFinderProgress
        });
    }

    async #getBlurAcceptedCandidates(candidates, {
        filters,
        isCurrent,
        onActivityChange,
        onProgress
    }) {
        if (filters.ignoreBlurredImages !== true) return candidates;

        const acceptedCandidateIds = new Set();

        if (candidates.length === 0) return candidates;

        onActivityChange?.('blurScanner', true);
        try {
            for (let index = 0; index < candidates.length; index++) {
                const [candidateId, candidate] = candidates[index];
                if (!isCurrent()) return null;

                try {
                    const measurement = await this.#blurScanner.measure(candidate.url, candidateId);
                    const classification = this.#blurScanner.classify(measurement);

                    if (classification !== 'blurred') {
                        acceptedCandidateIds.add(candidateId);
                    }
                } catch (error) {
                    console.warn('Cannot analyze image blur:', candidate.url, error);
                    acceptedCandidateIds.add(candidateId);
                }

                onProgress?.(index + 1, candidates.length);
            }
        } finally {
            onActivityChange?.('blurScanner', false);
        }

        return candidates.filter(([candidateId]) => acceptedCandidateIds.has(candidateId));
    }

    async #getDuplicateWinners(acceptedCandidates, {
        filters,
        previousVisibleImageIds,
        isCurrent,
        onActivityChange,
        onProgress
    }) {
        if (filters.ignoreDuplicates !== true || acceptedCandidates.length < 2) {
            return acceptedCandidates.map((candidateEntry) => ({
                candidateEntry,
                replacesExistingResult: false
            }));
        }

        onActivityChange?.('duplicateFinder', true);
        try {
            const duplicateGroups = [];

            for (let index = 0; index < acceptedCandidates.length; index++) {
                const candidateEntry = acceptedCandidates[index];
                if (!isCurrent()) return null;

                const matchingGroups = [];

                for (const group of duplicateGroups) {
                    if (await this.#matchesDuplicateGroup(candidateEntry, group)) {
                        matchingGroups.push(group);
                    }
                }

                if (matchingGroups.length === 0) {
                    duplicateGroups.push([candidateEntry]);
                } else {
                    const [targetGroup, ...groupsToMerge] = matchingGroups;

                    targetGroup.push(candidateEntry);
                    groupsToMerge.forEach((group) => {
                        targetGroup.push(...group);
                        duplicateGroups.splice(duplicateGroups.indexOf(group), 1);
                    });
                }

                onProgress?.(index + 1, acceptedCandidates.length);
            }

            return duplicateGroups.map((group) => {
                const candidateEntry = this.#selectDuplicateWinner(group);
                const replacedResult = group.find(([candidateId]) =>
                    previousVisibleImageIds.has(candidateId) && candidateId !== candidateEntry[0]
                );
                const replacesExistingResult = Boolean(replacedResult);

                if (replacedResult && Number.isInteger(replacedResult[1].discoveryOrder)) {
                    candidateEntry[1].discoveryOrder = replacedResult[1].discoveryOrder;
                }

                return {candidateEntry, replacesExistingResult};
            });
        } finally {
            onActivityChange?.('duplicateFinder', false);
        }
    }

    async #matchesDuplicateGroup([candidateId, candidate], group) {
        for (const [groupCandidateId, groupCandidate] of group) {
            if (candidate.url === groupCandidate.url) {
                if (candidate.visuallyBlurred === false) {
                    groupCandidate.visuallyBlurred = false;
                }
                return true;
            }

            try {
                const comparison = await this.#duplicateFinder.compare(
                    candidate.url,
                    candidateId,
                    groupCandidate.url,
                    groupCandidateId
                );

                if (this.#duplicateFinder.isStrictMatch(comparison)) return true;
            } catch (error) {
                console.error(
                    'Cannot compare possible duplicate images:',
                    candidate.url,
                    groupCandidate.url,
                    error
                );
            }
        }

        return false;
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
