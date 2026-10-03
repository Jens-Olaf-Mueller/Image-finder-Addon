/**
 * Coordinates one hidden DeepScan run. It owns pass planning and delegates
 * document traversal to DocumentTraverser while container traversal remains
 * supplied by the caller.
 */
export default class DeepScanController {
    #lifecycle;
    #collection;
    #traversal;
    #documentTraverser;
    #diagnostics;
    #deepScanPass = 0;
    #currentPassRecord = null;

    constructor({lifecycle, collection, traversal, documentTraverser, diagnostics} = {}) {
        this.#lifecycle = lifecycle;
        this.#collection = collection;
        this.#traversal = traversal;
        this.#documentTraverser = documentTraverser;
        this.#diagnostics = diagnostics;
    }

    async run() {
        const {
            isActive,
            startMutationObservation,
            stopMutationObservation,
            waitForReadiness,
            getPhotoSwipeActivityCount,
            getKnownScrollContainerCount,
            getCompletedScrollContainerStates,
            getHandledStructureContainers,
            isAborted
        } = this.#lifecycle;
        const {registerTargets, collectSources} = this.#collection;
        const {
            scanRelevantScrollContainers,
            waitForSettle,
            synchronizeCompletedScrollContainerStates,
            getPendingRelevantContainerCandidates
        } = this.#traversal;
        const {
            createPerformanceMetrics,
            addMetric,
            setCurrentPass,
            clearCurrentPass,
            finalizeCurrentPass,
            logPassSummary,
            createPerformanceSummary
        } = this.#diagnostics;

        try {
            startMutationObservation();

            const readinessStartedAt = performance.now();
            await waitForReadiness();
            addMetric(null, 'readinessWaitMs', performance.now() - readinessStartedAt);

            registerTargets();
            const initialCollectionStartedAt = performance.now();
            await collectSources();
            addMetric(null, 'initialCollectionMs', performance.now() - initialCollectionStartedAt);
            while (isActive()) {
                const pass = ++this.#deepScanPass;
                const passStartedAt = performance.now();
                const passMetrics = createPerformanceMetrics();
                this.#currentPassRecord = {
                    pass,
                    startedAt: passStartedAt,
                    startPosition: this.#documentTraverser.getMetrics().scrollY,
                    endPosition: null,
                    durationMs: 0,
                    metrics: passMetrics,
                    repeatReason: 'aborted'
                };
                this.#diagnostics.addPassRecord(this.#currentPassRecord);
                const containersAtPassStart = getKnownScrollContainerCount();
                setCurrentPass(passMetrics, this.#currentPassRecord);
                await scanRelevantScrollContainers();
                if (!isActive()) break;

                await this.#documentTraverser.traverse('up', {metrics: passMetrics});
                if (!isActive()) break;

                await this.#documentTraverser.traverse('down', {metrics: passMetrics});
                if (!isActive()) break;

                const documentStateAfterDirections = this.#documentTraverser.getTraversalState();
                await scanRelevantScrollContainers();
                if (!isActive()) break;

                const finalSettleStartedAt = performance.now();
                if (!(await waitForSettle({
                    minimumMs: 400,
                    scope: 'final',
                    phase: 'final'
                }))) {
                    addMetric(passMetrics, 'settleMs', performance.now() - finalSettleStartedAt);
                    addMetric(passMetrics, 'finalSettleMs', performance.now() - finalSettleStartedAt);
                    break;
                }
                const finalSettleMs = performance.now() - finalSettleStartedAt;
                addMetric(passMetrics, 'settleMs', finalSettleMs);
                addMetric(passMetrics, 'finalSettleMs', finalSettleMs);

                const photoSwipeActivityBeforeFinalCollection = getPhotoSwipeActivityCount();
                const finalCollectionStartedAt = performance.now();
                await collectSources({metrics: passMetrics});
                addMetric(passMetrics, 'finalCollectionMs', performance.now() - finalCollectionStartedAt);
                const newTargets = registerTargets();
                addMetric(passMetrics, 'newTargets', newTargets);
                const documentStateAfterFinalSettle = this.#documentTraverser.getTraversalState();
                const documentChangedAfterDirections = documentStateAfterDirections !==
                    documentStateAfterFinalSettle;
                const photoSwipeActivityDuringFinalCollection = getPhotoSwipeActivityCount() !==
                    photoSwipeActivityBeforeFinalCollection;

                // Opening and closing PhotoSwipe changes page-owned DOM. Its candidates have already
                // been collected above, so treat that temporary DOM as the current baseline instead
                // of scheduling a complete traversal of unchanged containers.
                if (photoSwipeActivityDuringFinalCollection) {
                    synchronizeCompletedScrollContainerStates();
                }

                const pendingContainers = getPendingRelevantContainerCandidates();
                const completedScrollContainerStates = getCompletedScrollContainerStates();
                const handledStructureContainers = getHandledStructureContainers();
                const newContainersDetected = pendingContainers.some(({container, isScrollable}) =>
                    isScrollable
                        ? !completedScrollContainerStates.has(container)
                        : !handledStructureContainers.has(container)
                );
                // Discovery work has already been collected and sent to the client. Repeat traversal
                // only when the reachable document range changed or a container range is unfinished.
                const repeatPass = documentChangedAfterDirections || pendingContainers.length > 0;
                const repeatReasons = [];
                if (documentChangedAfterDirections) repeatReasons.push('document-scroll-range-changed');
                if (pendingContainers.length > 0) repeatReasons.push('container-still-open');
                if (newContainersDetected) repeatReasons.push('new-container-discovered');
                const repeatReason = documentChangedAfterDirections && pendingContainers.length > 0
                    ? 'both'
                    : documentChangedAfterDirections
                        ? 'document-changed'
                        : pendingContainers.length > 0
                            ? 'container-pending'
                            : 'none';
                this.#currentPassRecord.endPosition = this.#documentTraverser.getMetrics().scrollY;
                this.#currentPassRecord.durationMs = performance.now() - passStartedAt;
                this.#currentPassRecord.repeatReason = repeatReason;

                logPassSummary(
                    pass,
                    passMetrics,
                    performance.now() - passStartedAt,
                    repeatPass,
                    repeatReasons,
                    Math.max(0, getKnownScrollContainerCount() - containersAtPassStart)
                );
                clearCurrentPass();
                this.#currentPassRecord = null;

                if (!repeatPass) {
                    break;
                }
            }
        } finally {
            stopMutationObservation();
            finalizeCurrentPass(this.#currentPassRecord, isAborted() ? 'aborted' : 'interrupted');
            clearCurrentPass();
            this.#currentPassRecord = null;
        }

        const status = isAborted() ? 'cancelled' : 'completed';
        const performanceSummary = createPerformanceSummary(status);
        console.info('[DeepScan Performance Hidden]', performanceSummary);

        return {
            status,
            endReason: status === 'cancelled' ? 'aborted' : 'stable',
            performance: performanceSummary
        };
    }
}
