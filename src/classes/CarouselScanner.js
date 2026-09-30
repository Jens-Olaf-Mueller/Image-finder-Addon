/**
 * Traverses generic DOM carousels while keeping the PhotoSwipe-specific
 * operations supplied by the caller. The scanner intentionally retains the
 * current global discovery and processed-root behaviour; cache invalidation is
 * a separate follow-up.
 */
export default class CarouselScanner {
    #processedCarouselRoots;

    constructor({processedCarouselRoots = new WeakSet()} = {}) {
        this.#processedCarouselRoots = processedCarouselRoots;
    }

    reset() {
        this.#processedCarouselRoots = new WeakSet();
    }

    async scan({
        document: scanDocument,
        queryDeep,
        getURL,
        getSrcsetURLs,
        waitFor,
        isAborted,
        reportCarousel,
        reportActivity,
        findOpenPhotoSwipe,
        getReadyActiveSlideImage,
        collectPhotoSwipeCandidates,
        getImageSnapshot,
        didZoomStateChange,
        createTemporaryStyle,
        closePhotoSwipe,
        getTargetSourceKey,
        processedTargets,
        processedTargetSources,
        collectPerformance,
        performanceDetail,
        performanceState,
        getPhaseStartedAt,
        recordPhase,
        addCandidates,
        getCarouselStateLabel
    } = {}) {
        const genericSourceAttributes = [
            'src',
            'srcset',
            'data-src',
            'data-srcset',
            'data-lazy-src',
            'data-lazy-srcset',
            'data-original',
            'data-original-src'
        ];
        const genericGalleryTokens = /(?:carousel|gallery|slider|swiper)/i;
        const genericSlideTokens = /(?:slide|item|media)/i;
        const genericGalleryKeys = new WeakMap();
        let genericGallerySequence = 0;
        let genericCarouselMs = 0;
        let genericCarouselCalls = 0;
        const getGenericGalleryKey = (root) => {
            if (genericGalleryKeys.has(root)) return genericGalleryKeys.get(root);

            const explicitKey = root.getAttribute?.('data-carousel-id')?.trim() ||
                root.getAttribute?.('data-gallery-id')?.trim() || root.id?.trim();
            const key = explicitKey ? 'gallery#' + explicitKey : 'gallery#?' + genericGallerySequence++;
            genericGalleryKeys.set(root, key);
            return key;
        };
        const getElementClassText = (element) => typeof element?.className === 'string'
            ? element.className
            : element?.getAttribute?.('class') ?? '';
        const getGenericElementSources = (element) => {
            if (!element?.getAttribute) return [];

            const sources = [];
            if (element instanceof HTMLImageElement) {
                sources.push(getURL(element.currentSrc, element.baseURI));
            }
            genericSourceAttributes.forEach((attributeName) => {
                const value = element.getAttribute(attributeName);
                if (!value) return;

                if (attributeName.endsWith('srcset')) {
                    sources.push(...getSrcsetURLs(value, element.baseURI));
                } else {
                    sources.push(getURL(value, element.baseURI));
                }
            });
            return sources.filter(Boolean);
        };
        const getGenericGalleryMediaElements = (root) => {
            const selector = [
                'img',
                'source',
                '[src]',
                '[srcset]',
                '[data-src]',
                '[data-srcset]',
                '[data-lazy-src]',
                '[data-lazy-srcset]',
                '[data-original]',
                '[data-original-src]'
            ].join(',');
            const elements = root.matches?.(selector) ? [root] : [];
            return [...elements, ...queryDeep(root, selector)].filter(
                (element, index, values) => values.indexOf(element) === index
            );
        };
        const getGenericSlideElements = (root) => {
            const phaseStartedAt = getPhaseStartedAt();
            const selector = [
                '[data-swiper-slide-index]',
                '[data-slide-index]',
                '[data-index]',
                '[aria-posinset]',
                '[aria-current]',
                '[aria-selected]',
                '[data-active]',
                '[role="group"]',
                '[class*="slide"]',
                '[class*="item"]'
            ].join(',');

            const slides = queryDeep(root, selector).filter((element) => genericSlideTokens.test([
                getElementClassText(element),
                element.getAttribute?.('role'),
                element.getAttribute?.('data-slide-index'),
                element.getAttribute?.('data-swiper-slide-index')
            ].filter(Boolean).join(' ')) && getGenericGalleryMediaElements(element).length > 0);
            recordPhase('candidateClassificationMs', phaseStartedAt);
            return slides;
        };
        const getGenericControlDirection = (element) => {
            const rel = element.getAttribute?.('rel')?.toLowerCase().split(/\s+/) ?? [];
            if (rel.includes('next')) return 'forward';
            if (rel.includes('prev') || rel.includes('previous')) return 'backward';

            const label = [
                element.getAttribute?.('aria-label'),
                element.getAttribute?.('title'),
                element.getAttribute?.('data-carousel-next') !== null ||
                element.getAttribute?.('data-slide-next') !== null ? 'next' : null,
                element.getAttribute?.('data-carousel-prev') !== null ||
                element.getAttribute?.('data-slide-prev') !== null ? 'previous' : null,
                element.getAttribute?.('data-slide-previous') !== null ? 'previous' : null,
                getElementClassText(element)
            ].filter(Boolean).join(' ');
            if (/\b(?:next|forward)\b/i.test(label)) return 'forward';
            if (/\b(?:previous|prev|back)\b/i.test(label)) return 'backward';
            return null;
        };
        const getGenericControlKind = (control) => /(?:swiper|slick|splide|flickity)/i.test(
            getElementClassText(control)
        ) ? 'library' : (
            control.getAttribute?.('rel') || control.getAttribute?.('aria-label') ||
            control.getAttribute?.('title') ? 'semantic' : 'structural'
        );
        const getGenericControlAvailability = (control) => {
            const phaseStartedAt = getPhaseStartedAt();
            if (!control || !control.isConnected) return {usable: false, reason: 'control-unavailable'};
            if (control.hasAttribute('disabled') || control.hasAttribute('hidden') ||
                control.hasAttribute('inert') || control.getAttribute('aria-disabled') === 'true' ||
                /(?:^|\s)(?:disabled|swiper-button-disabled)(?:\s|$)/i.test(
                    getElementClassText(control)
                )) {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return {usable: false, reason: 'control-disabled'};
            }
            try {
                const style = getComputedStyle(control);
                if (style.display === 'none' || style.visibility === 'hidden' ||
                    style.visibility === 'collapse' || style.pointerEvents === 'none') {
                    recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                    return {usable: false, reason: 'control-unavailable'};
                }
            } catch {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return {usable: false, reason: 'control-unavailable'};
            }
            recordPhase('styleAttributeGeometryMs', phaseStartedAt);
            return {usable: true, reason: null};
        };
        const getGenericCarouselControl = (root, direction) => {
            const phaseStartedAt = getPhaseStartedAt();
            const controls = queryDeep(root, '*').filter((element) =>
                getGenericControlDirection(element) === direction
            );
            const control = controls.find((candidate) => getGenericControlAvailability(candidate).usable);
            if (control) {
                recordPhase('candidateClassificationMs', phaseStartedAt);
                return {
                    control,
                    kind: getGenericControlKind(control),
                    reason: null
                };
            }

            const disabled = controls.find((candidate) =>
                getGenericControlAvailability(candidate).reason === 'control-disabled'
            );
            const result = {
                control: null,
                kind: disabled ? getGenericControlKind(disabled) : null,
                reason: disabled ? 'control-disabled' : 'control-unavailable'
            };
            recordPhase('candidateClassificationMs', phaseStartedAt);
            return result;
        };
        const getGenericTotalHint = (root) => {
            const attributeNames = ['data-slide-count', 'data-total', 'aria-setsize'];
            for (const element of [root, ...queryDeep(root, '[data-slide-count], [data-total], [aria-setsize]')]) {
                const total = attributeNames.map((attributeName) => Number(element.getAttribute?.(attributeName)))
                    .find(Number.isFinite);
                if (total > 0) return total;
            }

            const counter = queryDeep(root, '[aria-live], [class*="counter"], [class*="pagination"]')
                .map((element) => element.textContent?.trim() ?? '')
                .map((text) => text.match(/\b\d+\s*(?:\/|of)\s*(\d+)\b/i)?.[1])
                .map(Number)
                .find((total) => Number.isFinite(total) && total > 0);
            return counter ?? null;
        };
        const getGenericCarouselState = (root, gallery) => {
            const phaseStartedAt = getPhaseStartedAt();
            if (!root?.isConnected) return null;

            const slides = getGenericSlideElements(root);
            const active = slides.find((slide) => slide.getAttribute('aria-current') === 'true' ||
                slide.getAttribute('aria-selected') === 'true' || slide.getAttribute('data-active') === 'true' ||
                /(?:^|\s)(?:active|current|swiper-slide-active)(?:\s|$)/i.test(
                    getElementClassText(slide)
                )) ?? slides.find((slide) => slide.getAttribute('aria-hidden') !== 'true') ??
                (slides.length === 1 ? slides[0] : null) ?? root;
            const stateElements = [active, root, ...getGenericGalleryMediaElements(active).slice(0, 1)];
            const index = stateElements.flatMap((element) => [
                'data-swiper-slide-index',
                'data-slide-index',
                'data-index',
                'aria-posinset',
                'data-active-slide'
            ].map((attributeName) => {
                const value = element?.getAttribute?.(attributeName)?.trim();
                return value ? attributeName + ':' + value : null;
            })).find(Boolean);
            const activePagination = queryDeep(root, '[aria-current="true"], [aria-selected="true"]')
                .find((element) => element !== active);
            const pagination = activePagination?.getAttribute('aria-label')?.trim() ||
                activePagination?.getAttribute('data-index')?.trim() || null;
            const source = getGenericGalleryMediaElements(active).flatMap(getGenericElementSources)[0] ?? null;
            const rawKey = index ? 'index:' + index : pagination ? 'pagination:' + pagination :
                source ? 'source:' + source : null;
            if (!rawKey) {
                recordPhase('candidateClassificationMs', phaseStartedAt);
                return null;
            }

            const state = {
                active,
                key: rawKey,
                mountedSlides: slides.length,
                totalHint: getGenericTotalHint(root)
            };
            recordPhase('candidateClassificationMs', phaseStartedAt);
            return state;
        };
        const collectGenericCarouselSources = (root, gallery, stateLabel) => {
            const phaseStartedAt = getPhaseStartedAt();
            const elements = getGenericGalleryMediaElements(root);
            const sourceURLs = new Set();
            let lazySources = 0;

            elements.forEach((element) => {
                const hasLazyAttribute = Boolean(element.getAttribute?.('data-lazy-src') ||
                    element.getAttribute?.('data-lazy-srcset'));
                const currentSource = element instanceof HTMLImageElement
                    ? getURL(element.currentSrc, element.baseURI)
                    : null;
                getGenericElementSources(element).forEach((url) => {
                    sourceURLs.add(url);
                    addCandidates({
                        url,
                        width: url === currentSource ? Math.max(0, element.naturalWidth) : 0,
                        height: url === currentSource ? Math.max(0, element.naturalHeight) : 0,
                        source: 'imageelements',
                        visuallyBlurred: false
                    });
                });
                if (hasLazyAttribute) lazySources += 1;
            });

            let preloadNew = 0;
            sourceURLs.forEach((url) => {
                if (!gallery.knownSources.has(url)) {
                    gallery.knownSources.add(url);
                    preloadNew += 1;
                }
            });
            reportCarousel(
                'CAROUSEL',
                'gallery=' + gallery.key,
                'state=' + stateLabel,
                'preloadSources=' + sourceURLs.size,
                'lazySources=' + lazySources,
                'preloadNew=' + preloadNew
            );
            const result = {newSources: preloadNew, lazySources, preloadSources: sourceURLs.size};
            if (collectPerformance) performanceDetail.generic.resultCount += sourceURLs.size;
            recordPhase('dedupeResultHandlingMs', phaseStartedAt);
            return result;
        };
        const enrichGenericCarouselState = async (state) => {
            const activeTarget = state.active.matches?.('[at-attr="media_locator"]')
                ? state.active
                : state.active.querySelector?.('[at-attr="media_locator"]') ?? null;
            if (!activeTarget || processedTargets.has(activeTarget) || isAborted()) return;

            processedTargets.add(activeTarget);
            const sourceKey = getTargetSourceKey(activeTarget);
            if (sourceKey) processedTargetSources.add(sourceKey);
            let temporaryStyle = null;
            try {
                temporaryStyle = createTemporaryStyle();
                activeTarget.click();
                const photoSwipe = await waitFor(findOpenPhotoSwipe, 2000);
                if (!photoSwipe || isAborted()) return;

                reportActivity();
                const readySlide = await waitFor(() => getReadyActiveSlideImage(photoSwipe), 3000);
                if (!readySlide || isAborted()) return;
                addCandidates(...collectPhotoSwipeCandidates(photoSwipe, {includePreloaded: true}));
                const beforeZoom = getImageSnapshot(readySlide.image);
                try {
                    readySlide.image.click();
                    reportActivity();
                } catch {
                    return;
                }
                const zoomedSlide = await waitFor(() => {
                    const activeSlide = getReadyActiveSlideImage(photoSwipe);
                    if (!activeSlide) return null;
                    const afterZoom = getImageSnapshot(activeSlide.image);
                    return didZoomStateChange(beforeZoom, afterZoom, photoSwipe)
                        ? {activeSlide, afterZoom}
                        : null;
                }, 3000);
                if (zoomedSlide) addCandidates(...collectPhotoSwipeCandidates(
                    zoomedSlide.activeSlide.photoSwipe,
                    {includePreloaded: true}
                ));
            } catch {
                // One optional enrichment failure must not stop horizontal traversal.
            } finally {
                try {
                    const closed = await closePhotoSwipe();
                    if (!closed && findOpenPhotoSwipe()) await closePhotoSwipe();
                } finally {
                    temporaryStyle?.remove();
                }
            }
        };
        const processGenericCarouselState = async (root, gallery, state, direction) => {
            const stateLabel = getCarouselStateLabel(gallery, state.key);
            const alreadyVisited = gallery.visitedStates.has(state.key);
            const sourceBefore = collectGenericCarouselSources(root, gallery, stateLabel);
            reportCarousel(
                'CAROUSEL',
                'gallery=' + gallery.key,
                'type=' + gallery.type,
                'state=' + stateLabel,
                'direction=' + direction,
                'source=' + (alreadyVisited ? 'known' : 'new'),
                'mountedSlides=' + state.mountedSlides,
                'lazySources=' + sourceBefore.lazySources,
                'preloadSources=' + sourceBefore.preloadSources,
                'preloadNew=' + sourceBefore.newSources
            );
            if (alreadyVisited) return {alreadyVisited, newSources: sourceBefore.newSources};

            gallery.visitedStates.add(state.key);
            await enrichGenericCarouselState(state);
            const sourceAfter = collectGenericCarouselSources(root, gallery, stateLabel);
            return {
                alreadyVisited: false,
                newSources: sourceBefore.newSources + sourceAfter.newSources
            };
        };
        const isGenericGalleryRoot = (root) => {
            const phaseStartedAt = getPhaseStartedAt();
            const rootLabel = [
                root.id,
                getElementClassText(root),
                root.getAttribute?.('role'),
                root.getAttribute?.('data-carousel-id'),
                root.getAttribute?.('data-gallery-id')
            ].filter(Boolean).join(' ');
            const rootAppearsSlide = genericSlideTokens.test(getElementClassText(root)) && Boolean(
                root.getAttribute?.('data-slide-index') || root.getAttribute?.('data-swiper-slide-index') ||
                root.getAttribute?.('aria-posinset')
            );
            const hasGallerySignal = !rootAppearsSlide && (genericGalleryTokens.test(rootLabel) ||
                root.hasAttribute?.('data-carousel-id') || root.hasAttribute?.('data-gallery-id')
            );
            if (!hasGallerySignal) {
                recordPhase('candidateClassificationMs', phaseStartedAt);
                return false;
            }

            const slides = getGenericSlideElements(root);
            const mediaCount = getGenericGalleryMediaElements(root).length;
            if (collectPerformance) {
                performanceDetail.generic.rootSlideElements += slides.length;
                performanceDetail.generic.rootMediaElements += mediaCount;
                performanceDetail.generic.maxSlidesPerRoot = Math.max(
                    performanceDetail.generic.maxSlidesPerRoot,
                    slides.length
                );
                performanceDetail.generic.maxMediaElementsPerRoot = Math.max(
                    performanceDetail.generic.maxMediaElementsPerRoot,
                    mediaCount
                );
            }
            const hasControls = getGenericCarouselControl(root, 'forward').control ||
                getGenericCarouselControl(root, 'backward').control;
            const totalHint = getGenericTotalHint(root);
            const score = Number(hasGallerySignal) + Number(slides.length > 1) +
                Number(mediaCount > 0) + Number(Boolean(hasControls)) + Number(Boolean(totalHint));
            const isGalleryRoot = hasGallerySignal && score >= 2;
            recordPhase('candidateClassificationMs', phaseStartedAt);
            return isGalleryRoot;
        };
        const traverseGenericCarousel = async (root) => {
            const gallery = {
                key: getGenericGalleryKey(root),
                type: 'unknown',
                knownSources: new Set(),
                stateLabels: new Map(),
                visitedStates: new Set()
            };
            const initialState = await waitFor(() => getGenericCarouselState(root, gallery), 1500);
            if (!initialState || isAborted()) return;

            const initialLabel = getCarouselStateLabel(gallery, initialState.key);
            const virtualHint = /(?:virtual|recycl)/i.test([
                getElementClassText(root),
                root.getAttribute?.('data-virtual'),
                root.getAttribute?.('data-swiper-virtual')
            ].filter(Boolean).join(' '));
            reportCarousel(
                'CAROUSEL',
                'discovered',
                'gallery=' + gallery.key,
                'type=unknown',
                'state=' + initialLabel,
                'virtualHint=' + virtualHint,
                'mountedSlides=' + initialState.mountedSlides,
                'totalHint=' + (initialState.totalHint ?? 'unknown')
            );
            await processGenericCarouselState(root, gallery, initialState, 'initial');
            if (isAborted()) return;

            const traverseDirection = async (direction) => {
                let successfulTransitions = 0;
                while (!isAborted()) {
                    const beforeState = await waitFor(() => getGenericCarouselState(root, gallery), 1000);
                    if (!beforeState) return {kind: 'failed', reason: 'gallery-unavailable'};

                    const controlState = getGenericCarouselControl(root, direction);
                    if (!controlState.control) {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'gallery=' + gallery.key,
                            'direction=' + direction,
                            'reason=' + controlState.reason
                        );
                        return {kind: 'edge', reason: controlState.reason};
                    }
                    reportCarousel(
                        'CAROUSEL NAV',
                        'gallery=' + gallery.key,
                        'direction=' + direction,
                        'control=' + controlState.kind,
                        'stateBefore=' + getCarouselStateLabel(gallery, beforeState.key)
                    );
                    try {
                        controlState.control.click();
                        reportActivity();
                    } catch {
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'gallery=' + gallery.key,
                            'direction=' + direction,
                            'reason=control-action-failed'
                        );
                        return {kind: 'failed', reason: 'control-action-failed'};
                    }

                    const nextState = await waitFor(() => {
                        const state = getGenericCarouselState(root, gallery);
                        return state && state.key !== beforeState.key ? state : null;
                    }, 3000);
                    if (isAborted()) return {kind: 'aborted'};
                    if (!nextState) {
                        const settledControl = getGenericCarouselControl(root, direction);
                        const reason = settledControl.control ? 'stable-state' : settledControl.reason;
                        reportCarousel(
                            'CAROUSEL EDGE',
                            'gallery=' + gallery.key,
                            'direction=' + direction,
                            'reason=' + reason
                        );
                        return {kind: 'edge', reason};
                    }

                    successfulTransitions += 1;
                    const wasVisited = gallery.visitedStates.has(nextState.key);
                    const stateResult = await processGenericCarouselState(root, gallery, nextState, direction);
                    if (isAborted()) return {kind: 'aborted'};
                    if (direction === 'forward' && wasVisited && successfulTransitions > 1 &&
                        stateResult.newSources === 0) {
                        gallery.type = 'cyclic';
                        reportCarousel(
                            'CAROUSEL END',
                            'gallery=' + gallery.key,
                            'type=cyclic',
                            'visitedStates=' + gallery.visitedStates.size,
                            'totalHint=' + (nextState.totalHint ?? 'unknown'),
                            'reason=cycle-complete'
                        );
                        return {kind: 'cycle', reason: 'cycle-complete'};
                    }
                }
                return {kind: 'aborted'};
            };

