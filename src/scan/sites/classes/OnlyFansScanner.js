import ContainerAnalyser from '../../classes/ContainerAnalyser.js';

const CHAT_CONTAINER_SELECTOR = '.b-chats__scrollbar.b-chat__messages';
const TOP_LOADER_SELECTOR = '.infinite-loading-container.b-chat__loading-top';
const CHAT_MESSAGE_SELECTOR = '[at-attr="chat_message"], .b-chat__message:not(.b-chat__message__system)';
const VIRTUAL_SWIPER_SELECTOR = '.swiper.b-slideshow.swiper-virtual';
const MAIN_WORLD_TARGET = 'image-finder-onlyfans-main-world';

/**
 * Owns OnlyFans-specific chat traversal, virtual-swiper discovery, and diagnostics.
 *
 * The generic DeepScan supplies lifecycle and collection callbacks; this class contains no
 * generic page traversal policy and never activates outside an OnlyFans chat container.
 */
export default class OnlyFansScanner {
    #signal;
    #collectDiagnostics;
    #getCurrentPass;
    #markPageActivity;
    #chatContainer;
    #carouselPhotoSwipe;
    #photoSwipeFallback;
    #observedChatContainer = null;
    #chatContainerObserver = null;
    #chatContainerDirection = null;
    #observedTopLoader = null;
    #topLoaderObserver = null;
    #topLoaderResourceObserver = null;
    #chatContainerAtTop = false;

