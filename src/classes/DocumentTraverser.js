/**
 * Traverses the document in one direction while the caller retains collection,
 * wait, diagnostic, and run-lifecycle ownership.
 */
export default class DocumentTraverser {
    #scrollStepFactor;
    #minimumSettleMs;
    #stableCycleLimit;
    #getKnownTargetCount;
    #getTargetElements;
    #isInsideLowPriorityStructureContainer;
    #isActive;
    #registerTargets;
    #collectSources;
    #waitForSettle;
    #waitForEdgeRangeGrowth;
    #recordEdgeRangeWait;
    #addMetric;
    #getScrollRange;
    #attemptedUpwardTargets = new WeakSet();
    #attemptedDownwardTargets = new WeakSet();

    constructor({
        scrollStepFactor,
        minimumSettleMs,
        stableCycleLimit,
        getKnownTargetCount,
        getTargetElements,
        isInsideLowPriorityStructureContainer,
        isActive,
        registerTargets,
        collectSources,
        waitForSettle,
        waitForEdgeRangeGrowth,
        recordEdgeRangeWait,
        addMetric,
        getScrollRange
    } = {}) {
        this.#scrollStepFactor = scrollStepFactor;
        this.#minimumSettleMs = minimumSettleMs;
        this.#stableCycleLimit = stableCycleLimit;
        this.#getKnownTargetCount = getKnownTargetCount;
        this.#getTargetElements = getTargetElements;
        this.#isInsideLowPriorityStructureContainer = isInsideLowPriorityStructureContainer;
        this.#isActive = isActive;
        this.#registerTargets = registerTargets;
        this.#collectSources = collectSources;
        this.#waitForSettle = waitForSettle;
        this.#waitForEdgeRangeGrowth = waitForEdgeRangeGrowth;
        this.#recordEdgeRangeWait = recordEdgeRangeWait;
        this.#addMetric = addMetric;
        this.#getScrollRange = getScrollRange;
    }

    getMetrics() {
        const scrollElement = this.#getScrollElement();
        const effectiveScrollTop = Number(scrollElement?.scrollTop ?? window.scrollY ?? 0);

        return {
            scrollY: Math.round(effectiveScrollTop),
            effectiveScrollTop,
            scrollHeight: Math.max(
                scrollElement?.scrollHeight ?? 0,
                document.documentElement?.scrollHeight ?? 0,
                document.body?.scrollHeight ?? 0
            ),
            clientHeight: Math.max(
                scrollElement?.clientHeight ?? 0,
                window.innerHeight ?? 0
            ),
            images: document.images?.length ?? 0,
            targets: this.#getKnownTargetCount()
        };
    }

    getTraversalState() {
        const metrics = this.getMetrics();
        return [metrics.scrollHeight, metrics.clientHeight].join(':');
    }

    async traverse(direction, {metrics = null} = {}) {
        let edgeStableCycles = 0;
        let edgeLoadWaited = false;
        const directionStartedAt = performance.now();
        const durationMetric = direction === 'up' ? 'documentUpMs' : 'documentDownMs';
        const stepMetric = direction === 'up' ? 'documentUpSteps' : 'documentDownSteps';
        let directionFinished = false;
        const finishDocumentScan = (result) => {
            if (!directionFinished) {
                directionFinished = true;
                this.#addMetric(metrics, durationMetric, performance.now() - directionStartedAt);
            }
            return result;
        };

        while (this.#isActive()) {
            this.#addMetric(metrics, stepMetric, 1);
            const beforeNewTargets = this.#registerTargets();
            const before = this.getMetrics();
            const atEdge = direction === 'up'
                ? this.#isAtCurrentDocumentTop(before)
                : this.#isAtCurrentDocumentBottom(before);
            let scrollResult = {scrolled: false, targetMovement: 0};

            const scrollActionStartedAt = performance.now();
            if (atEdge) {
                if (direction === 'down') {
                    const bottomTarget = this.#getBottomDwellTarget();
                    if (bottomTarget) scrollResult = this.#scrollElementIntoView(bottomTarget, 'end');
                }
            } else {
                const target = this.#getNextScrollTarget(direction);
                if (target) {
                    if (direction === 'up') this.#attemptedUpwardTargets.add(target.element);
                    else this.#attemptedDownwardTargets.add(target.element);
                    scrollResult = this.#scrollElementIntoView(target.element);
                } else {
                    scrollResult = this.#scrollFurtherWithAnchor(before, direction);
                }
            }
            this.#addMetric(metrics, 'scrollActionMs', performance.now() - scrollActionStartedAt);

            const settleStartedAt = performance.now();
            if (!(await this.#waitForSettle({
                minimumMs: atEdge ? 400 : this.#minimumSettleMs,
                scope: 'document',
                direction,
                phase: `document-${direction}`
            }))) {
                this.#addMetric(metrics, 'settleMs', performance.now() - settleStartedAt);
                return finishDocumentScan('aborted');
            }
            this.#addMetric(metrics, 'settleMs', performance.now() - settleStartedAt);