            const forward = await traverseDirection('forward');
            if (forward.kind === 'aborted' || forward.kind === 'cycle' || forward.kind === 'failed') return;
            const backward = await traverseDirection('backward');
            if (backward.kind !== 'edge' || isAborted()) return;

            const type = gallery.visitedStates.size === 1 ? 'single' : 'finite';
            gallery.type = type;
            reportCarousel(
                'CAROUSEL END',
                'gallery=' + gallery.key,
                'type=' + type,
                'visitedStates=' + gallery.visitedStates.size,
                'totalHint=' + (initialState.totalHint ?? 'unknown'),
                'reason=both-edges-exhausted'
            );
        };
        const traverseGenericCarousels = async () => {
            const discoveryStartedAt = getPhaseStartedAt();
            const elements = queryDeep(scanDocument, '*');
            const roots = elements.filter(isGenericGalleryRoot);
            const candidateIterationStartedAt = getPhaseStartedAt();
            if (collectPerformance) {
                performanceDetail.generic.candidateCount = elements.length;
                performanceDetail.generic.documentElementsScanned = elements.length;
                elements.forEach((root) => {
                    if (performanceState?.genericCandidates?.has(root)) {
                        performanceDetail.generic.previouslySeenCandidates += 1;
                    } else {
                        performanceDetail.generic.newCandidates += 1;
                        performanceState?.genericCandidates?.add(root);
                    }
                });
            }
            recordPhase('candidateIterationMs', candidateIterationStartedAt);
            const isExplicitGalleryRoot = (root) => Boolean(
                root.id || root.getAttribute?.('data-carousel-id') || root.getAttribute?.('data-gallery-id')
            );
            const containsComposed = (ancestor, element) => {
                const phaseStartedAt = getPhaseStartedAt();
                for (let current = element; current;) {
                    if (current === ancestor) {
                        recordPhase('ancestorDescendantChecksMs', phaseStartedAt);
                        return true;
                    }
                    current = current.parentElement ?? current.getRootNode?.().host ?? null;
                }
                recordPhase('ancestorDescendantChecksMs', phaseStartedAt);
                return false;
            };
            const uniqueRoots = roots.filter((root) => !roots.some((other) => other !== root &&
                !isExplicitGalleryRoot(root) && isExplicitGalleryRoot(other) &&
                (containsComposed(root, other) || containsComposed(other, root))
            ));
            recordPhase('genericCarouselDiscoveryMs', discoveryStartedAt);
            for (const root of uniqueRoots) {
                const rootIterationStartedAt = getPhaseStartedAt();
                if (isAborted()) return;
                if (collectPerformance) {
                    performanceDetail.generic.rootsConsidered += 1;
                    const rootState = performanceState?.genericRoots?.get(root);
                    if (rootState) {
                        performanceDetail.generic.rootsPreviouslySeen += 1;
                        performanceDetail.generic.rootsRechecked += 1;
                        if (rootState.lastMutationVersion > rootState.lastCheckedMutationVersion) {
                            performanceDetail.generic.rootsChangedSincePreviousCall += 1;
                        } else {
                            performanceDetail.generic.rootsUnchangedSincePreviousCall += 1;
                        }
                        rootState.lastCheckedMutationVersion = performanceState?.mutationVersion ??
                            rootState.lastCheckedMutationVersion;
                        rootState.lastSeenCall = performanceDetail.callIndex;
                    } else {
                        performanceDetail.generic.rootsNew += 1;
                        performanceState?.genericRoots?.set(root, {
                            firstSeenCall: performanceDetail.callIndex,
                            lastSeenCall: performanceDetail.callIndex,
                            lastMutationVersion: performanceState?.mutationVersion ?? 0,
                            lastCheckedMutationVersion: performanceState?.mutationVersion ?? 0
                        });
                    }
                }
                if (this.#processedCarouselRoots.has(root)) {
                    if (collectPerformance) performanceDetail.generic.rootsAlreadyProcessed += 1;
                    recordPhase('candidateIterationMs', rootIterationStartedAt);
                    continue;
                }
                this.#processedCarouselRoots.add(root);
                recordPhase('candidateIterationMs', rootIterationStartedAt);
                const carouselStartedAt = performance.now();
                genericCarouselCalls += 1;
                try {
                    await traverseGenericCarousel(root);
                } finally {
                    genericCarouselMs += performance.now() - carouselStartedAt;
                }
            }
        };

        await traverseGenericCarousels();
        return {genericCarouselMs, genericCarouselCalls};
    }
}