    constructor({
        signal = null,
        collectDiagnostics = false,
        getCurrentPass = () => null,
        markPageActivity = () => undefined
    } = {}) {
        this.#signal = signal;
        this.#collectDiagnostics = collectDiagnostics;
        this.#getCurrentPass = getCurrentPass;
        this.#markPageActivity = markPageActivity;
        this.#carouselPhotoSwipe = {
            targetCount: 0,
            processedTargetsSkipped: 0,
            sourceDuplicatesSkipped: 0,
            invisibleTargetsSkipped: 0,
            openModalChecks: 0,
            openModalSkips: 0,
            openSuccesses: 0,
            openTimeouts: 0,
            readySlides: 0,
            readySlideTimeouts: 0,
            initialCandidateCount: 0,
            initialMaxWidth: 0,
            initialMaxHeight: 0,
            zoomAttempts: 0,
            zoomClickFailures: 0,
            zoomStateChanges: 0,
            zoomTimeouts: 0,
            resolutionUpgrades: 0,
            zoomCandidateCount: 0,
            zoomMaxWidth: 0,
            zoomMaxHeight: 0
        };
        this.#photoSwipeFallback = {
            used: 0,
            slides: 0,
            closed: 0,
            stillOpen: 0
        };
        this.#chatContainer = {
            selector: CHAT_CONTAINER_SELECTOR,
            detected: false,
            candidatePasses: 0,
            plan: 'not-evaluated',
            planHistory: '',
            priority: null,
            classification: null,
            suggestedAction: null,
            isScrollable: null,
            isStructural: null,
            overflowY: null,
            scrollTop: null,
            scrollHeight: null,
            clientHeight: null,
            messageCount: null,
            mediaLocatorCount: null,
            carouselTraversal: {
                swipersFound: 0,
                swipersTraversed: 0,
                slideStatesVisited: 0,
                edgesReached: 0,
                mainWorldAttempts: 0,
                mainWorldInvoked: 0,
                stateChanges: 0,
                lastMethod: null,
                lastResult: null,
                lastError: null,
                photoSwipeTargets: 0,
                photoSwipeSkipped: null,
                photoSwipeModal: null,
                photoSwipeReady: null,
                photoSwipeInitial: null,
                photoSwipeZoom: null,
                photoSwipeCloseFailure: null,
                photoSwipeMainWorldClose: null
            },
            scrollEvents: 0,
            upScrollEvents: 0,
            downScrollEvents: 0,
            topScrollEvents: 0,
            chatMessageMutationRecords: 0,
            chatMessageNodesAdded: 0,
            chatMessageNodesAddedAtTop: 0,
            chatMessageNodesRemoved: 0,
            loaderTrigger: {
                mainWorldAttempts: 0,
                mainWorldInvoked: false,
                mainWorldMethod: null,
                mainWorldResult: null,
                mainWorldError: null,
                mainWorldNetworkRequestTriggered: null,
                mainWorldComponentName: null,
                mainWorldReceiverScope: null,
                mainWorldFramework: null,
                mainWorldComponentHostDepth: null,
                mainWorldComponentParentDepth: null,
                mainWorldCandidateCount: 0,
                mainWorldIsLoadingBefore: null,
                mainWorldIsLoadingAfter: null,
                mainWorldIsComplete: null,
                trustedScrollEvents: 0,
                untrustedScrollEvents: 0,
                trustedTopScrollEvents: 0,
                lastScrollEventTrusted: null
            },
            topLoader: {
                selector: TOP_LOADER_SELECTOR,
                detected: false,
                present: false,
                observerState: 'not-started',
                height: null,
                top: null,
                bottom: null,
                visible: null,
                intersectionEvents: 0,
                intersectingEvents: 0,
                lastIsIntersecting: null,
                lastIntersectionRatio: null,
                isIntersectingAtTop: null,
                intersectionRatioAtTop: null,
                upStartHeight: null,
                upStartTop: null,
                upStartBottom: null,
                upStartVisible: null,
                upEndHeight: null,
                upEndTop: null,
                upEndBottom: null,
                upEndVisible: null,
                resourceObserverState: 'not-started',
                resourceRequests: 0,
                resourceRequestsAtTop: 0,
                fetchRequests: 0,
                fetchRequestsAtTop: 0,
                xmlHttpRequests: 0,
                xmlHttpRequestsAtTop: 0,
                lastResourceInitiator: null,
                lastResourcePath: null,
                lastResourceAtTop: null
            },
            upRuns: 0,
            upStartPass: null,
            upStartScrollTop: null,
            upStartMessages: null,
            upEndScrollTop: null,
            upEndMessages: null,
            upResult: null,
            downRuns: 0,
            downStartPass: null,
            downStartScrollTop: null,
            downStartMessages: null,
            downEndScrollTop: null,
            downEndMessages: null,
            downResult: null
        };
    }

    hasChat() {
        return window.location.hostname.endsWith('onlyfans.com') &&
            document.querySelector(CHAT_CONTAINER_SELECTOR) !== null;
    }

    matchesChatContainer(container) {
        return window.location.hostname.endsWith('onlyfans.com') &&
            container?.matches?.(CHAT_CONTAINER_SELECTOR) === true;
    }

    isRelevantScrollableContainer(container) {
        return this.matchesChatContainer(container) ||
            ContainerAnalyser.getScrollInfo(container).verticallyScrollable;
    }

    getPhotoSwipeOptions() {
        const hasChat = this.hasChat();
        return {
            skipGenericCarousel: hasChat,
            fallbackToOpenCarouselOnCloseFailure: hasChat,
            requestMainWorldPhotoSwipeClose: hasChat
                ? () => this.requestPhotoSwipeClose()
                : null
        };
    }

    recordPhotoSwipePerformance(detail, phase) {
        this.#photoSwipeFallback.used += detail.direct.closeFallbacks ?? 0;
        this.#photoSwipeFallback.slides += detail.direct.fallbackCarouselStates ?? 0;
        this.#photoSwipeFallback.closed += detail.direct.fallbackClosed ?? 0;
        this.#photoSwipeFallback.stillOpen += detail.direct.fallbackStillOpen ?? 0;
        if (phase !== 'of-virtual-swiper-slide') return;

        Object.keys(this.#carouselPhotoSwipe).forEach((name) => {
            this.#carouselPhotoSwipe[name] += detail.direct[name] ?? 0;
        });
    }

    finalizeDiagnostics(photoSwipePerformanceState) {
        const carouselTraversal = this.#chatContainer.carouselTraversal;
        carouselTraversal.photoSwipeTargets = this.#carouselPhotoSwipe.targetCount;
        carouselTraversal.photoSwipeSkipped = [
            `processed=${this.#carouselPhotoSwipe.processedTargetsSkipped}`,
            `source=${this.#carouselPhotoSwipe.sourceDuplicatesSkipped}`,
            `invisible=${this.#carouselPhotoSwipe.invisibleTargetsSkipped}`,
            `open=${this.#carouselPhotoSwipe.openModalSkips}`
        ].join(', ');
        carouselTraversal.photoSwipeModal = [
            `checks=${this.#carouselPhotoSwipe.openModalChecks}`,
            `opened=${this.#carouselPhotoSwipe.openSuccesses}`,
            `timeout=${this.#carouselPhotoSwipe.openTimeouts}`
        ].join(', ');
        carouselTraversal.photoSwipeReady = [
            `ready=${this.#carouselPhotoSwipe.readySlides}`,
            `timeout=${this.#carouselPhotoSwipe.readySlideTimeouts}`
        ].join(', ');
        carouselTraversal.photoSwipeInitial = [
            `candidates=${this.#carouselPhotoSwipe.initialCandidateCount}`,
            `max=${this.#carouselPhotoSwipe.initialMaxWidth}x` +
                this.#carouselPhotoSwipe.initialMaxHeight
        ].join(', ');
        carouselTraversal.photoSwipeZoom = [
            `attempts=${this.#carouselPhotoSwipe.zoomAttempts}`,
            `clickFailures=${this.#carouselPhotoSwipe.zoomClickFailures}`,
            `changed=${this.#carouselPhotoSwipe.zoomStateChanges}`,
            `timeout=${this.#carouselPhotoSwipe.zoomTimeouts}`,
            `upgrades=${this.#carouselPhotoSwipe.resolutionUpgrades}`,
            `candidates=${this.#carouselPhotoSwipe.zoomCandidateCount}`,
            `max=${this.#carouselPhotoSwipe.zoomMaxWidth}x` +
                this.#carouselPhotoSwipe.zoomMaxHeight
        ].join(', ');
        carouselTraversal.photoSwipeCloseFailure =
            photoSwipePerformanceState.photoSwipeCloseFailureDiagnostic;
        carouselTraversal.photoSwipeMainWorldClose =
            photoSwipePerformanceState.photoSwipeMainWorldCloseDiagnostic;
        if (this.#photoSwipeFallback.used > 0) {
            carouselTraversal.photoSwipeFallback = [
                `used=${this.#photoSwipeFallback.used}`,
                `slides=${this.#photoSwipeFallback.slides}`,
                `closed=${this.#photoSwipeFallback.closed}`,
                `stillOpen=${this.#photoSwipeFallback.stillOpen}`
            ].join(', ');
        }
        this.stopDiagnostics();
        return this.#chatContainer;
    }

    recordContainerPlan(candidates, plan) {
        if (!this.#collectDiagnostics) return;

        const container = document.querySelector(CHAT_CONTAINER_SELECTOR);
        if (!container) {
            this.#chatContainer.plan = 'not-found';
            return;
        }

        this.#updateChatContainerState(container);
        this.#observeChatContainer(container);
        this.#updateTopLoaderState(container);
        const candidate = candidates.find((item) => item.container === container);
        if (!candidate) {
            this.#chatContainer.plan = 'not-pending-candidate';
            return;
        }

        const entry = plan?.entries.find((item) => item.container === container);
        if (!entry) {
            this.#chatContainer.plan = 'not-planned';
            return;
        }

        let planName = 'analysis-only';
        if (plan.skipped.includes(entry)) planName = 'skipped';
        if (plan.scanEntries.includes(entry)) planName = 'scan';
        const historyEntry = `${this.#getCurrentPass()?.pass ?? 0}:${planName}`;
        this.#chatContainer.candidatePasses += 1;
        this.#chatContainer.plan = planName;
        this.#chatContainer.priority = entry.priority;
        this.#chatContainer.classification = entry.analysis.classification;
        this.#chatContainer.suggestedAction = entry.analysis.suggestedAction;
        this.#chatContainer.isScrollable = entry.isScrollable;
        this.#chatContainer.isStructural = entry.isStructural;
        if (!this.#chatContainer.planHistory.endsWith(historyEntry)) {
            this.#chatContainer.planHistory = [
                this.#chatContainer.planHistory,
                historyEntry
            ].filter(Boolean).join(',');
        }
    }

    recordContainerDirection(container, direction, phase, result = null) {
        if (!this.#isDiagnosticChatContainer(container)) return;

        const metrics = this.#getChatContainerMetrics(container);
        const prefix = `${direction}${phase === 'start' ? 'Start' : 'End'}`;
        if (phase === 'start') {
            this.#chatContainer[`${direction}Runs`] += 1;
            this.#chatContainer[`${direction}StartPass`] = this.#getCurrentPass()?.pass ?? null;
            this.#chatContainerDirection = direction;
            this.#chatContainerAtTop = direction === 'up' && metrics.scrollTop <= 4;
        }
        this.#chatContainer[`${prefix}ScrollTop`] = metrics.scrollTop;
        this.#chatContainer[`${prefix}Messages`] = metrics.messageCount;
        this.#updateTopLoaderState(container, direction, phase);
        if (phase === 'end') {
            this.#chatContainer[`${direction}Result`] = result;
            if (direction === 'up') this.#chatContainerAtTop = metrics.scrollTop <= 4;
            this.#chatContainerDirection = null;
        }
        this.#updateChatContainerState(container);
    }

    recordContainerEdge(container, direction) {
        this.#chatContainerAtTop = direction === 'up';
        if (!this.#isDiagnosticChatContainer(container)) return;
        if (direction === 'up') this.#updateTopLoaderState(container, direction, 'edge');
    }

    async scanHistory(container, {
        metrics,
        isActive,
        wait,
        waitForSettle,
        collectSources,
        registerTargets,
        getContainerMetrics,
        addMetric,
        scrollStepFactor,
        minimumSettleMs
    }) {
        if (!this.matchesChatContainer(container)) return null;

        let initialUpSteps = 0;
        while (isActive() && container.isConnected && container.scrollTop > 4 && initialUpSteps < 10) {
            const before = getContainerMetrics(container);
            const beforeScrollTop = container.scrollTop;
            const offset = Math.ceil(before.clientHeight * scrollStepFactor);
            container.scrollTop = Math.max(0, before.scrollTop - offset);
            initialUpSteps += 1;
            await waitForSettle({
                minimumMs: minimumSettleMs,
                scope: 'container',
                direction: 'up',
                phase: 'container-up-scroll'
            });
            await collectSources({metrics});
            registerTargets();
            if (container.scrollTop >= beforeScrollTop) break;
        }
        if (container.isConnected && container.scrollTop > 0) container.scrollTop = 0;

        while (isActive() && container.isConnected) {
            try {
                container.scrollTop = 0;
                if (typeof container.scrollTo === 'function') {
                    container.scrollTo({top: 0, behavior: 'instant'});
                }
                await waitForSettle({minimumMs: 100, scope: 'container', phase: 'container-up-top'});

                const messagesBefore = container.querySelectorAll(CHAT_MESSAGE_SELECTOR).length;
                const scrollHeightBefore = container.scrollHeight;
                let triggerResult = await this.#requestHistoryPage(container);
                if (triggerResult?.reason === 'TOP_LOADER_NOT_FOUND_COMPLETE' ||
                    !container.querySelector(TOP_LOADER_SELECTOR)) {
                    break;
                }

                let batchArrived = triggerResult?.invoked === true
                    ? await this.#waitForHistoryBatch({
                        container,
                        messagesBefore,
                        scrollHeightBefore,
                        isActive
                    })
                    : null;
                if (!batchArrived && container.querySelector(TOP_LOADER_SELECTOR)) {
                    triggerResult = await this.#requestHistoryPage(container, {preferAttemptLoad: true});
                    if (triggerResult?.reason === 'TOP_LOADER_NOT_FOUND_COMPLETE' ||
                        !container.querySelector(TOP_LOADER_SELECTOR)) {
                        break;
                    }
                    batchArrived = triggerResult?.invoked === true
                        ? await this.#waitForHistoryBatch({
                            container,
                            messagesBefore,
                            scrollHeightBefore,
                            isActive
                        })
                        : null;
                }
                if (!batchArrived) break;
                addMetric(metrics, 'steps', 1);
                addMetric(metrics, 'containerScrollSteps', 1);
                if (batchArrived.type === 'loader-completed') break;

                await waitForSettle({
                    minimumMs: 100,
                    scope: 'container',
                    direction: 'up',
                    phase: 'of-chat-history-batch'
                });
                await collectSources({metrics, phase: 'of-chat-history-batch'});
                registerTargets();
                container.scrollTop = 0;
                if (typeof container.scrollTo === 'function') {
                    container.scrollTo({top: 0, behavior: 'instant'});
                }
                await wait(200);
            } catch (error) {
                console.warn('[OnlyFans Chat History] Batch step failed:', error);
                break;
            }
        }

        await this.#traverseVirtualSwipers(container, {
            metrics,
            isActive,
            wait,
            waitForSettle,
            collectSources,
            registerTargets
        });
        await collectSources({metrics, phase: 'final'});
        registerTargets();
        return 'stable';
    }

    stopDiagnostics() {
        this.#chatContainerObserver?.disconnect();
        this.#chatContainerObserver = null;
        this.#topLoaderObserver?.disconnect();
        this.#topLoaderObserver = null;
        this.#topLoaderResourceObserver?.disconnect();
        this.#topLoaderResourceObserver = null;
        this.#observedChatContainer?.removeEventListener('scroll', this.#onChatContainerScroll);
        this.#observedChatContainer = null;
        this.#observedTopLoader = null;
        this.#chatContainerDirection = null;
        this.#chatContainerAtTop = false;
    }

    async requestPhotoSwipeClose() {
        if (!this.hasChat()) return null;

        try {
            const response = await chrome.runtime.sendMessage({
                target: MAIN_WORLD_TARGET,
                source: 'hidden-deepscan-frame',
                action: 'close-photo-swipe'
            });
            return response?.success === true ? response.result ?? null : {
                reason: response?.error ?? 'MAIN_WORLD_CLOSE_REQUEST_FAILED'
            };
        } catch (error) {
            return {reason: error instanceof Error ? error.message : String(error)};
        }
    }

    #isDiagnosticChatContainer(container) {
        return this.#collectDiagnostics && this.matchesChatContainer(container);
    }

    #getChatContainerMetrics(container) {
        const scrollInfo = ContainerAnalyser.getScrollInfo(container);
        const {geometry} = scrollInfo;
        return {
            scrollTop: geometry.scrollTop,
            scrollHeight: geometry.scrollHeight,
            clientHeight: geometry.clientHeight,
            overflowY: scrollInfo.overflowY,
            messageCount: container.querySelectorAll('[at-attr="chat_message"]').length,
            mediaLocatorCount: container.querySelectorAll('[at-attr="media_locator"]').length
        };
    }

    #updateChatContainerState(container) {
        if (!this.#isDiagnosticChatContainer(container)) return;

        const metrics = this.#getChatContainerMetrics(container);
        Object.assign(this.#chatContainer, {
            detected: true,
            overflowY: metrics.overflowY,
            scrollTop: metrics.scrollTop,
            scrollHeight: metrics.scrollHeight,
            clientHeight: metrics.clientHeight,
            messageCount: metrics.messageCount,
            mediaLocatorCount: metrics.mediaLocatorCount
        });
    }

    #updateTopLoaderState(container, direction = null, phase = null) {
        if (!this.#isDiagnosticChatContainer(container)) return;

        const loader = container.querySelector(TOP_LOADER_SELECTOR);
        const topLoader = this.#chatContainer.topLoader;
        if (!loader) {
            topLoader.present = false;
            return;
        }
        this.#observeTopLoader(container, loader);
        this.#observeTopLoaderResources();

        const containerRect = container.getBoundingClientRect();
        const loaderRect = loader.getBoundingClientRect();
        const geometry = {
            height: Math.round(loaderRect.height),
            top: Math.round(loaderRect.top - containerRect.top),
            bottom: Math.round(loaderRect.bottom - containerRect.top),
            visible: loaderRect.bottom > containerRect.top && loaderRect.top < containerRect.bottom
        };
        Object.assign(topLoader, {detected: true, present: true, ...geometry});
        if (direction !== 'up' || !['start', 'end'].includes(phase)) return;

        const prefix = `up${phase === 'start' ? 'Start' : 'End'}`;
        topLoader[`${prefix}Height`] = geometry.height;
        topLoader[`${prefix}Top`] = geometry.top;
        topLoader[`${prefix}Bottom`] = geometry.bottom;
        topLoader[`${prefix}Visible`] = geometry.visible;
    }

    #observeTopLoader(container, loader) {
        if (this.#observedTopLoader === loader) return;

        const topLoader = this.#chatContainer.topLoader;
        this.#topLoaderObserver?.disconnect();
        this.#topLoaderObserver = null;
        this.#observedTopLoader = loader;
        if (typeof IntersectionObserver !== 'function') {
            topLoader.observerState = 'unavailable';
            return;
        }

        topLoader.observerState = 'active';
        this.#topLoaderObserver = new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (entry.target !== this.#observedTopLoader) return;

                topLoader.intersectionEvents += 1;
                topLoader.lastIsIntersecting = entry.isIntersecting;
                topLoader.lastIntersectionRatio = entry.intersectionRatio;
                if (entry.isIntersecting) topLoader.intersectingEvents += 1;
                if (container.scrollTop <= 4) {
                    topLoader.isIntersectingAtTop = entry.isIntersecting;
                    topLoader.intersectionRatioAtTop = entry.intersectionRatio;
                }
            });
        }, {root: container, threshold: [0, 0.01]});
        this.#topLoaderObserver.observe(loader);
    }

    #observeTopLoaderResources() {
        if (this.#topLoaderResourceObserver) return;

        const topLoader = this.#chatContainer.topLoader;
        if (typeof PerformanceObserver !== 'function') {
            topLoader.resourceObserverState = 'unavailable';
            return;
        }

        try {
            topLoader.resourceObserverState = 'active';
            this.#topLoaderResourceObserver = new PerformanceObserver((list) => {
                list.getEntries().forEach((entry) => {
                    const initiator = String(entry.initiatorType ?? '').toLowerCase();
                    if (!['fetch', 'xmlhttprequest'].includes(initiator)) return;

                    let path = null;
                    try {
                        path = new URL(entry.name).pathname;
                    } catch {
                        path = String(entry.name ?? '');
                    }
                    topLoader.resourceRequests += 1;
                    topLoader.lastResourceInitiator = initiator;
                    topLoader.lastResourcePath = path;
                    topLoader.lastResourceAtTop = this.#chatContainerAtTop;
                    if (initiator === 'fetch') topLoader.fetchRequests += 1;
                    if (initiator === 'xmlhttprequest') topLoader.xmlHttpRequests += 1;
                    if (!this.#chatContainerAtTop) return;

                    topLoader.resourceRequestsAtTop += 1;
                    if (initiator === 'fetch') topLoader.fetchRequestsAtTop += 1;
                    if (initiator === 'xmlhttprequest') topLoader.xmlHttpRequestsAtTop += 1;
                });
            });
            this.#topLoaderResourceObserver.observe({type: 'resource', buffered: false});
        } catch {
            this.#topLoaderResourceObserver?.disconnect();
            this.#topLoaderResourceObserver = null;
            topLoader.resourceObserverState = 'unavailable';
        }
    }

    #onChatContainerScroll = (event) => {
        const container = this.#observedChatContainer;
        if (!container?.isConnected) return;

        const diagnostics = this.#chatContainer;
        const loaderTrigger = diagnostics.loaderTrigger;
        diagnostics.scrollEvents += 1;
        loaderTrigger.lastScrollEventTrusted = event.isTrusted;
        if (event.isTrusted) loaderTrigger.trustedScrollEvents += 1;
        else loaderTrigger.untrustedScrollEvents += 1;
        if (this.#chatContainerDirection === 'up') diagnostics.upScrollEvents += 1;
        else if (this.#chatContainerDirection === 'down') diagnostics.downScrollEvents += 1;

        this.#chatContainerAtTop = container.scrollTop <= 4;
        if (this.#chatContainerAtTop) {
            diagnostics.topScrollEvents += 1;
            if (event.isTrusted) loaderTrigger.trustedTopScrollEvents += 1;
        }
    };

    #observeChatContainer(container) {
        if (!this.#isDiagnosticChatContainer(container) || this.#observedChatContainer === container) {
            return;
        }

        this.stopDiagnostics();
        this.#observedChatContainer = container;
        container.addEventListener('scroll', this.#onChatContainerScroll);
        this.#chatContainerObserver = new MutationObserver((records) => {
            records.forEach((record) => {
                if (record.type !== 'childList') return;

                const countMessageNodes = (nodes) => Array.from(nodes).reduce((count, node) => {
                    if (node.nodeType !== Node.ELEMENT_NODE) return count;
                    const element = /** @type {Element} */ (node);
                    return count + Number(element.matches('[at-attr="chat_message"]')) +
                        element.querySelectorAll('[at-attr="chat_message"]').length;
                }, 0);
                const added = countMessageNodes(record.addedNodes);
                const removed = countMessageNodes(record.removedNodes);
                if (added === 0 && removed === 0) return;

                this.#chatContainer.chatMessageMutationRecords += 1;
                this.#chatContainer.chatMessageNodesAdded += added;
                this.#chatContainer.chatMessageNodesRemoved += removed;
                if (container.scrollTop <= 4) {
                    this.#chatContainer.chatMessageNodesAddedAtTop += added;
                }
            });
        });
        this.#chatContainerObserver.observe(container, {childList: true, subtree: true});
    }

    async #requestHistoryPage(container, {preferAttemptLoad = false} = {}) {
        if (!this.matchesChatContainer(container)) return null;

        const loaderTrigger = this.#chatContainer.loaderTrigger;
        if (this.#collectDiagnostics) {
            loaderTrigger.mainWorldAttempts += 1;
            loaderTrigger.mainWorldError = null;
        }
        try {
            const response = await chrome.runtime.sendMessage({
                target: MAIN_WORLD_TARGET,
                source: 'hidden-deepscan-frame',
                action: 'trigger-history-loader',
                preferAttemptLoad
            });
            if (response?.success !== true) {
                if (this.#collectDiagnostics) {
                    loaderTrigger.mainWorldResult = null;
                    loaderTrigger.mainWorldError = response?.error ?? 'MAIN_WORLD_REQUEST_FAILED';
                }
                return null;
            }

            const result = response.result ?? null;
            if (result?.invoked === true) this.#markPageActivity();
            if (this.#collectDiagnostics) {
                loaderTrigger.mainWorldResult = result?.reason ?? 'MAIN_WORLD_NO_RESULT';
                loaderTrigger.mainWorldInvoked = result?.invoked === true;
                loaderTrigger.mainWorldMethod = result?.method ?? null;
                loaderTrigger.mainWorldNetworkRequestTriggered =
                    typeof result?.networkRequestTriggered === 'boolean'
                        ? result.networkRequestTriggered
                        : null;
                loaderTrigger.mainWorldFramework = result?.framework ?? null;
                loaderTrigger.mainWorldComponentHostDepth =
                    Number.isInteger(result?.componentHostDepth) ? result.componentHostDepth : null;
                loaderTrigger.mainWorldComponentParentDepth =
                    Number.isInteger(result?.componentParentDepth)
                        ? result.componentParentDepth
                        : null;
                loaderTrigger.mainWorldComponentName = result?.componentName ?? null;
                loaderTrigger.mainWorldReceiverScope = result?.receiverScope ?? null;
                loaderTrigger.mainWorldCandidateCount =
                    Number.isInteger(result?.candidateCount) ? result.candidateCount : 0;
                loaderTrigger.mainWorldIsLoadingBefore =
                    typeof result?.isLoadingBefore === 'boolean' ? result.isLoadingBefore : null;
                loaderTrigger.mainWorldIsLoadingAfter =
                    typeof result?.isLoadingAfter === 'boolean' ? result.isLoadingAfter : null;
                loaderTrigger.mainWorldIsComplete =
                    typeof result?.isComplete === 'boolean' ? result.isComplete : null;
            }
            return result;
        } catch (error) {
            if (this.#collectDiagnostics) {
                loaderTrigger.mainWorldResult = null;
                loaderTrigger.mainWorldError = error instanceof Error ? error.message : String(error);
            }
            return null;
        }
    }

    async #advanceVirtualSwiper({root, direction}) {
        if (!root?.matches?.(VIRTUAL_SWIPER_SELECTOR) ||
            !['forward', 'backward'].includes(direction)) {
            return null;
        }
        const chatContainer = root.closest(CHAT_CONTAINER_SELECTOR);
        if (!this.matchesChatContainer(chatContainer)) return null;

        const swipers = Array.from(document.querySelectorAll(
            `${CHAT_CONTAINER_SELECTOR} ${VIRTUAL_SWIPER_SELECTOR}`
        ));
        const swiperIndex = swipers.indexOf(root);
        if (swiperIndex < 0) return null;

        const traversal = this.#chatContainer.carouselTraversal;
        if (this.#collectDiagnostics) {
            traversal.swipersFound = Math.max(
                traversal.swipersFound,
                swipers.filter((swiper) => chatContainer.contains(swiper)).length
            );
            traversal.mainWorldAttempts += 1;
            traversal.lastError = null;
        }
        try {
            const response = await chrome.runtime.sendMessage({
                target: MAIN_WORLD_TARGET,
                source: 'hidden-deepscan-frame',
                action: 'advance-virtual-swiper',
                swiperIndex,
                direction
            });
            if (response?.success !== true) {
                if (this.#collectDiagnostics) {
                    traversal.lastResult = null;
                    traversal.lastError = response?.error ?? 'MAIN_WORLD_REQUEST_FAILED';
                }
                return null;
            }

            const result = response.result ?? null;
            if (this.#collectDiagnostics) {
                if (result?.invoked === true) traversal.mainWorldInvoked += 1;
                if (result?.changed === true) traversal.stateChanges += 1;
                traversal.lastMethod = result?.method ?? null;
                traversal.lastResult = result?.reason ?? 'MAIN_WORLD_NO_RESULT';
            }
            return result;
        } catch (error) {
            if (this.#collectDiagnostics) {
                traversal.lastResult = null;
                traversal.lastError = error instanceof Error ? error.message : String(error);
            }
            return null;
        }
    }

    #getVirtualSwiperState(swiper) {
        const activeSlide = swiper?.querySelector?.('.swiper-slide-active') ?? null;
        if (!activeSlide) return null;

        const index = activeSlide.getAttribute('data-swiper-slide-index')?.trim() ?? null;
        const image = activeSlide.querySelector('img');
        const source = image?.currentSrc || image?.getAttribute('src') || null;
        const key = index ? `index:${index}` : source ? `source:${source}` : null;
        return key ? {key, index, source} : null;
    }

    #getVirtualSwiperLimit(swiper) {
        const postMedia = swiper.closest('[at-attr="post_media"], .post_media');
        const counterText = postMedia?.querySelector(
            '.switcher-media-content__btn.active-btn .switcher-media-content__val-total'
        )?.textContent ?? '';
        const total = Number(counterText.trim());
        return Number.isInteger(total) && total > 0 ? Math.min(total + 1, 128) : 64;
    }

    async #waitForVirtualSwiperStateChange(swiper, previousKey, {isActive, wait}) {
        const deadline = Date.now() + 1000;
        while (isActive() && swiper.isConnected && Date.now() < deadline) {
            const state = this.#getVirtualSwiperState(swiper);
            if (state && state.key !== previousKey) return state;
            if (!(await wait(50))) break;
        }
        return null;
    }

    async #traverseVirtualSwipers(container, context) {
        const {metrics, isActive, wait, waitForSettle, collectSources, registerTargets} = context;
        if (!this.matchesChatContainer(container)) return;

        const swipers = Array.from(container.querySelectorAll(VIRTUAL_SWIPER_SELECTOR));
        const traversal = this.#chatContainer.carouselTraversal;
        if (this.#collectDiagnostics) {
            traversal.swipersFound = Math.max(traversal.swipersFound, swipers.length);
        }

        for (const swiper of swipers) {
            if (!isActive() || !swiper.isConnected) break;
            if (this.#collectDiagnostics) traversal.swipersTraversed += 1;

            const seenStates = new Set();
            const collectActiveState = async () => {
                let state = this.#getVirtualSwiperState(swiper);
                if (!state || seenStates.has(state.key)) return state;

                await waitForSettle({
                    minimumMs: 100,
                    scope: 'container',
                    phase: 'of-virtual-swiper-slide'
                });
                state = this.#getVirtualSwiperState(swiper);
                if (!state || seenStates.has(state.key)) return state;

                seenStates.add(state.key);
                if (this.#collectDiagnostics) traversal.slideStatesVisited += 1;
                await collectSources({
                    metrics,
                    phase: 'of-virtual-swiper-slide',
                    roots: [swiper],
                    traverseCarousel: false,
                    skipDirectZoom: true
                });
                registerTargets();
                return state;
            };
            const traverseDirection = async (direction) => {
                const maximumTransitions = this.#getVirtualSwiperLimit(swiper);
                for (let transition = 0;
                    isActive() && swiper.isConnected && transition < maximumTransitions;
                    transition += 1) {
                    const beforeState = await collectActiveState();
                    if (!beforeState) return 'state-unavailable';

                    const advanceResult = await this.#advanceVirtualSwiper({root: swiper, direction});
                    if (advanceResult?.reason === 'SWIPER_EDGE_REACHED') {
                        if (this.#collectDiagnostics) traversal.edgesReached += 1;
                        return 'edge';
                    }
                    if (advanceResult?.invoked !== true) {
                        return advanceResult?.reason ?? 'advance-unavailable';
                    }

                    const immediateNextState = this.#getVirtualSwiperState(swiper);
                    const nextState = immediateNextState?.key !== beforeState.key
                        ? immediateNextState
                        : await this.#waitForVirtualSwiperStateChange(
                            swiper,
                            beforeState.key,
                            {isActive, wait}
                        );
                    if (!nextState || nextState.key === beforeState.key) return 'state-unchanged';
                }
                return 'transition-limit';
            };

            const forward = await traverseDirection('forward');
            if (isActive() && swiper.isConnected && forward !== 'transition-limit') {
                await traverseDirection('backward');
            }
        }
    }

    #waitForHistoryBatch({
        container,
        messagesBefore,
        scrollHeightBefore,
        isActive,
        timeoutMs = 10000
    }) {
        return new Promise((resolve) => {
            let observer = null;
            let timeout = null;
            let poll = null;
            const finish = (value) => {
                if (timeout !== null) clearTimeout(timeout);
                if (poll !== null) clearInterval(poll);
                observer?.disconnect();
                this.#signal?.removeEventListener?.('abort', onAbort);
                resolve(value);
            };
            const check = () => {
                if (!isActive() || !container.isConnected) {
                    finish({type: 'aborted'});
                    return;
                }
                const currentMessages = container.querySelectorAll(CHAT_MESSAGE_SELECTOR).length;
                if (currentMessages > messagesBefore) {
                    finish({type: 'message-count', currentMessages});
                    return;
                }
                if (container.scrollHeight > scrollHeightBefore) {
                    finish({type: 'scroll-height', scrollHeight: container.scrollHeight});
                    return;
                }
                if (!container.querySelector(TOP_LOADER_SELECTOR)) {
                    finish({type: 'loader-completed'});
                }
            };
            const onAbort = () => finish({type: 'aborted'});

            observer = new MutationObserver(check);
            observer.observe(container, {childList: true, subtree: true});
            poll = setInterval(check, 100);
            timeout = setTimeout(() => finish(null), timeoutMs);
            this.#signal?.addEventListener?.('abort', onAbort, {once: true});
            check();
        });
    }
}
