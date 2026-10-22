/**
 * Scans direct PhotoSwipe targets and traverses their PhotoSwipe sessions.
 * Shared DOM and PhotoSwipe helpers remain caller-owned because the generic
 * CarouselScanner uses the same operations for its optional enrichment path.
 */
export default class PhotoSwipeScanner {
    #processedTargets;
    #processedTargetSources;
    #fallbackTraversedPhotoSwipes;

    constructor({processedTargets = new WeakSet(), processedTargetSources = new Set()} = {}) {
        this.#processedTargets = processedTargets;
        this.#processedTargetSources = processedTargetSources;
        this.#fallbackTraversedPhotoSwipes = new WeakSet();
    }

    reset() {
        this.#processedTargets = new WeakSet();
        this.#processedTargetSources = new Set();
        this.#fallbackTraversedPhotoSwipes = new WeakSet();
    }

    getCarouselContext() {
        return {
            processedTargets: this.#processedTargets,
            processedTargetSources: this.#processedTargetSources
        };
    }

    async scan({
        document: scanDocument,
        queryDeep,
        findOpenPhotoSwipe,
        getActiveSlideImage,
        getReadyActiveSlideImage,
        collectPhotoSwipeCandidates,
        getImageSnapshot,
        didZoomStateChange,
        imageDimensions,
        isAborted,
        waitFor,
        createTemporaryStyle,
        closePhotoSwipe,
        getTargetSourceKey,
        getCarouselStateLabel,
        reportActivity,
        reportCarousel,
        reportZoom,
        collectPerformance,
        performanceDetail,
        performanceState,
        getPhaseStartedAt,
        recordPhase,
        recordQuery,
        addCandidates,
        getCandidateCount,
        traverseCarousel,
        skipDirectZoom = false,
        fallbackToOpenCarouselOnCloseFailure = false,
        shouldSkipDirectTarget = null,
        allowRecycledDirectTargets = false,
        scanRoots = [scanDocument],
        registerDirectTarget = null
    } = {}) {
        let directPhotoSwipeMs = 0;
        let directPhotoSwipeCalls = 0;
        const effectiveScanRoots = Array.isArray(scanRoots) && scanRoots.length > 0
            ? scanRoots
            : [scanDocument];
        const recordDirectCandidates = (stage, candidates) => {
            if (!collectPerformance) return;

            const prefix = stage === 'zoom' ? 'zoom' : 'initial';
            performanceDetail.direct[`${prefix}CandidateCount`] += candidates.length;
            candidates.forEach((candidate) => {
                performanceDetail.direct[`${prefix}MaxWidth`] = Math.max(
                    performanceDetail.direct[`${prefix}MaxWidth`],
                    candidate.width ?? 0
                );
                performanceDetail.direct[`${prefix}MaxHeight`] = Math.max(
                    performanceDetail.direct[`${prefix}MaxHeight`],
                    candidate.height ?? 0
                );
            });
        };
        const isVisibleMediaTarget = (target) => {
            const phaseStartedAt = getPhaseStartedAt();
            const imageQueryStartedAt = getPhaseStartedAt();
            const image = target?.querySelector('img') ?? null;
            recordQuery('img', Number(Boolean(image)));
            recordPhase('domQueriesMs', imageQueryStartedAt);
            if (!image) {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return false;
            }

            try {
                const style = getComputedStyle(target);
                const rect = target.getBoundingClientRect();
                const visible = style.display !== 'none' && style.visibility !== 'hidden' &&
                    style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return visible;
            } catch {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return false;
            }
        };
        const getSlideStateIdentity = (readySlide) => {
            const {slide, image} = readySlide ?? {};
            const getAttributeValue = (element, attributeName) => {
                const value = element?.getAttribute?.(attributeName)?.trim();
                return value || null;
            };
            const index = [
                'data-pswp-index',
                'data-slide-index',
                'data-index',
                'aria-posinset'
            ].map((attributeName) => getAttributeValue(slide, attributeName) ??
                getAttributeValue(image, attributeName)).find(Boolean);
            const label = getAttributeValue(slide, 'aria-label') ??
                getAttributeValue(image, 'aria-label');
            const snapshot = getImageSnapshot(image);
            const source = snapshot.currentSrc ?? snapshot.src;
            const identityParts = [
                index ? 'index:' + index : null,
                label ? 'label:' + label : null,
                source ? 'source:' + source : null
            ].filter(Boolean);

            return identityParts.length > 0 ? identityParts.join('|') : null;
        };
        const getCanonicalCarouselStateKey = (carousel, key) => {
            const visited = new Set();
            let canonicalKey = key;

            while (carousel.stateAliases.has(canonicalKey) && !visited.has(canonicalKey)) {
                visited.add(canonicalKey);
                canonicalKey = carousel.stateAliases.get(canonicalKey);
            }
            return canonicalKey;
        };
        const getCarouselState = (photoSwipe, carousel) => {
            const readySlide = getReadyActiveSlideImage(photoSwipe);
            const rawKey = getSlideStateIdentity(readySlide);
            if (!readySlide || !rawKey) return null;

            return {
                readySlide,
                rawKey,
                key: getCanonicalCarouselStateKey(carousel, rawKey)
            };
        };
        const isCarouselControlUsable = (control) => {
            const phaseStartedAt = getPhaseStartedAt();
            if (!control || !control.isConnected ||
                control.hasAttribute?.('disabled') ||
                control.getAttribute?.('aria-disabled') === 'true' ||
                control.hasAttribute?.('hidden') ||
                /(?:^|\s)disabled(?:\s|$)/i.test(control.className ?? '')) {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return false;
            }

            try {
                const usable = getComputedStyle(control).display !== 'none';
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return usable;
            } catch {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return false;
            }
        };
        const getCarouselControl = (photoSwipe, direction) => {
            const phaseStartedAt = getPhaseStartedAt();
            const explicitSelector = direction === 'forward'
                ? [
                    '.pswp__button--arrow--next',
                    '[data-pswp-next]',
                    '[data-pswp-action="next"]',
                    '[data-carousel-next]',
                    '[data-slide-next]',
                    '[rel~="next"]'
                ]
                : [
                    '.pswp__button--arrow--prev',
                    '.pswp__button--arrow--previous',
                    '[data-pswp-prev]',
                    '[data-pswp-previous]',
                    '[data-pswp-action="prev"]',
                    '[data-pswp-action="previous"]',
                    '[data-carousel-prev]',
                    '[data-carousel-previous]',
                    '[data-slide-prev]',
                    '[data-slide-previous]',
                    '[rel~="prev"]'
                ];
            const semanticPattern = direction === 'forward'
                ? /\b(?:next|forward)\b/i
                : /\b(?:previous|prev|back)\b/i;
            const explicitControl = explicitSelector.map((selector) => {
                const queryStartedAt = getPhaseStartedAt();
                const control = photoSwipe.querySelector(selector);
                recordQuery(selector, Number(Boolean(control)));
                recordPhase('domQueriesMs', queryStartedAt);
                return control;
            }).find(isCarouselControlUsable);
            if (explicitControl) {
                recordPhase('candidateClassificationMs', phaseStartedAt);
                return explicitControl;
            }

            const queryStartedAt = getPhaseStartedAt();
            const controls = Array.from(photoSwipe.querySelectorAll('button, [role="button"], a'));
            recordQuery('button, [role="button"], a', controls.length);
            recordPhase('domQueriesMs', queryStartedAt);
            const semanticControl = controls.find(
                (control) => isCarouselControlUsable(control) && semanticPattern.test([
                    control.getAttribute('aria-label'),
                    control.getAttribute('title'),
                    control.textContent
                ].filter(Boolean).join(' '))
            ) ?? null;
            recordPhase('candidateClassificationMs', phaseStartedAt);
            return semanticControl;
        };
        const collectCarouselSources = (photoSwipe, carousel, stateLabel) => {
            const phaseStartedAt = getPhaseStartedAt();
            const availableCandidates = collectPhotoSwipeCandidates(photoSwipe, {
                includePreloaded: true
            });
            const sourceURLs = new Set(availableCandidates.map((candidate) => candidate.url));
            let newSources = 0;

            sourceURLs.forEach((url) => {
                if (!carousel.knownSources.has(url)) {
                    carousel.knownSources.add(url);
                    newSources += 1;
                }
                this.#processedTargetSources.add(url);
            });
            addCandidates(...availableCandidates);
            reportCarousel(
                'CAROUSEL',
                'state=' + stateLabel,
                'preloadSources=' + sourceURLs.size,
                'preloadNew=' + newSources
            );
            recordPhase('dedupeResultHandlingMs', phaseStartedAt);
            return newSources;
        };
        const processCarouselState = async (photoSwipe, carousel, state, direction) => {
            const stateLabel = getCarouselStateLabel(carousel, state.key);
            const alreadyVisited = carousel.visitedStates.has(state.key);

            reportCarousel(
                'CAROUSEL',
                'type=' + carousel.type,
                'state=' + stateLabel,
                'direction=' + direction,
                'source=' + (alreadyVisited ? 'known' : 'new')
            );

            const sourcesBeforeZoom = collectCarouselSources(photoSwipe, carousel, stateLabel);
            if (alreadyVisited) return {alreadyVisited, newSources: sourcesBeforeZoom};

            carousel.visitedStates.add(state.key);
            const beforeZoom = getImageSnapshot(state.readySlide.image);
            try {
                state.readySlide.image.click();
                reportActivity();
            } catch {
                if (!isAborted()) reportZoom(imageDimensions(beforeZoom) + ' no-upgrade');
                return {alreadyVisited: false, newSources: sourcesBeforeZoom};
            }

            const zoomedSlide = await waitFor(() => {
                const activeSlide = getReadyActiveSlideImage(photoSwipe);
                if (!activeSlide) return null;

                const afterZoom = getImageSnapshot(activeSlide.image);
                return didZoomStateChange(beforeZoom, afterZoom, activeSlide.photoSwipe)
                    ? {activeSlide, afterZoom}
                    : null;
            }, 150, 'direct-carousel-zoom');
            if (isAborted()) return {alreadyVisited: false, newSources: sourcesBeforeZoom};
            if (!zoomedSlide) {
                reportZoom(imageDimensions(beforeZoom) + ' no-upgrade');
                return {alreadyVisited: false, newSources: sourcesBeforeZoom};
            }

            const afterState = getCarouselState(photoSwipe, carousel);
            if (afterState && afterState.rawKey !== state.rawKey) {
                carousel.stateAliases.set(afterState.rawKey, state.key);
            }
            const sourcesAfterZoom = collectCarouselSources(photoSwipe, carousel, stateLabel);
            const afterZoom = zoomedSlide.afterZoom;
            const resolutionImproved = afterZoom.naturalWidth > beforeZoom.naturalWidth ||
                afterZoom.naturalHeight > beforeZoom.naturalHeight;
            reportZoom(resolutionImproved
                ? imageDimensions(beforeZoom) + ' -> ' + imageDimensions(afterZoom) + ' replaced'
                : imageDimensions(beforeZoom) + ' no-upgrade');

            return {
                alreadyVisited: false,
                newSources: sourcesBeforeZoom + sourcesAfterZoom
            };
        };
        const traversePhotoSwipeCarousel = async (photoSwipe) => {
            const carousel = {
                type: 'unknown',
                knownSources: new Set(),
                stateAliases: new Map(),
                stateLabels: new Map(),
                visitedStates: new Set(),
                transitions: {
                    forward: new Set(),
                    backward: new Set()
                }
            };
            const visitedStateCount = () => carousel.visitedStates.size;
            const initialState = await waitFor(
                () => getCarouselState(photoSwipe, carousel),
                3000,
                'direct-carousel-initial-state'
            );
            if (!initialState || isAborted()) return visitedStateCount();

            const initialStateLabel = getCarouselStateLabel(carousel, initialState.key);
            reportCarousel(
                'CAROUSEL',
                'discovered',
                'type=unknown',
                'state=' + initialStateLabel
            );
            await processCarouselState(photoSwipe, carousel, initialState, 'initial');
            if (isAborted()) return visitedStateCount();

            const traverseDirection = async (direction) => {
                let successfulTransitions = 0;

                while (!isAborted()) {
                    const beforeState = await waitFor(
                        () => getCarouselState(photoSwipe, carousel),
                        1000,
                        'direct-carousel-before-state'
                    );
                    if (!beforeState) {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'direction=' + direction,
                            'reason=active-slide-unavailable'
                        );
                        return {kind: 'edge', reason: 'active-slide-unavailable'};
                    }

                    const control = getCarouselControl(photoSwipe, direction);
                    if (!control) {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'direction=' + direction,
                            'reason=control-unavailable'
                        );
                        return {kind: 'edge', reason: 'control-unavailable'};
                    }

                    try {
                        control.click();
                        reportActivity();
                    } catch {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'direction=' + direction,
                            'reason=control-action-failed'
                        );
                        return {kind: 'edge', reason: 'control-action-failed'};
                    }

                    const nextState = await waitFor(() => {
                        const state = getCarouselState(photoSwipe, carousel);
                        return state && state.key !== beforeState.key ? state : null;
                    }, 3000, 'direct-carousel-next-state');
                    if (isAborted()) return {kind: 'aborted'};
                    if (!nextState) {
                        const stableControl = getCarouselControl(photoSwipe, direction);
                        const reason = stableControl ? 'stable-state' : 'control-unavailable';
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'direction=' + direction,
                            'reason=' + reason
                        );
                        return {kind: 'edge', reason};
                    }