            await this.#collectSources({metrics});
            let afterNewTargets = this.#registerTargets();
            let after = this.getMetrics();
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = beforeNewTargets + afterNewTargets;
            let scrollRangeGrew = this.#getScrollRange(after) > this.#getScrollRange(before);
            let documentScrollMoved = direction === 'up'
                ? after.effectiveScrollTop < before.effectiveScrollTop
                : after.effectiveScrollTop > before.effectiveScrollTop;
            let scrollMoved = documentScrollMoved;
            let reachedEdge = direction === 'up'
                ? this.#isAtCurrentDocumentTop(after)
                : this.#isAtCurrentDocumentBottom(after);

            if ((atEdge || reachedEdge) && !edgeLoadWaited) {
                edgeLoadWaited = true;
                const edgeRangeGrowthStartedAt = performance.now();
                const edgeRangeGrowthResult = await this.#waitForEdgeRangeGrowth(
                    () => this.#getScrollRange(this.getMetrics())
                );
                const edgeRangeGrowthDurationMs = performance.now() - edgeRangeGrowthStartedAt;
                this.#recordEdgeRangeWait({
                    scope: 'document',
                    direction,
                    durationMs: edgeRangeGrowthDurationMs,
                    result: edgeRangeGrowthResult
                });
                this.#addMetric(metrics, 'edgeRangeGrowthMs', edgeRangeGrowthDurationMs);
                if (!this.#isActive()) return finishDocumentScan('aborted');

                if (edgeRangeGrowthResult.grew) {
                    await this.#collectSources({metrics});
                    afterNewTargets += this.#registerTargets();
                    after = this.getMetrics();
                    newImages = Math.max(0, after.images - before.images);
                    newTargets = beforeNewTargets + afterNewTargets;
                    scrollRangeGrew = this.#getScrollRange(after) > this.#getScrollRange(before);
                    documentScrollMoved = direction === 'up'
                        ? after.effectiveScrollTop < before.effectiveScrollTop
                        : after.effectiveScrollTop > before.effectiveScrollTop;
                    scrollMoved = documentScrollMoved;
                    reachedEdge = direction === 'up'
                        ? this.#isAtCurrentDocumentTop(after)
                        : this.#isAtCurrentDocumentBottom(after);
                    edgeLoadWaited = false;
                }
            }

            const traversalProgress = scrollMoved || scrollRangeGrew;
            this.#addMetric(metrics, 'newDomImages', newImages);
            this.#addMetric(metrics, 'newTargets', newTargets);

            if (!atEdge && !reachedEdge) edgeLoadWaited = false;

            if (atEdge || reachedEdge || !scrollMoved) {
                edgeStableCycles = traversalProgress ? 0 : edgeStableCycles + 1;
                if (edgeStableCycles >= this.#stableCycleLimit) {
                    return finishDocumentScan('stable');
                }
            }
        }

        return finishDocumentScan('aborted');
    }

    #getScrollElement() {
        return document.scrollingElement ?? document.documentElement;
    }

    #getNextScrollTarget(direction) {
        const viewportHeight = Math.max(window.innerHeight, 1);
        const minimumTargetTop = Math.ceil(viewportHeight * this.#scrollStepFactor);
        const attemptedTargets = direction === 'up'
            ? this.#attemptedUpwardTargets
            : this.#attemptedDownwardTargets;
        const targets = this.#getTargetElements().flatMap((element) => {
            if (attemptedTargets.has(element) || this.#isInsideLowPriorityStructureContainer(element)) {
                return [];
            }

            try {
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0 || rect.bottom <= 0) return [];

                return [{element, rect}];
            } catch {
                return [];
            }
        }).sort((first, second) => first.rect.top - second.rect.top);

        if (direction === 'up') {
            const upperTargetTop = Math.max(0, viewportHeight - minimumTargetTop);
            return targets.filter(({rect}) => rect.top < upperTargetTop)
                .sort((first, second) => second.rect.top - first.rect.top)[0] ?? null;
        }

        return targets.find(({rect}) => rect.top >= minimumTargetTop) ??
            targets.find(({rect}) => rect.bottom > viewportHeight) ?? null;
    }

    #getBottomDwellTarget() {
        let target = null;

        Array.from(document.body?.querySelectorAll('*') ?? []).forEach((element) => {
            if (element.hasAttribute('data-image-finder-scroll-anchor')) return;

            try {
                if (getComputedStyle(element).position === 'fixed') return;
                const rect = element.getBoundingClientRect();
                if (rect.width <= 0 || rect.height <= 0) return;

                const bottom = window.scrollY + rect.bottom;
                if (!target || bottom >= target.bottom) {
                    target = {element, bottom};
                }
            } catch {
                // One page-owned element must not prevent the bottom dwell.
            }
        });

        return target?.element ?? null;
    }

    #scrollElementIntoView(element, block = 'start') {
        if (!element?.scrollIntoView) return {scrolled: false, targetMovement: 0};

        let beforeTop = 0;
        try {
            beforeTop = element.getBoundingClientRect().top;
            try {
                element.scrollIntoView({behavior: 'instant', block});
            } catch {
                element.scrollIntoView({behavior: 'auto', block});
            }
            const afterTop = element.getBoundingClientRect().top;
            return {scrolled: true, targetMovement: afterTop - beforeTop};
        } catch {
            return {scrolled: false, targetMovement: 0};
        }
    }

    #scrollFurtherWithAnchor(before, direction) {
        const parent = document.body ?? document.documentElement;
        const viewportHeight = Math.max(window.innerHeight, 1);
        const maximumPosition = Math.max(0, before.scrollHeight - viewportHeight);
        const offset = Math.ceil(viewportHeight * this.#scrollStepFactor);
        const nextPosition = direction === 'up'
            ? Math.max(0, before.scrollY - offset)
            : Math.min(maximumPosition, before.scrollY + offset);
        if (!parent || nextPosition === before.scrollY) {
            return {scrolled: false, targetMovement: 0};
        }

        const anchor = document.createElement('div');
        anchor.setAttribute('aria-hidden', 'true');
        anchor.setAttribute('data-image-finder-scroll-anchor', '');
        anchor.style.cssText = [
            'position:absolute!important',
            'display:block!important',
            'left:0!important',
            `top:${nextPosition}px!important`,
            'width:1px!important',
            'height:1px!important',
            'margin:0!important',
            'padding:0!important',
            'border:0!important',
            'pointer-events:none!important',
            'opacity:0!important'
        ].join(';');
        try {
            parent.append(anchor);
            return this.#scrollElementIntoView(anchor);
        } finally {
            anchor.remove();
        }
    }

    #isAtCurrentDocumentBottom(metrics) {
        return metrics.scrollY + metrics.clientHeight >= metrics.scrollHeight - 4;
    }

    #isAtCurrentDocumentTop(metrics) {
        return metrics.scrollY <= 4;
    }

}
