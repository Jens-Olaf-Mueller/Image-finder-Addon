const RESULT_MARKER_PRIORITIES = Object.freeze({
    normal: 0,
    new: 1,
    upgrade: 2
});

/**
 * Stores media candidates, visible results, ordering, markers, and download state for one scan.
 */
export default class ResultStore {
    #candidates = new Map();
    #images = new Map();
    #downloadStates = new Map();
    #visibleResultStates = new Map();
    #nextDiscoveryOrder = 0;

    get candidates() {
        return this.#candidates;
    }

    get images() {
        return this.#images;
    }

    clear() {
        this.#candidates.clear();
        this.#images.clear();
        this.#downloadStates.clear();
        this.#visibleResultStates.clear();
        this.#nextDiscoveryOrder = 0;
    }

    addCandidates(scanResults, {markerOrigin = 'normal'} = {}) {
        if (!Array.isArray(scanResults)) return;

        scanResults.forEach((image) => {
            if (!Number.isInteger(image?.discoveryOrder)) {
                image.discoveryOrder = this.#nextDiscoveryOrder;
                this.#nextDiscoveryOrder += 1;
            }
            if (markerOrigin === 'deepScan') {
                image.pendingMarkerState = 'new';
            } else {
                this.setResultMarker(image, 'normal');
            }
            this.#candidates.set(image.id, image);
        });
    }

