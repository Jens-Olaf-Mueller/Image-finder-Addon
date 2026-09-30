/**
 * Coordinates one hidden DeepScan run. Concrete document and container
 * traversal stay supplied by the caller so they can be extracted separately as
 * DocumentTraverser without changing this controller's planning semantics.
 */
export default class DeepScanController {
    #lifecycle;
    #collection;
    #traversal;
    #diagnostics;
    #deepScanPass = 0;
    #completedNaturally = false;
    #currentPassRecord = null;
    #deepScanMutationStart = null;

    constructor({lifecycle, collection, traversal, diagnostics} = {}) {
        this.#lifecycle = lifecycle;
        this.#collection = collection;
        this.#traversal = traversal;
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
            reportActiveScrollContainer,
            setDeepScanPass,
            isAborted
        } = this.#lifecycle;
        const {registerTargets, collectSources} = this.#collection;
        const {
            scanRelevantScrollContainers,
            scanDocumentDirection,
            waitForSettle,
            getDocumentTraversalState,
            synchronizeCompletedScrollContainerStates,
            getPendingRelevantContainerCandidates
        } = this.#traversal;
        const {
            createPerformanceMetrics,
            getMutationSnapshot,
            getMutationDelta,
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
            this.#deepScanMutationStart = getMutationSnapshot();
            await waitForReadiness();
            addMetric(null, 'readinessWaitMs', performance.now() - readinessStartedAt);

            registerTargets();
            const initialCollectionStartedAt = performance.now();
            await collectSources({context: {scope: 'initial'}});
            addMetric(null, 'initialCollectionMs', performance.now() - initialCollectionStartedAt);
            while (isActive()) {
                const pass = ++this.#deepScanPass;
                setDeepScanPass(pass);
                const passStartedAt = performance.now();
                const passMetrics = createPerformanceMetrics();
                passMetrics.mutationStart = getMutationSnapshot();
                this.#currentPassRecord = {
                    pass,
                    startedAt: passStartedAt,
                    startPosition: this.#lifecycle.getMetrics().scrollY,
                    endPosition: null,
                    durationMs: 0,
                    metrics: passMetrics,
                    repeatReason: 'aborted'
                };
                this.#diagnostics.addPassRecord(this.#currentPassRecord);
                const containersAtPassStart = getKnownScrollContainerCount();
                setCurrentPass(passMetrics, this.#currentPassRecord);
                console.info('[DeepScan PASS START]', `pass=${pass}`);
                const photoSwipeActivityAtPassStart = getPhotoSwipeActivityCount();
                await scanRelevantScrollContainers();
                if (!isActive()) break;

                await scanDocumentDirection('up');
                if (!isActive()) break;

                await scanDocumentDirection('down');
                if (!isActive()) break;

                const documentStateAfterDirections = getDocumentTraversalState();
                const mutationCountAfterDirections = this.#lifecycle.getRelevantMutationCount();
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
                const newCandidates = await collectSources({
                    metrics: passMetrics,
                    context: {scope: 'final-settle', pass}
                });
                addMetric(passMetrics, 'finalCollectionMs', performance.now() - finalCollectionStartedAt);
                const newTargets = registerTargets();
                addMetric(passMetrics, 'newTargets', newTargets);
                const documentStateAfterFinalSettle = getDocumentTraversalState();
                const mutationCountAfterFinalSettle = this.#lifecycle.getRelevantMutationCount();
                const documentChangedAfterDirections = documentStateAfterDirections !==
                    documentStateAfterFinalSettle;
                const mutationDetected = mutationCountAfterDirections !== mutationCountAfterFinalSettle;
                const candidatesDetected = newCandidates > 0;
                const targetsDetected = newTargets > 0;
                const photoSwipeActivityDetected = getPhotoSwipeActivityCount() !==
                    photoSwipeActivityAtPassStart;
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
                const containersDetected = pendingContainers.some(({container, isScrollable}) =>
                    isScrollable && completedScrollContainerStates.has(container)
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
                this.#currentPassRecord.endPosition = this.#lifecycle.getMetrics().scrollY;
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
                    console.info('[DeepScan PASS] complete');
                    this.#completedNaturally = true;
                    break;
                }

                console.info(
                    '[DeepScan PASS] repeat',
                    `pass=${pass}`,
                    `repeatReasons=${repeatReasons.join(',')}`,
                    `mutation=${mutationDetected}`,
                    `candidates=${candidatesDetected}`,
                    `targets=${targetsDetected}`,
                    `documentRange=${documentChangedAfterDirections}`,
                    `containers=${containersDetected}`,
                    `newContainers=${newContainersDetected}`,
                    `photoSwipeActivity=${photoSwipeActivityDetected}`
                );
            }
        } finally {
            stopMutationObservation();
            finalizeCurrentPass(this.#currentPassRecord, isAborted() ? 'aborted' : 'interrupted');
            clearCurrentPass();
            this.#currentPassRecord = null;
            reportActiveScrollContainer();
        }

        const status = isAborted() ? 'cancelled' : 'completed';
        if (status === 'completed' && this.#completedNaturally) {
            const mutations = getMutationDelta(this.#deepScanMutationStart ?? getMutationSnapshot());
            console.info(
                '[DeepScan END] status=completed',
                `mutations=${mutations.total}`,
                `mutationChildList=${mutations.childList}`,
                `mutationAttributes=${mutations.attributes}`,
                `mutationAddedElements=${mutations.addedElements}`,
                `mutationRemovedElements=${mutations.removedElements}`,
                `relevantMutations=${mutations.relevantTotal}`,
                'styleClassObserved=false'
            );
        } else if (status === 'cancelled') {
            const mutations = getMutationDelta(this.#deepScanMutationStart ?? getMutationSnapshot());
            console.info(
                '[DeepScan END] status=cancelled',
                `mutations=${mutations.total}`,
                `mutationChildList=${mutations.childList}`,
                `mutationAttributes=${mutations.attributes}`,
                `mutationAddedElements=${mutations.addedElements}`,
                `mutationRemovedElements=${mutations.removedElements}`,
                `relevantMutations=${mutations.relevantTotal}`,
                'styleClassObserved=false'
            );
        }

        const performanceSummary = createPerformanceSummary(status);
        console.info('[DeepScan Performance Hidden]', performanceSummary);

        return {
            status,
            endReason: status === 'cancelled' ? 'aborted' : 'stable',
            performance: performanceSummary
        };
    }
}