                    successfulTransitions += 1;
                    const transitionKey = beforeState.key + '→' + nextState.key;
                    const knownState = carousel.visitedStates.has(nextState.key);
                    const repeatedTransition = carousel.transitions[direction].has(transitionKey);
                    carousel.transitions[direction].add(transitionKey);
                    const stateResult = await processCarouselState(
                        photoSwipe,
                        carousel,
                        nextState,
                        direction
                    );
                    if (isAborted()) return {kind: 'aborted'};

                    if (direction === 'forward' && knownState &&
                        successfulTransitions > 0 && stateResult.newSources === 0) {
                        carousel.type = 'cyclic';
                        reportCarousel(
                            'CAROUSEL END',
                            'type=cyclic',
                            'reason=cycle-complete',
                            'states=' + carousel.visitedStates.size
                        );
                        return {kind: 'cycle', reason: 'cycle-complete'};
                    }

                    if (repeatedTransition && knownState && stateResult.newSources === 0) {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'direction=' + direction,
                            'reason=known-transition'
                        );
                        return {kind: 'edge', reason: 'known-transition'};
                    }
                }

                return {kind: 'aborted'};
            };

            const forward = await traverseDirection('forward');
            if (forward.kind === 'aborted' || forward.kind === 'cycle') return visitedStateCount();

            const backward = await traverseDirection('backward');
            if (backward.kind !== 'edge' || isAborted()) return visitedStateCount();

            carousel.type = 'finite';
            reportCarousel(
                'CAROUSEL END',
                'type=finite',
                'reason=both-edges-exhausted',
                'forward=' + forward.reason,
                'backward=' + backward.reason,
                'states=' + carousel.visitedStates.size
            );
            return visitedStateCount();
        };

        const directDiscoveryStartedAt = getPhaseStartedAt();
        const targets = [];
        const seenTargets = new Set();
        effectiveScanRoots.forEach((root) => {
            queryDeep(root, '[at-attr="media_locator"]').forEach((target) => {
                if (seenTargets.has(target)) return;
                seenTargets.add(target);
                targets.push(target);
            });
        });
        if (collectPerformance) performanceDetail.direct.targetCount = targets.length;
        recordPhase('directPhotoSwipeDiscoveryMs', directDiscoveryStartedAt);
        for (const target of targets) {
            const targetIterationStartedAt = getPhaseStartedAt();
            const candidateStartedAt = getPhaseStartedAt();
            const finishTargetIteration = () => recordPhase(
                'candidateIterationMs',
                targetIterationStartedAt
            );
            if (collectPerformance) {
                if (performanceState?.directTargets?.has(target)) {
                    performanceDetail.direct.previouslySeenTargets += 1;
                } else {
                    performanceDetail.direct.newTargets += 1;
                    performanceState?.directTargets?.add(target);
                }
            }
            if (shouldSkipDirectTarget?.(target) === true) {
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            registerDirectTarget?.(target);
            const targetSource = getTargetSourceKey(target);
            if (isAborted()) {
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            if (!allowRecycledDirectTargets && this.#processedTargets.has(target)) {
                if (collectPerformance) performanceDetail.direct.processedTargetsSkipped += 1;
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            if (targetSource && this.#processedTargetSources.has(targetSource)) {
                if (collectPerformance) performanceDetail.direct.sourceDuplicatesSkipped += 1;
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            if (!isVisibleMediaTarget(target)) {
                if (collectPerformance) performanceDetail.direct.invisibleTargetsSkipped += 1;
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            if (collectPerformance) performanceDetail.direct.openModalChecks += 1;
            if (findOpenPhotoSwipe()) {
                if (fallbackToOpenCarouselOnCloseFailure) {
                    const recovered = await closePhotoSwipe('direct-photo-swipe-recovery');
                    if (recovered && !findOpenPhotoSwipe()) {
                        // The previously stuck modal recovered. Process this target normally.
                    } else {
                        // A PhotoSwipe overlay is global to the page. Do not keep skipping every
                        // following target in this collection; the OF swiper will advance and the
                        // next state gets one bounded recovery attempt of its own.
                        recordPhase('candidateClassificationMs', candidateStartedAt);
                        finishTargetIteration();
                        break;
                    }
                } else {
                    if (collectPerformance) performanceDetail.direct.openModalSkips += 1;
                    recordPhase('candidateClassificationMs', candidateStartedAt);
                    finishTargetIteration();
                    continue;
                }
            }
            if (findOpenPhotoSwipe()) {
                if (collectPerformance) performanceDetail.direct.openModalSkips += 1;
                recordPhase('candidateClassificationMs', candidateStartedAt);
                finishTargetIteration();
                continue;
            }
            recordPhase('candidateClassificationMs', candidateStartedAt);
            finishTargetIteration();
            this.#processedTargets.add(target);
            if (targetSource) this.#processedTargetSources.add(targetSource);

            const photoSwipeStartedAt = performance.now();
            const directCandidatesBefore = getCandidateCount();
            directPhotoSwipeCalls += 1;
            let temporaryStyle = null;
            try {
                temporaryStyle = createTemporaryStyle();
                target.click();

                const photoSwipe = await waitFor(
                    findOpenPhotoSwipe,
                    2000,
                    'direct-photo-swipe-open'
                );
                if (isAborted()) break;
                if (!photoSwipe) {
                    if (collectPerformance) performanceDetail.direct.openTimeouts += 1;
                    continue;
                }
                if (collectPerformance) performanceDetail.direct.openSuccesses += 1;

                reportActivity();
                if (traverseCarousel) {
                    await traversePhotoSwipeCarousel(photoSwipe);
                    continue;
                }

                // OF may assign the PhotoSwipe source before its image is fully decoded. Keep
                // that source first, then let the ready wait upgrade it with real dimensions.
                const initialSourceSlide = getActiveSlideImage(findOpenPhotoSwipe());
                if (initialSourceSlide) {
                    const sourceCandidates = collectPhotoSwipeCandidates(
                        initialSourceSlide.photoSwipe
                    );
                    recordDirectCandidates('initial', sourceCandidates);
                    addCandidates(...sourceCandidates);
                }

                const readySlide = await waitFor(
                    () => getReadyActiveSlideImage(findOpenPhotoSwipe()),
                    6000,
                    'direct-photo-swipe-ready'
                );
                if (isAborted()) break;
                if (!readySlide) {
                    // The ready check can lose a race against OF's delayed decode. The active
                    // image still carries the page-selected URL, so keep it instead of marking
                    // this target as permanently empty.
                    const lateSourceSlide = getActiveSlideImage(findOpenPhotoSwipe());
                    if (lateSourceSlide) {
                        const sourceCandidates = collectPhotoSwipeCandidates(
                            lateSourceSlide.photoSwipe
                        );
                        recordDirectCandidates('initial', sourceCandidates);
                        addCandidates(...sourceCandidates);
                    }
                    if (collectPerformance) performanceDetail.direct.readySlideTimeouts += 1;
                    continue;
                }
                if (collectPerformance) performanceDetail.direct.readySlides += 1;

                const initialCandidates = collectPhotoSwipeCandidates(readySlide.photoSwipe);
                recordDirectCandidates('initial', initialCandidates);
                addCandidates(...initialCandidates);
                if (skipDirectZoom) continue;
                const beforeZoom = getImageSnapshot(readySlide.image);
                if (collectPerformance) performanceDetail.direct.zoomAttempts += 1;
                try {
                    readySlide.image.click();
                    reportActivity();
                } catch {
                    if (collectPerformance) performanceDetail.direct.zoomClickFailures += 1;
                    if (!isAborted()) reportZoom(imageDimensions(beforeZoom) + ' no-upgrade');
                    continue;
                }

                const zoomedSlide = await waitFor(() => {
                    const activeSlide = getReadyActiveSlideImage(findOpenPhotoSwipe());
                    if (!activeSlide) return null;

                    const afterZoom = getImageSnapshot(activeSlide.image);
                    return didZoomStateChange(beforeZoom, afterZoom, activeSlide.photoSwipe)
                        ? {activeSlide, afterZoom}
                        : null;
                }, 3000, 'direct-photo-swipe-zoom');
                if (isAborted()) break;
                if (!zoomedSlide) {
                    if (collectPerformance) performanceDetail.direct.zoomTimeouts += 1;
                    reportZoom(imageDimensions(beforeZoom) + ' no-upgrade');
                    continue;
                }

                if (collectPerformance) performanceDetail.direct.zoomStateChanges += 1;
                const zoomCandidates = collectPhotoSwipeCandidates(zoomedSlide.activeSlide.photoSwipe);
                recordDirectCandidates('zoom', zoomCandidates);
                addCandidates(...zoomCandidates);
                const afterZoom = zoomedSlide.afterZoom;
                const resolutionImproved = afterZoom.naturalWidth > beforeZoom.naturalWidth ||
                    afterZoom.naturalHeight > beforeZoom.naturalHeight;
                if (resolutionImproved && collectPerformance) {
                    performanceDetail.direct.resolutionUpgrades += 1;
                }
                reportZoom(resolutionImproved
                    ? imageDimensions(beforeZoom) + ' -> ' + imageDimensions(afterZoom) + ' replaced'
                    : imageDimensions(beforeZoom) + ' no-upgrade');
            } catch {
                // One page-owned PhotoSwipe target must not stop the remaining DeepScan.
            } finally {
                try {
                    let closed = await closePhotoSwipe('direct-photo-swipe');
                    if (!closed && findOpenPhotoSwipe()) {
                        closed = await closePhotoSwipe('direct-photo-swipe');
                    }
                    const openPhotoSwipe = findOpenPhotoSwipe();
                    if (!closed && fallbackToOpenCarouselOnCloseFailure && openPhotoSwipe &&
                        !this.#fallbackTraversedPhotoSwipes.has(openPhotoSwipe)) {
                        // OF's virtual swiper has already exposed the current slide. If its
                        // PhotoSwipe refuses to close, use that still-open PhotoSwipe once to
                        // collect the remaining slides instead of losing the whole carousel.
                        this.#fallbackTraversedPhotoSwipes.add(openPhotoSwipe);
                        if (collectPerformance) performanceDetail.direct.closeFallbacks += 1;
                        const fallbackCarouselStates = await traversePhotoSwipeCarousel(openPhotoSwipe);
                        if (collectPerformance) {
                            performanceDetail.direct.fallbackCarouselStates +=
                                fallbackCarouselStates;
                        }
                        if (!isAborted()) {
                            closed = await closePhotoSwipe('direct-photo-swipe-fallback');
                        }
                        if (collectPerformance) {
                            const stillOpen = findOpenPhotoSwipe() !== null;
                            performanceDetail.direct[stillOpen
                                ? 'fallbackStillOpen'
                                : 'fallbackClosed'] += 1;
                        }
                    }
                } finally {
                    temporaryStyle?.remove();
                    directPhotoSwipeMs += performance.now() - photoSwipeStartedAt;
                    if (collectPerformance) {
                        performanceDetail.direct.resultCount += Math.max(
                            0,
                            getCandidateCount() - directCandidatesBefore
                        );
                    }
                }
            }
        }

        return {directPhotoSwipeMs, directPhotoSwipeCalls};
    }
}