    getNewURLCandidates(rawCandidates) {
        if (!Array.isArray(rawCandidates)) {
            return {
                newCandidates: [],
                existingCandidatesUpdated: false,
                existingCandidateUpgradeCount: 0,
                updatedCandidateIds: []
            };
        }

        const candidatesByURL = new Map();
        this.#candidates.forEach((candidate) => {
            if (typeof candidate?.url !== 'string') return;

            const matchingCandidates = candidatesByURL.get(candidate.url) ?? [];
            matchingCandidates.push(candidate);
            candidatesByURL.set(candidate.url, matchingCandidates);
        });

        const newCandidatesByURL = new Map();
        let existingCandidatesUpdated = false;
        let existingCandidateUpgradeCount = 0;
        const updatedCandidateIds = new Set();
        rawCandidates.forEach((candidate) => {
            if (typeof candidate?.url !== 'string' || !candidate.url) return;

            const matchingCandidates = candidatesByURL.get(candidate.url);
            if (matchingCandidates) {
                matchingCandidates.forEach((existingCandidate) => {
                    if (candidate.visuallyBlurred === false) {
                        existingCandidate.visuallyBlurred = false;
                    }
                    if (this.getPixelCount(candidate) <= this.getPixelCount(existingCandidate)) {
                        return;
                    }

                    existingCandidate.width = candidate.width;
                    existingCandidate.height = candidate.height;
                    existingCandidate.pendingMarkerState = 'upgrade';
                    existingCandidatesUpdated = true;
                    existingCandidateUpgradeCount += 1;
                    updatedCandidateIds.add(existingCandidate.id);
                });
                return;
            }

            const alreadyAddedCandidate = newCandidatesByURL.get(candidate.url);
            if (alreadyAddedCandidate) {
                if (candidate.visuallyBlurred === false) {
                    alreadyAddedCandidate.visuallyBlurred = false;
                }
                if (this.getPixelCount(candidate) > this.getPixelCount(alreadyAddedCandidate)) {
                    newCandidatesByURL.set(candidate.url, {
                        ...candidate,
                        visuallyBlurred: alreadyAddedCandidate.visuallyBlurred === false
                            ? false
                            : candidate.visuallyBlurred === true
                    });
                }
                return;
            }

            newCandidatesByURL.set(candidate.url, candidate);
        });

        return {
            newCandidates: Array.from(newCandidatesByURL.values()),
            existingCandidatesUpdated,
            existingCandidateUpgradeCount,
            updatedCandidateIds: Array.from(updatedCandidateIds)
        };
    }

    replaceVisibleResults(entries) {
        const nextImages = new Map(entries ?? []);
        const nextVisibleResultStates = new Map();
        const addedImageIds = new Set();
        const updatedImageIds = new Set();
        const removedImageIds = new Set();

        this.#images.forEach((_image, imageId) => {
            if (!nextImages.has(imageId)) removedImageIds.add(imageId);
        });
        nextImages.forEach((image, imageId) => {
            const nextState = this.#getVisibleResultState(image);
            const previousState = this.#visibleResultStates.get(imageId);

            if (!previousState) {
                addedImageIds.add(imageId);
            } else if (!this.#isSameVisibleResultState(previousState, nextState)) {
                updatedImageIds.add(imageId);
            }
            nextVisibleResultStates.set(imageId, nextState);
        });

        this.#images.clear();
        nextImages.forEach((candidate, candidateId) => {
            this.#images.set(candidateId, candidate);
        });
        this.#visibleResultStates = nextVisibleResultStates;

        return {addedImageIds, updatedImageIds, removedImageIds};
    }

    deleteResult(imageId) {
        const deletedFromImages = this.#images.delete(imageId);
        const deletedFromCandidates = this.#candidates.delete(imageId);

        this.#downloadStates.delete(imageId);
        this.#visibleResultStates.delete(imageId);
        return deletedFromImages || deletedFromCandidates;
    }

    setResultMarker(image, markerState) {
        const currentMarkerState = image?.markerState ?? 'normal';
        const currentPriority = RESULT_MARKER_PRIORITIES[currentMarkerState] ?? 0;
        const nextPriority = RESULT_MARKER_PRIORITIES[markerState] ?? 0;

        if (image && nextPriority >= currentPriority) image.markerState = markerState;
    }

    resolvePendingResultMarker([_candidateId, candidate], replacesExistingResult) {
        const pendingMarkerState = candidate?.pendingMarkerState;
        if (!pendingMarkerState) return;

        const markerState = pendingMarkerState === 'upgrade' || replacesExistingResult
            ? 'upgrade'
            : 'new';
        this.setResultMarker(candidate, markerState);
        delete candidate.pendingMarkerState;
    }

    getVisibleResultMarkerState(imageId, image, savedImageIds) {
        if (this.#downloadStates.get(imageId)?.completed === true || savedImageIds?.has(imageId)) {
            return 'downloaded';
        }

        return image?.markerState ?? 'normal';
    }

    getPixelCount(candidate) {
        const width = Number(candidate?.width);
        const height = Number(candidate?.height);

        return Number.isFinite(width) && Number.isFinite(height)
            ? Math.max(0, width) * Math.max(0, height)
            : 0;
    }

    // ✴️ NEW 2026-10-08: Stores only fields that change a rendered list entry.
    #getVisibleResultState(image) {
        return {
            fileName: image?.fileName ?? '',
            markerState: image?.markerState ?? 'normal',
            url: image?.url ?? ''
        };
    }

    // ✴️ NEW 2026-10-08: Prevents unchanged media entries from being rendered again.
    #isSameVisibleResultState(first, second) {
        return first.fileName === second.fileName &&
            first.markerState === second.markerState &&
            first.url === second.url;
    }

    trackDownload(imageId, downloadId) {
        if (!imageId || !Number.isInteger(downloadId)) return false;

        this.#downloadStates.set(imageId, {
            downloadId,
            state: 'in_progress',
            completed: false
        });
        return true;
    }

    getDownload(imageId) {
        return this.#downloadStates.get(imageId) ?? null;
    }

    getImageIdsForDownload(downloadId) {
        if (!Number.isInteger(downloadId)) return [];

        return Array.from(this.#downloadStates, ([imageId, download]) => ({imageId, download}))
            .filter(({download}) => download.downloadId === downloadId)
            .map(({imageId}) => imageId);
    }

    updateDownloadState(imageId, downloadId, state) {
        const download = this.#downloadStates.get(imageId);
        if (!download || download.downloadId !== downloadId) return null;

        const nextDownload = {
            ...download,
            state,
            completed: download.completed === true || state === 'complete'
        };
        this.#downloadStates.set(imageId, nextDownload);
        return nextDownload;
    }
}
