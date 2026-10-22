import CarouselScanner from './classes/CarouselScanner.js';
import ContainerAnalyser from './classes/ContainerAnalyser.js';
import DeepScanController from './classes/DeepScanController.js';
import DeepScanDOMState from './classes/DeepScanDOMState.js';
import DocumentTraverser from './classes/DocumentTraverser.js';
import PhotoSwipeScanner from './classes/PhotoSwipeScanner.js';
import OnlyFansScanner from './sites/classes/OnlyFansScanner.js';

export async function scanImages(
    includeAllImageSources = false,
    includeSupplementarySources = true,
    mutationObserverOptions = null,
    includeLightboxSources = false,
    scanRoots = null
) {
    const getURL = (value, baseURI = document.baseURI) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), baseURI).href;
        } catch {
            return null;
        }
    };

    const getImageURL = (value, baseURI = document.baseURI) => {
        const url = getURL(value, baseURI);
        if (!url) return null;
        if (/^(?:data:image\/|blob:)/i.test(url)) return url;

        try {
            const {protocol} = new URL(url);
            return ['http:', 'https:'].includes(protocol) ? url : null;
        } catch {
            return null;
        }
    };

    const getSrcsetURLs = (srcset, baseURI = document.baseURI) => {
        if (typeof srcset !== 'string' || !srcset.trim()) return [];

        const singleDataImage = srcset.trim().match(
            /^(data:image\/[^,]+,[^\s]+)(?:\s+(?:\d+w|\d*\.?\d+x))?$/i
        );
        if (singleDataImage) return [getURL(singleDataImage[1], baseURI)].filter(Boolean);

        return srcset
            .split(',')
            .map((candidate) => {
                const [value, descriptor = ''] = candidate.trim().split(/\s+/, 2);
                const url = getURL(value, baseURI);

                return url ? {url, descriptor} : null;
            })
            .filter((candidate) => candidate)
            .map((candidate) => candidate.url);
    };

    const getPreferredSrcsetURL = (srcset, baseURI = document.baseURI) => {
        if (typeof srcset !== 'string' || !srcset.trim()) return null;

        const singleDataImage = srcset.trim().match(
            /^(data:image\/[^,]+,[^\s]+)(?:\s+(?:\d+w|\d*\.?\d+x))?$/i
        );
        if (singleDataImage) return getURL(singleDataImage[1], baseURI);

        const candidates = srcset
            .split(',')
            .map((candidate) => {
                const [value, descriptor = ''] = candidate.trim().split(/\s+/, 2);
                const url = getURL(value, baseURI);

                return url ? {url, descriptor} : null;
            })
            .filter((candidate) => candidate);

        if (candidates.length === 0) return null;

        const widthCandidates = candidates.filter(candidate => /^\d+w$/.test(candidate.descriptor));

        if (widthCandidates.length > 0) {
            return widthCandidates.reduce((best, candidate) =>
                Number(candidate.descriptor.slice(0, -1)) >
                Number(best.descriptor.slice(0, -1)) ? candidate : best
            ).url;
        }

        const densityCandidates = candidates.filter(candidate => /^\d*\.?\d+x$/.test(candidate.descriptor));

        if (densityCandidates.length > 0) {
            return densityCandidates.reduce((best, candidate) =>
                Number(candidate.descriptor.slice(0, -1)) >
                Number(best.descriptor.slice(0, -1)) ? candidate : best
            ).url;
        }

        return candidates[0].url;
    };

    const getPictureSourceURLs = (img) => {
        const picture = img.closest?.('picture');
        if (!picture) return [];

        return Array.from(picture.querySelectorAll('source')).flatMap((source) => [
            ...getSrcsetURLs(source.getAttribute('srcset'), source.baseURI),
            ...getSrcsetURLs(source.getAttribute('data-srcset'), source.baseURI),
            ...getSrcsetURLs(source.getAttribute('data-lazy-srcset'), source.baseURI),
            getURL(source.getAttribute('src'), source.baseURI),
            getURL(source.getAttribute('data-src'), source.baseURI),
            getURL(source.getAttribute('data-lazy-src'), source.baseURI)
        ].filter(Boolean));
    };

    const getOpenRoots = () => {
        const roots = [];
        const seenRoots = new Set();
        const initialRoots = Array.isArray(scanRoots) && scanRoots.length > 0
            ? scanRoots
            : [document];
        const addRoot = (root) => {
            if (!root || seenRoots.has(root)) return;

            seenRoots.add(root);
            roots.push(root);
        };

        initialRoots.forEach(addRoot);

        for (let index = 0; index < roots.length; index += 1) {
            if (roots[index]?.nodeType === Node.ELEMENT_NODE && roots[index].shadowRoot) {
                addRoot(roots[index].shadowRoot);
            }
            roots[index].querySelectorAll?.('*').forEach((element) => {
                if (element.shadowRoot) addRoot(element.shadowRoot);
            });
        }

        return roots;
    };

    const openRootsSnapshot = mutationObserverOptions?.enabled === true ? null : getOpenRoots();
    const getDeepElements = (selector) => {
        const elements = [];
        const seenElements = new Set();
        const addElement = (elm) => {
            if (seenElements.has(elm)) return;

            seenElements.add(elm);
            elements.push(elm);
        };

        (openRootsSnapshot ?? getOpenRoots()).forEach((root) => {
            if (root?.nodeType === Node.ELEMENT_NODE && root.matches?.(selector)) {
                addElement(root);
            }
            root.querySelectorAll?.(selector).forEach(addElement);
        });
        return elements;
    };

    const getBackgroundURLs = (bgImage) => {
        if (typeof bgImage !== 'string' || !bgImage || bgImage === 'none') return [];

        const urls = [];
        const urlPattern = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]+?))\s*\)/gi;

        for (const match of bgImage.matchAll(urlPattern)) {
            const url = getURL(match[1] ?? match[2] ?? match[3]);

            if (url) urls.push(url);
        }
        return urls;
    };

    const isDataImageURL = (url) =>
        typeof url === 'string' && /^data:image\//i.test(url);

    const isBlobImageURL = (url) =>
        typeof url === 'string' && /^blob:/i.test(url);

    const blobMetadataByUrl = new Map();
    const blobDimensionsByUrl = new Map();

    const getBlobMetadata = (url) => {
        if (blobMetadataByUrl.has(url)) return blobMetadataByUrl.get(url);

        const metadataPromise = (async () => {
            try {
                const response = await fetch(url);
                if (!response.ok) return null;

                const mimeType = response.headers.get('content-type') || null;
                const fileSize = Number(response.headers.get('content-length')) || null;

                await response.body?.cancel();
                return mimeType || fileSize !== null ? {mimeType, fileSize} : null;
            } catch {
                return null;
            }
        })();

        blobMetadataByUrl.set(url, metadataPromise);
        return metadataPromise;
    };

    const getBlobDimensions = (url) => {
        if (blobDimensionsByUrl.has(url)) return blobDimensionsByUrl.get(url);

        const dimensionsPromise = new Promise((resolve) => {
            const image = new Image();

            image.onload = () => {
                resolve(
                    image.naturalWidth > 0 && image.naturalHeight > 0
                        ? {width: image.naturalWidth, height: image.naturalHeight}
                        : null
                );
            };
            image.onerror = () => resolve(null);

            try {
                image.src = url;
            } catch {
                resolve(null);
            }
        });

        blobDimensionsByUrl.set(url, dimensionsPromise);
        return dimensionsPromise;
    };

    const hasNonZeroBlur = (filter) => {
        if (typeof filter !== 'string' || filter === 'none') return false;

        const blurPattern = /\bblur\(\s*([+-]?(?:\d+\.?\d*|\.\d+))(?:[a-z%]+)?\s*\)/gi;
        let match;

        while ((match = blurPattern.exec(filter))) {
            if (Number(match[1]) !== 0) return true;
        }

        return false;
    };

    const isBlurred = (element, computedStyle = null) => {
        try {
            for (let current = element; current;) {
                const style = current === element && computedStyle
                    ? computedStyle
                    : getComputedStyle(current);

                if (hasNonZeroBlur(style.filter)) return true;
                current = current.parentElement ?? current.getRootNode?.().host ?? null;
            }
        } catch {
            return false;
        }

        return false;
    };

    const hasBackdropBlur = (style) => [
        style.backdropFilter,
        style.webkitBackdropFilter,
        style.WebkitBackdropFilter,
        style.getPropertyValue?.('backdrop-filter'),
        style.getPropertyValue?.('-webkit-backdrop-filter')
    ].some(hasNonZeroBlur);

    const isVisibleBackdropElement = (element, style) => {
        if (style.display === 'none' ||
            style.visibility === 'hidden' ||
            style.visibility === 'collapse' ||
            Number.parseFloat(style.opacity) === 0) {
            return false;
        }

        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    };

    const elements = includeSupplementarySources
        ? getDeepElements('*')
        : [];
    const backdropBlurElements = new Set();

    for (const elmt of elements) {
        try {
            const style = getComputedStyle(elmt);
            if (hasBackdropBlur(style) && isVisibleBackdropElement(elmt, style)) {
                backdropBlurElements.add(elmt);
            }
        } catch {
            continue;
        }
    }

    const getSourceStackIndex = (stackedElements, element) => stackedElements.findIndex(
        (stackedElement) => stackedElement === element ||
            stackedElement.contains?.(element) ||
            element.contains?.(stackedElement)
    );

    const isBackdropBlurred = (element) => {
        if (backdropBlurElements.size === 0 ||
            typeof element?.getBoundingClientRect !== 'function' ||
            typeof document.elementsFromPoint !== 'function') {
            return false;
        }

        try {
            const rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;

            const getStackedElementsAtCenter = () => document.elementsFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
            );
            const stackedElements = getStackedElementsAtCenter();
            const sourceIndex = getSourceStackIndex(stackedElements, element);

            return sourceIndex > 0 && stackedElements
                .slice(0, sourceIndex)
                .some((stackedElement) => backdropBlurElements.has(stackedElement));
        } catch {
            return false;
        }
    };

    const isLinkedImageURL = (url) => {
        if (isDataImageURL(url) || isBlobImageURL(url)) return true;

        try {
            const {protocol, pathname} = new URL(url);

            if (!['http:', 'https:'].includes(protocol)) return false;

            return /\.(?:jpe?g|png|bmp|gif|webp|svg|avif)$/i.test(pathname);
        } catch {
            return false;
        }
    };

    const images = [];

    const addCandidate = (url, width, height, source, element, seenURLs = null) => {
        if (!url || seenURLs?.has(url)) return;
        seenURLs?.add(url);

        const visuallyBlurred = source !== 'linkedimages' && (
            isBlurred(element) || isBackdropBlurred(element)
        );

        images.push({
            url,
            width,
            height,
            source: isDataImageURL(url)
                ? 'dataimages'
                : isBlobImageURL(url)
                    ? 'blobimages'
                    : source,
            visuallyBlurred
        });
    };

    const collectImageElement = (img, includeAllSources, seenURLs = null) => {
        const currentSrc = getURL(img.currentSrc, img.baseURI);
        const src = getURL(img.getAttribute('src'), img.baseURI);
        const dataSrc = getURL(img.getAttribute('data-src'), img.baseURI);
        const dataSrcset = img.getAttribute('data-srcset');
        const dataLazySrc = getURL(img.getAttribute('data-lazy-src'), img.baseURI);
        const dataLazySrcset = img.getAttribute('data-lazy-srcset');
        const dataOriginal = getURL(img.getAttribute('data-original'), img.baseURI);
        const dataOriginalSrc = getURL(img.getAttribute('data-original-src'), img.baseURI);
        const hasLazySource = Boolean(dataSrc || dataSrcset || dataLazySrc || dataLazySrcset);
        const currentSrcLooksLikePlaceholder = hasLazySource && (!currentSrc || currentSrc === src);

        if (includeAllSources) {
            const imageSources = [
                currentSrc,
                src,
                ...getSrcsetURLs(img.getAttribute('srcset'), img.baseURI),
                dataSrc,
                ...getSrcsetURLs(dataSrcset, img.baseURI),
                dataLazySrc,
                ...getSrcsetURLs(dataLazySrcset, img.baseURI),
                dataOriginal,
                dataOriginalSrc,
                ...getPictureSourceURLs(img)
            ];

            for (const url of new Set(imageSources.filter(Boolean))) {
                const dimensionsKnown = url === currentSrc;
                addCandidate(
                    url,
                    dimensionsKnown ? img.naturalWidth : 0,
                    dimensionsKnown ? img.naturalHeight : 0,
                    'imageelements',
                    img,
                    seenURLs
                );
            }
            return;
        }

        let url = currentSrc;
        if (currentSrcLooksLikePlaceholder) {
            url = getPreferredSrcsetURL(dataLazySrcset, img.baseURI) || dataLazySrc ||
                getPreferredSrcsetURL(dataSrcset, img.baseURI) || dataSrc;
        }
        if (!url) url = getPreferredSrcsetURL(img.getAttribute('srcset'), img.baseURI) || src;
        const dimensionsKnown = currentSrc && url === currentSrc;
        addCandidate(
            url,
            dimensionsKnown ? img.naturalWidth : 0,
            dimensionsKnown ? img.naturalHeight : 0,
            'imageelements',
            img,
            seenURLs
        );
    };

    const LIGHTBOX_SOURCE_ATTRIBUTE_NAMES = [
        'data-src',
        'data-srcset',
        'data-lazy-src',
        'data-lazy-srcset',
        'data-image',
        'data-image-src',
        'data-full',
        'data-full-src',
        'data-fullsize',
        'data-large',
        'data-original',
        'data-original-src',
        'data-lightbox-src'
    ];
    const LIGHTBOX_MUTATION_ATTRIBUTE_NAMES = [
        'src',
        'srcset',
        ...LIGHTBOX_SOURCE_ATTRIBUTE_NAMES,
        'href',
        'aria-controls',
        'data-target',
        'onclick'
    ];

    const addLightboxSource = (value, element, seenURLs, {srcset = false} = {}) => {
        const urls = srcset
            ? getSrcsetURLs(value, element?.baseURI)
            : [getImageURL(value, element?.baseURI)];

        urls.forEach((url) => addCandidate(url, 0, 0, 'linkedimages', element, seenURLs));
    };

    const collectLightboxDataSources = (element, seenURLs) => {
        if (!element?.getAttribute) return;

        LIGHTBOX_SOURCE_ATTRIBUTE_NAMES.forEach((attributeName) => {
            const value = element.getAttribute(attributeName);
            if (!value) return;

            addLightboxSource(value, element, seenURLs, {
                srcset: attributeName.endsWith('srcset')
            });
        });
    };

    const getClickableTarget = (img) => [
        img.closest?.('a'),
        img.closest?.('button'),
        img.closest?.('[role="button"]'),
        img.closest?.('[aria-haspopup]'),
        img.closest?.('[aria-controls]')
    ].find(Boolean) ?? (
        typeof img.onclick === 'function' || Boolean(img.getAttribute?.('onclick'))
            ? img
            : null
    );

    const getAssociatedLightboxElements = (elements) => {
        const ids = new Set();
        const addFragmentID = (value) => {
            const match = typeof value === 'string' && value.trim().match(/^#(.+)$/);
            if (match?.[1]) ids.add(match[1]);
        };

        elements.forEach((element) => {
            if (!element?.getAttribute) return;

            element.getAttribute('aria-controls')?.trim().split(/\s+/).forEach((id) => {
                if (id) ids.add(id);
            });
            addFragmentID(element.getAttribute('href'));

            const target = element.getAttribute('data-target')?.trim();
            if (!target) return;
            if (target.startsWith('#')) {
                addFragmentID(target);
            } else if (/^[A-Za-z][\w:.-]*$/.test(target)) {
                ids.add(target);
            }
        });

        return Array.from(ids, (id) => getDeepElements('*').find((element) => element.id === id))
            .filter(Boolean);
    };

    const collectLightboxSources = (img, seenURLs = null) => {
        const target = getClickableTarget(img);
        if (!target) return;

        const relatedElements = new Set([img, target]);
        const href = target.tagName?.toLowerCase() === 'a'
            ? target.getAttribute('href')
            : null;
        if (href && !href.trim().startsWith('#')) {
            addLightboxSource(href, target, seenURLs);
        }

        relatedElements.forEach((element) => collectLightboxDataSources(element, seenURLs));

        getAssociatedLightboxElements(relatedElements).forEach((lightboxElement) => {
            collectLightboxDataSources(lightboxElement, seenURLs);

            const lightboxImages = [
                ...(lightboxElement.matches?.('img') ? [lightboxElement] : []),
                ...(lightboxElement.querySelectorAll?.('img') ?? [])
            ];
            lightboxImages.forEach((lightboxImage) => {
                collectImageElement(lightboxImage, true, seenURLs, true);
                collectLightboxDataSources(lightboxImage, seenURLs);
            });
        });
    };

    const enrichBlobCandidates = async () => {
        await Promise.all(images.map(async (image) => {
            if (image.source !== 'blobimages') return;

            const [metadata, dimensions] = await Promise.all([
                getBlobMetadata(image.url),
                image.width > 0 && image.height > 0
                    ? null
                    : getBlobDimensions(image.url)
            ]);
            if (metadata) Object.assign(image, metadata);
            if (dimensions) {
                image.width = dimensions.width;
                image.height = dimensions.height;
            }
        }));
    };

    if (mutationObserverOptions?.enabled === true) {
        const debounceMs = Number.isFinite(mutationObserverOptions.debounceMs)
            ? Math.max(0, mutationObserverOptions.debounceMs)
            : 100;
        const quietPeriodMs = Number.isFinite(mutationObserverOptions.quietPeriodMs)
            ? Math.max(0, mutationObserverOptions.quietPeriodMs)
            : 1000;
        const hardLimitMs = Number.isFinite(mutationObserverOptions.hardLimitMs)
            ? Math.max(quietPeriodMs, mutationObserverOptions.hardLimitMs)
            : 5000;
        const seenURLs = new Set();
        const pendingImages = new Set();

        await new Promise((resolve) => {
            const target = document.documentElement;
            if (!target || typeof MutationObserver !== 'function') {
                resolve();
                return;
            }

            let observer = null;
            let debounceTimer = null;
            let quietTimer = null;
            let hardLimitTimer = null;
            let finished = false;

            const processPendingImages = () => {
                debounceTimer = null;

                const imagesToProcess = Array.from(pendingImages);
                pendingImages.clear();

                imagesToProcess.forEach((image) => {
                    try {
                        collectImageElement(image, true, seenURLs);
                        if (includeLightboxSources) {
                            collectLightboxSources(image, seenURLs);
                        }
                    } catch {
                        // Ignore one invalid page-owned element and keep observing.
                    }
                });
            };

            const finish = () => {
                if (finished) return;
                finished = true;

                if (debounceTimer !== null) clearTimeout(debounceTimer);
                if (quietTimer !== null) clearTimeout(quietTimer);
                if (hardLimitTimer !== null) clearTimeout(hardLimitTimer);
                processPendingImages();
                observer?.disconnect();
                resolve();
            };

            const resetQuietPeriod = () => {
                if (quietTimer !== null) clearTimeout(quietTimer);
                quietTimer = setTimeout(finish, quietPeriodMs);
            };

            const queueImages = (node) => {
                if (!node || (node.nodeType !== Node.ELEMENT_NODE &&
                    node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) {
                    return false;
                }

                let foundImage = false;
                if (node.nodeType === Node.ELEMENT_NODE && node.matches?.('img')) {
                    pendingImages.add(node);
                    foundImage = true;
                }

                node.querySelectorAll?.('img').forEach((image) => {
                    pendingImages.add(image);
                    foundImage = true;
                });

                return foundImage;
            };

            const scheduleProcessing = () => {
                if (debounceTimer !== null) clearTimeout(debounceTimer);
                debounceTimer = setTimeout(processPendingImages, debounceMs);
            };

            observer = new MutationObserver((records) => {
                let hasRelevantMutation = false;

                records.forEach((record) => {
                    if (record.type === 'childList') {
                        record.addedNodes.forEach((node) => {
                            hasRelevantMutation = queueImages(node) || hasRelevantMutation;
                        });
                    } else if (record.type === 'attributes') {
                        const mutationTarget = record.target;
                        if (mutationTarget?.matches?.('img')) {
                            pendingImages.add(mutationTarget);
                            hasRelevantMutation = true;
                        } else if (includeLightboxSources && mutationTarget?.matches?.(
                            'a, button, [role="button"], [aria-haspopup], [aria-controls]'
                        )) {
                            hasRelevantMutation = queueImages(mutationTarget) || hasRelevantMutation;
                        }
                    }
                });

                if (!hasRelevantMutation) return;

                resetQuietPeriod();
                scheduleProcessing();
            });

            try {
                observer.observe(target, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: LIGHTBOX_MUTATION_ATTRIBUTE_NAMES
                });
                resetQuietPeriod();
                hardLimitTimer = setTimeout(finish, hardLimitMs);
            } catch {
                finish();
            }
        });

        await enrichBlobCandidates();
        return images;
    }

    for (const img of getDeepElements('img')) {
        collectImageElement(img, includeAllImageSources);
        if (includeLightboxSources) {
            collectLightboxSources(img);
        }
    }

    if (includeAllImageSources) {
        getDeepElements('source').forEach((source) => {
            [
                ...getSrcsetURLs(source.getAttribute('srcset'), source.baseURI),
                ...getSrcsetURLs(source.getAttribute('data-srcset'), source.baseURI),
                ...getSrcsetURLs(source.getAttribute('data-lazy-srcset'), source.baseURI),
                getURL(source.getAttribute('src'), source.baseURI),
                getURL(source.getAttribute('data-src'), source.baseURI),
                getURL(source.getAttribute('data-lazy-src'), source.baseURI)
            ].filter(Boolean).forEach((url) => {
                addCandidate(url, 0, 0, 'imageelements', source);
            });
        });
    }

    if (includeSupplementarySources) {
        for (const element of elements) {
            try {
                const style = getComputedStyle(element);
                const backgroundImage = style.backgroundImage;
                for (const url of getBackgroundURLs(backgroundImage)) {
                    addCandidate(url, 0, 0, 'backgroundimages', element);
                }
            } catch {
                continue;
            }
        }

        for (const link of getDeepElements('a[href]')) {
            const url = getURL(link.href);

            if (!isLinkedImageURL(url)) continue;

            addCandidate(url, 0, 0, 'linkedimages', link);
        }
    }

    await enrichBlobCandidates();

    return images;
}

export async function scanPhotoSwipeImages({
    processedTargets = new WeakSet(),
    processedTargetSources = new Set(),
    processedCarouselRoots = new WeakSet(),
    carouselScanner = null,
    photoSwipeScanner = null,
    signal = null,
    onDiagnostic = null,
    onCarouselDiagnostic = null,
    onActivity = null,
    onPerformance = null,
    performanceState = null,
    traverseCarousel = false,
    skipGenericCarousel = false,
    skipDirectZoom = false,
    fallbackToOpenCarouselOnCloseFailure = false,
    shouldSkipDirectTarget = null,
    allowRecycledDirectTargets = false,
    requestMainWorldPhotoSwipeClose = null,
    scanRoots = [document],
    dirtyGenericRoots = new Set(),
    registerGenericRoot = null,
    markGenericRootProcessed = null,
    registerPendingGenericRoot = null,
    markGenericRootReady = null,
    registerDirectTarget = null
} = {}) {
    const performanceStartedAt = performance.now();
    const collectPerformance = typeof onPerformance === 'function';
    const performanceDetail = collectPerformance ? {
        callIndex: (performanceState?.callIndex ?? 0) + 1,
        phases: {
            rootDiscoveryMs: 0,
            domQueriesMs: 0,
            candidateIterationMs: 0,
            candidateClassificationMs: 0,
            styleAttributeGeometryMs: 0,
            ancestorDescendantChecksMs: 0,
            dedupeResultHandlingMs: 0,
            genericCarouselDiscoveryMs: 0,
            directPhotoSwipeDiscoveryMs: 0,
            waitForMs: 0
        },
        queries: {
            calls: 0,
            allElementsCalls: 0,
            results: 0,
            allElementsResults: 0,
            maxResultSize: 0,
            bySelector: {}
        },
        generic: {
            candidateCount: 0,
            previouslySeenCandidates: 0,
            newCandidates: 0,
            rootsConsidered: 0,
            rootsPreviouslySeen: 0,
            rootsNew: 0,
            rootsRechecked: 0,
            rootsChangedSincePreviousCall: 0,
            rootsUnchangedSincePreviousCall: 0,
            rootsAlreadyProcessed: 0,
            documentElementsScanned: 0,
            rootSlideElements: 0,
            rootMediaElements: 0,
            maxSlidesPerRoot: 0,
            maxMediaElementsPerRoot: 0,
            // ✴️ NEW 2026-10-14: Explains the result of a generic carousel navigation wait.
            nextStateOutcomes: {
                changed: 0,
                stableState: 0,
                controlDisabled: 0,
                controlUnavailable: 0
            },
            resultCount: 0
        },
        direct: {
            targetCount: 0,
            previouslySeenTargets: 0,
            newTargets: 0,
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
            zoomMaxHeight: 0,
            closeFallbacks: 0,
            fallbackCarouselStates: 0,
            fallbackClosed: 0,
            fallbackStillOpen: 0,
            resultCount: 0
        },
        waits: {
            calls: 0,
            totalMs: 0,
            timeoutCount: 0,
            maxTimeoutOverrunMs: 0
        }
    } : null;
    // ✴️ NEW 2026-10-11: Keeps individual wait causes measurable per scanner call.
    const waitPurposeMetrics = new Map();
    if (performanceState && collectPerformance) {
        performanceState.callIndex = performanceDetail.callIndex;
    }
    const getPhaseStartedAt = () => collectPerformance ? performance.now() : 0;
    const recordPhase = (name, startedAt) => {
        if (!collectPerformance) return;

        performanceDetail.phases[name] += Math.max(0, performance.now() - startedAt);
    };
    const recordQuery = (selector, resultSize) => {
        if (!collectPerformance) return;

        const size = Math.max(0, Number(resultSize) || 0);
        performanceDetail.queries.calls += 1;
        performanceDetail.queries.results += size;
        performanceDetail.queries.maxResultSize = Math.max(
            performanceDetail.queries.maxResultSize,
            size
        );
        const selectorSummary = performanceDetail.queries.bySelector[selector] ?? {
            calls: 0,
            results: 0,
            maxResultSize: 0
        };
        selectorSummary.calls += 1;
        selectorSummary.results += size;
        selectorSummary.maxResultSize = Math.max(selectorSummary.maxResultSize, size);
        performanceDetail.queries.bySelector[selector] = selectorSummary;
        if (selector === '*') {
            performanceDetail.queries.allElementsCalls += 1;
            performanceDetail.queries.allElementsResults += size;
        }
    };
    const recordWaitPurpose = (purpose, durationMs, endReason) => {
        if (!collectPerformance) return;

        const metrics = waitPurposeMetrics.get(purpose) ?? {
            calls: 0,
            totalMs: 0,
            timeouts: 0,
            aborts: 0
        };
        metrics.calls += 1;
        metrics.totalMs += durationMs;
        if (endReason === 'timeout') metrics.timeouts += 1;
        if (endReason === 'abort') metrics.aborts += 1;
        waitPurposeMetrics.set(purpose, metrics);
    };
    const getWaitPurposeSummary = () => Array.from(waitPurposeMetrics.entries())
        .sort(([, first], [, second]) => second.totalMs - first.totalMs)
        .map(([purpose, metrics]) => `${purpose}: ${Math.round(metrics.totalMs)}ms, ` +
            `${metrics.calls} calls, ${metrics.timeouts} timeouts, ${metrics.aborts} aborts`)
        .join(' | ');
    // ✴️ NEW 2026-10-18: Keeps the first failed PhotoSwipe close inspectable without
    // producing a stream of runtime diagnostics. The value is surfaced once in the final
    // OnlyFans performance summary.
    let photoSwipeCloseFailureDiagnostic =
        performanceState?.photoSwipeCloseFailureDiagnostic ?? null;
    let photoSwipeMainWorldCloseDiagnostic =
        performanceState?.photoSwipeMainWorldCloseDiagnostic ?? null;
    let genericCarouselMs = 0;
    let genericCarouselCalls = 0;
    let directPhotoSwipeMs = 0;
    let directPhotoSwipeCalls = 0;
    const isAborted = () => signal?.aborted === true;
    const getOpenRoots = (initialRoot = document) => {
        const phaseStartedAt = getPhaseStartedAt();
        const roots = [initialRoot];
        const seenRoots = new Set(roots);
        const addRoot = (root) => {
            if (!root || seenRoots.has(root)) return;

            seenRoots.add(root);
            roots.push(root);
        };

        for (let index = 0; index < roots.length; index += 1) {
            if (roots[index]?.nodeType === Node.ELEMENT_NODE && roots[index].shadowRoot) {
                addRoot(roots[index].shadowRoot);
            }
            const queryStartedAt = getPhaseStartedAt();
            const elements = roots[index].querySelectorAll?.('*') ?? [];
            recordQuery('*', elements.length);
            recordPhase('domQueriesMs', queryStartedAt);
            elements.forEach((element) => {
                if (element.shadowRoot) addRoot(element.shadowRoot);
            });
        }

        recordPhase('rootDiscoveryMs', phaseStartedAt);
        return roots;
    };
    const queryDeep = (root, selector) => getOpenRoots(root).flatMap((queryRoot) => {
        const queryStartedAt = getPhaseStartedAt();
        const result = [
            ...(queryRoot?.nodeType === Node.ELEMENT_NODE && queryRoot.matches?.(selector)
                ? [queryRoot]
                : []),
            ...Array.from(queryRoot.querySelectorAll?.(selector) ?? [])
        ];
        recordQuery(selector, result.length);
        recordPhase('domQueriesMs', queryStartedAt);
        return result;
    });
    const findDeep = (selector) => getOpenRoots().map((root) => {
        const queryStartedAt = getPhaseStartedAt();
        const result = root.querySelector?.(selector) ?? null;
        recordQuery(selector, Number(Boolean(result)));
        recordPhase('domQueriesMs', queryStartedAt);
        return result;
    }).find(Boolean) ?? null;
    const findOpenPhotoSwipe = () => findDeep('.pswp.pswp--open');
    const getActiveSlide = (photoSwipe) => {
        const firstQueryStartedAt = getPhaseStartedAt();
        const visibleSlide = photoSwipe?.querySelector('.pswp__item[aria-hidden="false"]') ?? null;
        recordQuery('.pswp__item[aria-hidden="false"]', Number(Boolean(visibleSlide)));
        recordPhase('domQueriesMs', firstQueryStartedAt);
        if (visibleSlide) return visibleSlide;

        const fallbackQueryStartedAt = getPhaseStartedAt();
        const fallbackSlide = photoSwipe?.querySelector('.pswp__item:not([aria-hidden="true"])') ?? null;
        recordQuery('.pswp__item:not([aria-hidden="true"])', Number(Boolean(fallbackSlide)));
        recordPhase('domQueriesMs', fallbackQueryStartedAt);
        return fallbackSlide;
    };
    const getPhotoSwipeImages = (photoSwipe) => {
        const queryStartedAt = getPhaseStartedAt();
        const elements = Array.from(
            photoSwipe?.querySelectorAll?.('.pswp__item .pswp__img, .pswp__item img') ?? []
        );
        recordQuery('.pswp__item .pswp__img, .pswp__item img', elements.length);
        recordPhase('domQueriesMs', queryStartedAt);
        return elements.flatMap((element) => {
            if (element instanceof HTMLImageElement) return [element];

            const nestedQueryStartedAt = getPhaseStartedAt();
            const images = Array.from(element.querySelectorAll('img'));
            recordQuery('img', images.length);
            recordPhase('domQueriesMs', nestedQueryStartedAt);
            return images;
        }).filter((image, index, images) => images.indexOf(image) === index);
    };
    const getSlideImages = (photoSwipe) => {
        const slide = getActiveSlide(photoSwipe);
        if (!slide) return [];

        const phaseStartedAt = getPhaseStartedAt();
        const images = getPhotoSwipeImages(photoSwipe).filter((image) => slide.contains(image));
        recordPhase('ancestorDescendantChecksMs', phaseStartedAt);
        return images;
    };
    const getActiveSlideImage = (photoSwipe) => {
        if (!photoSwipe?.matches('.pswp.pswp--open')) return null;

        const slide = getActiveSlide(photoSwipe);
        if (!slide) return null;

        const image = getSlideImages(photoSwipe).find((candidate) =>
            Boolean(candidate.currentSrc || candidate.getAttribute('src'))
        );
        return image ? {photoSwipe, slide, image} : null;
    };
    const getReadyActiveSlideImage = (photoSwipe) => {
        const activeSlide = getActiveSlideImage(photoSwipe);
        return activeSlide?.image.complete === true && activeSlide.image.naturalWidth > 0 &&
            activeSlide.image.naturalHeight > 0
            ? activeSlide
            : null;
    };
    const waitFor = (
        predicate,
        timeoutMs = 2000,
        purpose = 'unclassified'
    ) => new Promise((resolve) => {
        const waitStartedAt = getPhaseStartedAt();
        let observer = null;
        let interval = null;
        let timeout = null;
        let settled = false;
        const finish = (value, endReason = 'predicate') => {
            if (settled) return;

            settled = true;
            observer?.disconnect();
            clearInterval(interval);
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', onAbort);
            if (collectPerformance) {
                const durationMs = Math.max(0, performance.now() - waitStartedAt);
                performanceDetail.phases.waitForMs += durationMs;
                performanceDetail.waits.calls += 1;
                performanceDetail.waits.totalMs += durationMs;
                if (endReason === 'timeout') {
                    performanceDetail.waits.timeoutCount += 1;
                    performanceDetail.waits.maxTimeoutOverrunMs = Math.max(
                        performanceDetail.waits.maxTimeoutOverrunMs,
                        Math.max(0, durationMs - timeoutMs)
                    );
                }
                recordWaitPurpose(purpose, durationMs, endReason);
            }
            resolve(value);
        };
        const onAbort = () => finish(null, 'abort');
        const check = () => {
            if (isAborted()) {
                finish(null, 'abort');
                return;
            }
            try {
                const result = predicate();
                if (result) finish(result, 'predicate');
            } catch {
                // A failed inspection is treated like a state that has not appeared yet.
            }
        };

        check();
        if (settled) return;
        if (isAborted()) {
            finish(null, 'abort');
            return;
        }
        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(check);
            getOpenRoots().forEach((root) => {
                observer.observe(root, {
                    subtree: true,
                    childList: true,
                    attributes: true,
                    attributeFilter: ['class', 'src', 'srcset', 'role', 'aria-hidden']
                });
            });
        }
        interval = setInterval(check, 50);
        timeout = setTimeout(() => finish(null, 'timeout'), timeoutMs);
        signal?.addEventListener?.('abort', onAbort, {once: true});
    });
    // ✏️ EDIT 2026-10-16: Support OnlyFans icon-close buttons, Escape keydown, and fallback cleanup.
    const findPhotoSwipeCloseControl = (photoSwipe) => {
        if (!photoSwipe) return null;
        const isPhotoSwipeControl = (control) => Boolean(control) &&
            !control.matches?.('.vjs-close-button, [class*="vjs-"]') &&
            !control.closest?.('.video-js');

        const directButton = Array.from(photoSwipe.querySelectorAll([
            '.pswp__button--close',
            '[data-pswp-close]',
            '[data-pswp-action="close"]',
            '[at-attr*="close" i]',
            'button[aria-label*="close" i]',
            'button[aria-label*="schließen" i]',
            'button[title*="close" i]',
            'button[title*="schließen" i]'
        ].join(', '))).find(isPhotoSwipeControl) ?? null;
        if (directButton) return directButton;

        const closeIcon = photoSwipe.querySelector(
            '[data-icon-name="icon-close"], [data-icon-name*="close" i], use[href*="#icon-close"]'
        );
        if (closeIcon) {
            const iconButton = closeIcon.closest('button, [role="button"], a, .pswp__button');
            if (isPhotoSwipeControl(iconButton)) return iconButton;
        }
        return Array.from(photoSwipe.querySelectorAll(
            '.pswp__top-bar button, .pswp__top-bar [role="button"]'
        )).find(isPhotoSwipeControl) ?? null;
    };
    const describePhotoSwipeElement = (element) => {
        if (!element) return 'none';

        const className = (element.getAttribute?.('class') ?? '')
            .trim()
            .replace(/\s+/g, '.')
            .slice(0, 180);
        const attributes = [
            ['id', element.id],
            ['role', element.getAttribute?.('role')],
            ['aria-label', element.getAttribute?.('aria-label')],
            ['title', element.getAttribute?.('title')],
            ['at-attr', element.getAttribute?.('at-attr')],
            ['icon', element.querySelector?.('[data-icon-name]')?.getAttribute('data-icon-name')]
        ].filter(([, value]) => value).map(([name, value]) =>
            `${name}=${String(value).slice(0, 120)}`
        );
        return [
            String(element.tagName ?? 'unknown').toLowerCase(),
            className ? `.${className}` : null,
            ...attributes
        ].filter(Boolean).join(' ');
    };
    const recordPhotoSwipeCloseFailure = (photoSwipe, purpose, closeButton) => {
        if (photoSwipeCloseFailureDiagnostic) return;

        const activeSlide = getActiveSlide(photoSwipe);
        const activeImage = getSlideImages(photoSwipe)[0] ?? null;
        const controls = Array.from(new Set(Array.from(photoSwipe.querySelectorAll(
            'button, [role="button"], a, .pswp__button'
        )))).slice(0, 12).map(describePhotoSwipeElement).join(' | ') || 'none';
        const imageState = activeImage
            ? `${activeImage.naturalWidth}x${activeImage.naturalHeight}, ` +
                `complete=${activeImage.complete}`
            : 'none';
        photoSwipeCloseFailureDiagnostic = [
            `purpose=${purpose}`,
            `modal=${describePhotoSwipeElement(photoSwipe)}`,
            `chosenClose=${describePhotoSwipeElement(closeButton)}`,
            `activeSlide=${describePhotoSwipeElement(activeSlide)}`,
            `activeImage=${imageState}`,
            `mainWorldClose=${photoSwipeMainWorldCloseDiagnostic ?? 'not-used'}`,
            `controls=${controls}`
        ].join('; ');
        if (performanceState) {
            performanceState.photoSwipeCloseFailureDiagnostic = photoSwipeCloseFailureDiagnostic;
        }
    };
    const closePhotoSwipe = async (purpose = 'photo-swipe') => {
        const photoSwipe = findOpenPhotoSwipe();
        if (!photoSwipe) return true;

        const requestEscapeClose = () => {
            try {
                const event = new KeyboardEvent('keydown', {
                    key: 'Escape',
                    code: 'Escape',
                    bubbles: true,
                    cancelable: true
                });
                Object.defineProperties(event, {
                    keyCode: {value: 27},
                    which: {value: 27}
                });
                document.dispatchEvent(event);
            } catch {
                // Some pages do not accept synthetic keyboard events.
            }
        };

        const closeButton = findPhotoSwipeCloseControl(photoSwipe) ?? await waitFor(
            () => findPhotoSwipeCloseControl(photoSwipe),
            500,
            purpose + '-close-button'
        );
        let mainWorldCloseAttempted = false;
        const requestMainWorldClose = async () => {
            mainWorldCloseAttempted = true;
            let mainWorldResult = null;
            try {
                mainWorldResult = await requestMainWorldPhotoSwipeClose();
            } catch {
                mainWorldResult = {reason: 'MAIN_WORLD_CLOSE_REQUEST_FAILED'};
            }
            photoSwipeMainWorldCloseDiagnostic = [
                `invoked=${mainWorldResult?.invoked === true}`,
                `closed=${mainWorldResult?.closed === true}`,
                `method=${mainWorldResult?.method ?? 'none'}`,
                `component=${mainWorldResult?.componentName ?? 'none'}`,
                `owners=${mainWorldResult?.owners ?? 'none'}`,
                `reason=${mainWorldResult?.reason ?? 'no-result'}`
            ].join(',');
            if (performanceState) {
                performanceState.photoSwipeMainWorldCloseDiagnostic =
                    photoSwipeMainWorldCloseDiagnostic;
            }
            return waitFor(() => !photoSwipe.isConnected ||
                !photoSwipe.classList.contains('pswp--open'), 300, purpose + '-main-world-close');
        };

        // OF hides this widget after an untrusted DOM click. Ask its page-owned Vue handler
        // first, while the actual close control and its component are still present.
        let closed = closeButton && typeof requestMainWorldPhotoSwipeClose === 'function'
            ? await requestMainWorldClose()
            : false;
        if (!closed) {
            if (!closeButton) requestEscapeClose();
            try {
                closeButton?.click?.();
            } catch {
                // Ignore click errors.
            }
            if (isAborted()) return true;

            closed = await waitFor(() => {
                if (!photoSwipe.isConnected) return true;
                return !photoSwipe.classList.contains('pswp--open');
            }, 1500, purpose + '-close');
        }
        if (!closed && photoSwipe.isConnected && photoSwipe.classList.contains('pswp--open')) {
            try {
                photoSwipe.querySelector('.pswp__bg, .pswp__scroll-wrap')?.click?.();
            } catch {
                // Ignore backdrop click errors.
            }
            closed = await waitFor(() => {
                if (!photoSwipe.isConnected) return true;
                return !photoSwipe.classList.contains('pswp--open');
            }, 500, purpose + '-close');
            if (!closed && photoSwipe.isConnected && photoSwipe.classList.contains('pswp--open')) {
                requestEscapeClose();
                closed = await waitFor(() => {
                    if (!photoSwipe.isConnected) return true;
                    return !photoSwipe.classList.contains('pswp--open');
                }, 500, purpose + '-close');
            }
        }
        if (!closed && !mainWorldCloseAttempted &&
            typeof requestMainWorldPhotoSwipeClose === 'function' &&
            photoSwipe.isConnected && photoSwipe.classList.contains('pswp--open')) {
            closed = await requestMainWorldClose();
        }
        if (!closed) recordPhotoSwipeCloseFailure(photoSwipe, purpose, closeButton);
        return Boolean(closed);
    };

    const getURL = (value, baseURI = document.baseURI) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), baseURI).href;
        } catch {
            return null;
        }
    };
    const getSrcsetURLs = (srcset, baseURI = document.baseURI) => typeof srcset === 'string'
        ? srcset.split(',').map((entry) => getURL(entry.trim().split(/\s+/, 1)[0], baseURI))
            .filter(Boolean)
        : [];
    const collectPhotoSwipeCandidates = (photoSwipe, {includePreloaded = false} = {}) => {
        const phaseStartedAt = getPhaseStartedAt();
        const candidates = (includePreloaded ? getPhotoSwipeImages(photoSwipe) : getSlideImages(photoSwipe))
            .flatMap((image) => {
                const currentSrc = getURL(image.currentSrc);
                const sourceURLs = [
                    currentSrc,
                    getURL(image.getAttribute('src')),
                    ...getSrcsetURLs(image.getAttribute('srcset'))
                ].filter(Boolean);

                return sourceURLs.map((url) => ({
                    url,
                    width: url === currentSrc ? image.naturalWidth : 0,
                    height: url === currentSrc ? image.naturalHeight : 0,
                    source: 'imageelements',
                    visuallyBlurred: false
                }));
            });
        recordPhase('candidateClassificationMs', phaseStartedAt);
        return candidates;
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
    const getTargetSourceKey = (target) => {
        const phaseStartedAt = getPhaseStartedAt();
        const sourceAttributes = [
            'src',
            'srcset',
            'data-src',
            'data-srcset',
            'data-image',
            'data-image-src',
            'data-full',
            'data-full-src',
            'data-original',
            'href'
        ];
        const sourceElements = [
            target,
            ...(() => {
                const queryStartedAt = getPhaseStartedAt();
                const elements = target?.querySelectorAll?.('img, source') ?? [];
                recordQuery('img, source', elements.length);
                recordPhase('domQueriesMs', queryStartedAt);
                return elements;
            })()
        ];

        for (const element of sourceElements) {
            const currentSrc = element instanceof HTMLImageElement
                ? getURL(element.currentSrc)
                : null;
            if (currentSrc) {
                recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                return currentSrc;
            }

            for (const attributeName of sourceAttributes) {
                const value = element?.getAttribute?.(attributeName);
                const source = attributeName.endsWith('srcset')
                    ? getSrcsetURLs(value)[0]
                    : getURL(value);
                if (source) {
                    recordPhase('styleAttributeGeometryMs', phaseStartedAt);
                    return source;
                }
            }
        }

        recordPhase('styleAttributeGeometryMs', phaseStartedAt);
        return null;
    };
    const createTemporaryStyle = () => {
        const style = document.createElement('style');
        style.textContent = [
            '.pswp {',
            'opacity: 0 !important;',
            'visibility: hidden !important;',
            'transition: none !important;',
            'animation: none !important;',
            '}'
        ].join('');
        (document.head ?? document.documentElement).append(style);
        return style;
    };
    const getImageSnapshot = (image) => ({
        currentSrc: getURL(image?.currentSrc),
        src: getURL(image?.getAttribute?.('src')),
        naturalWidth: Math.max(0, image?.naturalWidth ?? 0),
        naturalHeight: Math.max(0, image?.naturalHeight ?? 0)
    });
    const didZoomStateChange = (before, after, photoSwipe) => Boolean(
        photoSwipe?.classList.contains('pswp--zoomed-in') ||
        before.currentSrc !== after.currentSrc ||
        before.src !== after.src ||
        before.naturalWidth !== after.naturalWidth ||
        before.naturalHeight !== after.naturalHeight
    );
    const imageDimensions = (snapshot) => `${snapshot.naturalWidth}x${snapshot.naturalHeight}`;
    const reportZoom = (message) => {
        if (typeof onDiagnostic === 'function') onDiagnostic(message);
    };
    const reportActivity = () => {
        if (typeof onActivity === 'function') onActivity();
    };
    const reportCarousel = (event, ...details) => {
        if (typeof onCarouselDiagnostic === 'function') {
            onCarouselDiagnostic(event, ...details);
        }
    };

    const candidates = [];
    const activePhotoSwipeScanner = photoSwipeScanner ?? new PhotoSwipeScanner({
        processedTargets,
        processedTargetSources
    });
    const photoSwipeCarouselContext = activePhotoSwipeScanner.getCarouselContext();
    // Shared with CarouselScanner's optional PhotoSwipe enrichment.
    const getCarouselStateLabel = (carousel, key) => {
        if (!carousel.stateLabels.has(key)) {
            carousel.stateLabels.set(key, 'state#' + carousel.stateLabels.size);
        }
        return carousel.stateLabels.get(key);
    };
    const activeCarouselScanner = carouselScanner ?? new CarouselScanner({processedCarouselRoots});
    if (traverseCarousel && !skipGenericCarousel) {
        const carouselScanResult = await activeCarouselScanner.scan({
            document,
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
            processedTargets: photoSwipeCarouselContext.processedTargets,
            processedTargetSources: photoSwipeCarouselContext.processedTargetSources,
            collectPerformance,
            performanceDetail,
            performanceState,
            getPhaseStartedAt,
            recordPhase,
            addCandidates: (...newCandidates) => candidates.push(...newCandidates),
            getCarouselStateLabel,
            scanRoots,
            dirtyGenericRoots,
            registerGenericRoot,
            markGenericRootProcessed,
            registerPendingGenericRoot,
            markGenericRootReady
        });
        genericCarouselMs += carouselScanResult.genericCarouselMs;
        genericCarouselCalls += carouselScanResult.genericCarouselCalls;
    }


    const photoSwipeScanResult = await activePhotoSwipeScanner.scan({
        document,
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
        addCandidates: (...newCandidates) => candidates.push(...newCandidates),
        getCandidateCount: () => candidates.length,
        traverseCarousel,
        skipDirectZoom,
        fallbackToOpenCarouselOnCloseFailure,
        shouldSkipDirectTarget,
        allowRecycledDirectTargets,
        scanRoots,
        registerDirectTarget
    });
    directPhotoSwipeMs += photoSwipeScanResult.directPhotoSwipeMs;
    directPhotoSwipeCalls += photoSwipeScanResult.directPhotoSwipeCalls;

    const scanPhotoSwipeMs = performance.now() - performanceStartedAt;
    try {
        const detail = collectPerformance ? {
            ...performanceDetail,
            totalDurationMs: scanPhotoSwipeMs,
            nonWaitDurationMs: Math.max(0, scanPhotoSwipeMs - performanceDetail.waits.totalMs),
            waitPurposes: Object.fromEntries(waitPurposeMetrics.entries()),
            waitPurposeSummary: getWaitPurposeSummary(),
            generic: {
                ...performanceDetail.generic,
                durationMs: genericCarouselMs,
                discoveryMs: performanceDetail.phases.genericCarouselDiscoveryMs
            },
            direct: {
                ...performanceDetail.direct,
                durationMs: directPhotoSwipeMs,
                discoveryMs: performanceDetail.phases.directPhotoSwipeDiscoveryMs
            }
        } : null;
        onPerformance?.({
            scanPhotoSwipeMs,
            genericCarouselMs,
            genericCarouselCalls,
            directPhotoSwipeMs,
            directPhotoSwipeCalls,
            otherMs: Math.max(0, scanPhotoSwipeMs - genericCarouselMs - directPhotoSwipeMs),
            detail
        });
    } catch {
        // Performance instrumentation must never affect the scanner.
    }

    return candidates;
}

const DEEP_SCAN_READINESS_POLL_INTERVAL_MS = 100;
const DEEP_SCAN_READINESS_STABLE_MS = 300;
const DEEP_SCAN_READINESS_MAX_WAIT_MS = 2000;
const DEEP_SCAN_MUTATION_ATTRIBUTES = [
    'src',
    'srcset',
    'data-src',
    'data-srcset',
    'data-lazy-src',
    'data-lazy-srcset',
    'data-image',
    'data-image-src',
    'data-full',
    'data-full-src',
    'data-fullsize',
    'data-large',
    'data-original',
    'data-original-src',
    'data-lightbox-src',
    'href',
    'aria-controls',
    'data-target',
    'onclick',
    'at-attr',
    'data-carousel-id',
    'data-gallery-id'
];

export async function runIsolatedDeepScan({
    onBatch = null,
    signal = null,
    scrollStepFactor = 0.8,
    scrollSettleMs = 150,
    lightboxSettleMs = 250,
    finalSettleMs = 1000
} = {}) {
    const seenURLs = new Set();
    const pendingCollections = [];
    const imageSourceAttributes = [
        'data-src',
        'data-srcset',
        'data-image',
        'data-image-src',
        'data-full',
        'data-full-src',
        'data-fullsize',
        'data-large',
        'data-original',
        'data-lightbox-src'
    ];
    const explicitLightboxSourceAttributes = imageSourceAttributes.filter((attribute) => ![
        'data-src',
        'data-srcset'
    ].includes(attribute));
    const mutationAttributes = [
        'src',
        'srcset',
        ...imageSourceAttributes,
        'href',
        'aria-controls',
        'data-target',
        'onclick'
    ];
    const clickedTargets = new WeakSet();
    let collectionQueue = Promise.resolve();
    let observer = null;
    let mutationTimer = null;
    let lightboxActivations = 0;
    const isActive = () => signal?.aborted !== true;
    const getURL = (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), document.baseURI).href;
        } catch {
            return null;
        }
    };
    const isImageLikeURL = (value) => {
        const url = getURL(value);
        if (!url) return false;
        if (/^(?:data:image\/|blob:)/i.test(url)) return true;

        try {
            return /\.(?:jpe?g|png|bmp|gif|webp|svg|avif)(?:$|[?#])/i.test(new URL(url).pathname);
        } catch {
            return false;
        }
    };
    const wait = (milliseconds) => new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }

        const finish = (completed) => {
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', onAbort);
            resolve(completed);
        };
        const timeout = setTimeout(() => finish(true), milliseconds);
        const onAbort = () => finish(false);

        signal?.addEventListener?.('abort', onAbort, {once: true});
    });
    const scrollToDocumentPosition = (position) => {
        const parent = document.body ?? document.documentElement;
        if (!parent || typeof document.createElement !== 'function') return false;

        const anchor = document.createElement('div');
        anchor.setAttribute('aria-hidden', 'true');
        anchor.style.cssText = [
            'position:absolute!important',
            'display:block!important',
            'left:0!important',
            `top:${Math.max(0, position)}px!important`,
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
            try {
                anchor.scrollIntoView({behavior: 'instant', block: 'start'});
            } catch {
                anchor.scrollIntoView({behavior: 'auto', block: 'start'});
            }
            return true;
        } finally {
            anchor.remove();
        }
    };
    const scrollToElement = (element) => {
        if (!element?.scrollIntoView) return false;

        try {
            try {
                element.scrollIntoView({behavior: 'instant', block: 'start'});
            } catch {
                element.scrollIntoView({behavior: 'auto', block: 'start'});
            }
            return true;
        } catch {
            return false;
        }
    };
    const getReadinessState = () => {
        const documentElement = document.documentElement;
        const body = document.body;
        const scrollHeight = Math.max(
            documentElement?.scrollHeight ?? 0,
            body?.scrollHeight ?? 0
        );
        const images = document.images?.length ?? 0;
        const relevantElementCount = body?.childElementCount ?? 0;

        return {
            viewportReady: window.innerWidth > 0 && window.innerHeight > 0,
            images,
            scrollHeight,
            relevantElementCount,
            layoutSignature: [
                scrollHeight,
                images,
                relevantElementCount
            ].join(':')
        };
    };
    const waitForScanReadiness = async () => {
        const readinessStartedAt = Date.now();
        const readinessDeadline = readinessStartedAt + DEEP_SCAN_READINESS_MAX_WAIT_MS;
        let layoutSignature = null;
        let stableSince = null;

        while (isActive()) {
            const state = getReadinessState();
            const now = Date.now();
            const layoutChanged = layoutSignature !== state.layoutSignature;

            if (!state.viewportReady) {
                layoutSignature = null;
                stableSince = null;
            } else if (layoutChanged) {
                layoutSignature = state.layoutSignature;
                stableSince = now;
            }
            if (state.viewportReady && stableSince !== null &&
                now - stableSince >= DEEP_SCAN_READINESS_STABLE_MS) {
                return state;
            }

            if (now >= readinessDeadline) {
                return state;
            }

            await wait(Math.min(
                DEEP_SCAN_READINESS_POLL_INTERVAL_MS,
                Math.max(0, readinessDeadline - Date.now())
            ));
        }

        return getReadinessState();
    };
    const scrolledElementTargets = new WeakSet();
    const getElementScrollTarget = (viewportHeight) => {
        const minimumTargetTop = Math.ceil(viewportHeight * scrollStepFactor);
        const targets = Array.from(document.querySelectorAll('img,video')).map((element) => {
            const rect = element.getBoundingClientRect();
            return {element, rect};
        }).filter(({element, rect}) => !scrolledElementTargets.has(element) &&
            rect.width > 0 && rect.height > 0 && rect.top > 0
        ).sort((first, second) => first.rect.top - second.rect.top);

        return targets.find(({rect}) => rect.top >= minimumTargetTop) ?? null;
    };
    const serializeCandidate = (candidate) => ({
        url: candidate.url,
        width: Number.isFinite(candidate.width) ? Math.max(0, candidate.width) : 0,
        height: Number.isFinite(candidate.height) ? Math.max(0, candidate.height) : 0,
        source: candidate.source,
        visuallyBlurred: candidate.visuallyBlurred === true,
        ...(typeof candidate.mimeType === 'string' ? {mimeType: candidate.mimeType} : {}),
        ...(Number.isFinite(candidate.fileSize) ? {fileSize: candidate.fileSize} : {})
    });
    const collectSources = async () => {
        if (!isActive()) return;

        const foundCandidates = await scanImages(
            true,
            false,
            null,
            true
        );
        const newCandidates = [];

        for (const candidate of foundCandidates) {
            if (typeof candidate?.url !== 'string' || seenURLs.has(candidate.url)) continue;

            seenURLs.add(candidate.url);
            newCandidates.push(serializeCandidate(candidate));
        }

        if (newCandidates.length > 0 && typeof onBatch === 'function' && isActive()) {
            await onBatch(newCandidates);
        }
    };
    const queueCollection = () => {
        const collection = collectionQueue.then(collectSources).catch(() => undefined);
        collectionQueue = collection;
        pendingCollections.push(collection);
        return collection;
    };
    const scheduleCollection = () => {
        if (mutationTimer !== null) clearTimeout(mutationTimer);
        mutationTimer = setTimeout(() => {
            mutationTimer = null;
            void queueCollection();
        }, 100);
    };
    const isRelevantMutation = (record) => {
        if (record.type === 'attributes') return true;

        return Array.from(record.addedNodes ?? []).some((node) => node.nodeType === Node.ELEMENT_NODE && (
            node.matches?.('img') || node.querySelector?.('img')
        ));
    };
    const getClickableTarget = (image) => [
        image.closest?.('a'),
        image.closest?.('button'),
        image.closest?.('[role="button"]'),
        image.closest?.('[aria-haspopup]'),
        image.closest?.('[aria-controls]')
    ].find(Boolean) ?? (
        typeof image.onclick === 'function' || Boolean(image.getAttribute?.('onclick'))
            ? image
            : null
    );
    const getAssociatedElements = (elements) => {
        const ids = new Set();
        const addFragmentID = (value) => {
            const match = typeof value === 'string' && value.trim().match(/^#(.+)$/);
            if (match?.[1]) ids.add(match[1]);
        };

        elements.forEach((element) => {
            if (!element?.getAttribute) return;

            element.getAttribute('aria-controls')?.trim().split(/\s+/).forEach((id) => {
                if (id) ids.add(id);
            });
            addFragmentID(element.getAttribute('href'));

            const target = element.getAttribute('data-target')?.trim();
            if (target?.startsWith('#')) addFragmentID(target);
            else if (/^[A-Za-z][\w:.-]*$/.test(target)) ids.add(target);
        });

        return Array.from(ids, (id) => document.getElementById(id)).filter(Boolean);
    };
    const hasPassiveSource = (image, target) => {
        const hasDirectSource = [image, target].some((element) => {
            if (!element?.getAttribute) return false;
            if (element.tagName?.toLowerCase() === 'a' && isImageLikeURL(element.getAttribute('href'))) {
                return true;
            }

            return explicitLightboxSourceAttributes.some((attribute) => element.getAttribute(attribute));
        });
        if (hasDirectSource) return true;

        return getAssociatedElements([image, target]).some((element) => {
            if (element.tagName?.toLowerCase() === 'a' && isImageLikeURL(element.getAttribute('href'))) {
                return true;
            }
            if (explicitLightboxSourceAttributes.some((attribute) => element.getAttribute(attribute))) {
                return true;
            }

            return element.matches?.('img') || Boolean(element.querySelector?.('img'));
        });
    };
    const hasLightboxIndicator = (target) => Boolean(
        target.matches?.('button, [role="button"], [aria-haspopup], [aria-controls]') ||
        target.getAttribute?.('data-target') ||
        target.getAttribute?.('onclick') ||
        typeof target.onclick === 'function'
    );
    const isExcludedNavigationTarget = (target) => {
        const label = [
            target.textContent,
            target.getAttribute?.('aria-label'),
            target.getAttribute?.('title')
        ].filter(Boolean).join(' ').trim();

        return target.matches?.('[rel~="next"], [rel~="prev"], [data-carousel], [data-slide]') ||
            /\b(?:view|load|show)\s+more\b|\b(?:next|previous|carousel)\b/i.test(label);
    };
    const canActivate = (image, target) => {
        if (!target || clickedTargets.has(target) || isExcludedNavigationTarget(target) ||
            hasPassiveSource(image, target)) {
            return false;
        }

        const isLink = target.tagName?.toLowerCase() === 'a';
        const href = isLink ? target.getAttribute('href')?.trim() : null;

        if (isLink && href && !href.startsWith('#') && !hasLightboxIndicator(target)) return false;
        return !isLink || !href || href.startsWith('#') || hasLightboxIndicator(target);
    };
    const getDialogCount = () => document.querySelectorAll(
        'dialog,[role="dialog"],[aria-modal="true"]'
    ).length;
    const getOverlayCount = () => document.querySelectorAll([
        'dialog',
        '[role="dialog"]',
        '[aria-modal="true"]',
        '[class*="modal" i]',
        '[class*="overlay" i]',
        '[class*="lightbox" i]',
        '[class*="viewer" i]'
    ].join(',')).length;
    const getTemporaryUnsafeClickReason = (target) => {
        const label = [
            target.textContent,
            target.getAttribute?.('aria-label'),
            target.getAttribute?.('title'),
            target.getAttribute?.('value')
        ].filter(Boolean).join(' ').trim();
        if (/\b(?:subscribe|subscription|purchase|tip|unlock|pay|buy|message|follow|like|share|abonnieren|kaufen|zahlung|bezahlen|nachricht|folgen|teilen)\b/i.test(label)) {
            return 'restricted-action';
        }

        if (target.tagName?.toLowerCase() === 'a') {
            const href = target.getAttribute('href')?.trim();
            if (href && !href.startsWith('#')) return 'non-fragment-link';
        }

        return null;
    };
    const closeOpenedLightbox = async (dialogsBefore, overlaysBefore) => {
        const dialogsAfter = getDialogCount();
        const overlaysAfter = getOverlayCount();
        if (dialogsAfter <= dialogsBefore && overlaysAfter <= overlaysBefore) return;

        const containers = Array.from(document.querySelectorAll(
            'dialog,[role="dialog"],[aria-modal="true"]'
        ));
        const closeControl = containers.flatMap((container) =>
            Array.from(container.querySelectorAll('button,[role="button"]'))
        ).find((control) => /\b(?:close|dismiss|schließen|schliessen)\b/i.test([
            control.getAttribute('aria-label'),
            control.getAttribute('title'),
            control.textContent
        ].filter(Boolean).join(' ')));
        if (!closeControl) return;

        try {
            closeControl.click();
        } catch {
            return;
        }

        await wait(lightboxSettleMs);
    };
    const activateLightboxTargets = async () => {
        const candidates = Array.from(document.images, (image) => {
            const target = getClickableTarget(image);
            return target ? {image, target} : null;
        }).filter(Boolean);

        for (const {image, target} of candidates) {
            if (!isActive()) return;
            if (!canActivate(image, target)) continue;
            if (getTemporaryUnsafeClickReason(target)) continue;

            const dialogsBefore = getDialogCount();
            const overlaysBefore = getOverlayCount();

            clickedTargets.add(target);
            try {
                target.click();
                lightboxActivations += 1;
            } catch {
                continue;
            }

            if (!(await wait(lightboxSettleMs))) return;
            await queueCollection();
            await closeOpenedLightbox(dialogsBefore, overlaysBefore);
            if (!isActive()) return;
        }
    };
    try {
        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver((records) => {
                if (records.some(isRelevantMutation)) scheduleCollection();
            });
            observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: mutationAttributes
            });
        }

        await waitForScanReadiness();
        await queueCollection();
        await activateLightboxTargets();

        let previousScrollHeight = document.scrollingElement?.scrollHeight ?? document.documentElement.scrollHeight;
        const hasLazyViewport = window.innerHeight > 0;
        const viewportHeight = Math.max(window.innerHeight || 0, 1);
        while (isActive() && hasLazyViewport) {
            const scrollElement = document.scrollingElement ?? document.documentElement;
            const before = window.scrollY;
            const scrollHeightBefore = scrollElement.scrollHeight;
            const useElementTargets = scrollHeightBefore <= viewportHeight;
            const elementTarget = useElementTargets ? getElementScrollTarget(viewportHeight) : null;
            const maximumScrollY = Math.max(0, scrollHeightBefore - viewportHeight);
            const target = Math.min(
                maximumScrollY,
                before + Math.ceil(viewportHeight * scrollStepFactor)
            );

            if (!elementTarget && target <= before) break;
            const scrolledByElement = Boolean(elementTarget);
            if (scrolledByElement) scrolledElementTargets.add(elementTarget.element);
            const elementBeforeTop = scrolledByElement
                ? elementTarget.element.getBoundingClientRect().top
                : null;
            const scrollSucceeded = scrolledByElement
                ? scrollToElement(elementTarget.element)
                : scrollToDocumentPosition(target);
            if (!scrollSucceeded) {
                break;
            }

            if (!(await wait(scrollSettleMs)) || !isActive()) {
                break;
            }
            const after = window.scrollY;
            let scrollHeight = scrollElement.scrollHeight;
            const elementGeometryMoved = scrolledByElement &&
                elementTarget.element.getBoundingClientRect().top < elementBeforeTop;
            const scrollMoved = after > before || elementGeometryMoved;
            if (!scrollMoved) break;

            await queueCollection();
            await activateLightboxTargets();
            scrollHeight = scrollElement.scrollHeight;
            if (!scrolledByElement) {
                const reachedBottom = after + viewportHeight >= scrollHeight - 2;
                if (reachedBottom && scrollHeight <= previousScrollHeight) break;

                previousScrollHeight = scrollHeight;
            }
        }

        if (isActive() && await wait(finalSettleMs)) {
            await queueCollection();
        }
    } finally {
        if (mutationTimer !== null) clearTimeout(mutationTimer);
        observer?.disconnect();
        await Promise.allSettled(pendingCollections);
    }

    return {
        status: signal?.aborted === true ? 'cancelled' : 'completed',
        lightboxActivations
    };
}

export async function runHiddenFrameDeepScan({
    onBatch = null,
    signal = null,
    collectContainerDiagnostics = false,
    stableCycleLimit = 3,
    // ✏️ EDIT 2026-10-12: Advance by full viewport heights to reduce per-step settling.
    scrollStepFactor = 1.0,
    minimumSettleMs = 150,
    quietSettleMs = 350,
    maximumSettleMs = 1500,
    minimumImageWidth = 200,
    minimumImageHeight = 200
} = {}) {
    const startedAt = Date.now();
    const startedAtPerformance = performance.now();
    const seenCandidatesByURL = new Map();
    const seenCandidateURLsByBase = new Map();
    const knownTargets = new Set();
    // ✴️ NEW 2026-10-14: Refreshes the persistent scroll-target registry only after DOM changes.
    let targetDiscoveryDirty = true;
    const photoSwipeScanner = new PhotoSwipeScanner();
    const carouselScanner = new CarouselScanner();
    // ✏️ EDIT 2026-10-11: Retained for detailed PhotoSwipe performance reporting.
    const photoSwipePerformanceState = {
        callIndex: 0,
        mutationVersion: 0,
        genericCandidates: new WeakSet(),
        genericRoots: new Map(),
        directTargets: new WeakSet(),
        photoSwipeCloseFailureDiagnostic: null,
        photoSwipeMainWorldCloseDiagnostic: null
    };
    const knownScrollContainerIndices = new Map();
    const completedScrollContainerStates = new Map();
    const handledStructureContainers = new WeakSet();
    const lowPriorityStructureContainers = new WeakSet();
    let lastRelevantMutationAt = startedAt;
    let relevantMutationCount = 0;
    // ✴️ NEW 2026-10-11: Points to the single sequential settle phase currently observing DOM activity.
    let activeSettleWait = null;
    let photoSwipeActivityCount = 0;
    let currentPassMetrics = null;
    // Kept central so a future setting can switch LOW traversal back on without
    // changing the planner or any discovery code.
    const skipLowPriorityContainers = true;
    const edgeLoadWaitMs = Math.max(5000, maximumSettleMs);
    const edgeLoadPollMs = 100;
    const isActive = () => signal?.aborted !== true;
    // ✴️ NEW 2026-10-11: Keeps DeepScan collections limited to changed DOM subtrees.
    const domState = new DeepScanDOMState({
        scanDocument: document,
        mutationAttributes: DEEP_SCAN_MUTATION_ATTRIBUTES,
        onActivity: ({records, settleRecords = records}) => {
            if (settleRecords.length > 0) targetDiscoveryDirty = true;
            // ✏️ EDIT 2026-10-11: Image loads remain queued as delta roots, but only
            // DOM mutations postpone the global settle timer after a scroll step.
            records.forEach(markKnownGenericRootsChanged);
            // ✏️ EDIT 2026-10-13: Plain UI churn remains collectable but no longer delays settle.
            if (settleRecords.length === 0) return;

            const mutationAt = Date.now();
            if (activeSettleWait?.firstMutationAt === null) {
                activeSettleWait.firstMutationAt = mutationAt;
            }
            lastRelevantMutationAt = mutationAt;
            relevantMutationCount += settleRecords.length;
        }
    });
    const createPerformanceMetrics = () => ({
        steps: 0,
        scrollActionMs: 0,
        settleMs: 0,
        edgeRangeGrowthMs: 0,
        collectSourcesMs: 0,
        scanImagesMs: 0,
        carouselPhotoSwipeMs: 0,
        scanPhotoSwipeMs: 0,
        genericCarouselMs: 0,
        directPhotoSwipeMs: 0,
        photoSwipeOtherMs: 0,
        candidatePipelineMs: 0,
        batchDispatchMs: 0,
        containerDetectionMs: 0,
        containerAnalysisMs: 0,
        containerTraversalMs: 0,
        documentUpMs: 0,
        documentDownMs: 0,
        finalSettleMs: 0,
        finalCollectionMs: 0,
        initialCollectionMs: 0,
        readinessWaitMs: 0,
        collectSourcesCalls: 0,
        scanImagesCalls: 0,
        scanPhotoSwipeCalls: 0,
        genericCarouselCalls: 0,
        directPhotoSwipeCalls: 0,
        rawCandidates: 0,
        dedupedCandidates: 0,
        batches: 0,
        documentUpSteps: 0,
        documentDownSteps: 0,
        documentTargetSteps: 0,
        documentAnchorSteps: 0,
        documentBottomDwellSteps: 0,
        documentNoneSteps: 0,
        documentTargetMoves: 0,
        documentAnchorMoves: 0,
        documentBottomDwellMoves: 0,
        documentUnmovedSteps: 0,
        documentTargetDistancePx: 0,
        documentAnchorDistancePx: 0,
        documentBottomDwellDistancePx: 0,
        containerScrollSteps: 0,
        containersHandled: 0,
        containersScanned: 0,
        repeatContainers: 0,
        newSources: 0,
        newRawCandidates: 0,
        newBases: 0,
        queryVariants: 0,
        resolutionUpgrades: 0,
        newDomImages: 0,
        newTargets: 0,
        newGalleries: 0,
        fullSourceCollections: 0,
        deltaSourceCollections: 0,
        emptyDeltaCollections: 0,
        deltaRoots: 0
    });
    const scanPerformanceMetrics = createPerformanceMetrics();
    const edgeRangeWaits = [];
    const settleWaits = [];
    const passPerformanceRecords = [];
    let onlyFansScanner = null;
    const PHOTO_SWIPE_SLOW_CALL_THRESHOLD_MS = 250;
    const MAX_PHOTO_SWIPE_SLOW_CALLS = 12;
    const photoSwipeSlowCalls = [];
    // ✴️ NEW 2026-10-11: Aggregates labelled Carousel and PhotoSwipe waits.
    const photoSwipeWaitPurposeMetrics = new Map();
    const photoSwipeDetail = {
        totalCalls: 0,
        totalMs: 0,
        slowCalls: 0,
        maxCallMs: 0,
        direct: {calls: 0, totalMs: 0, maxCallMs: 0, discoveryMs: 0},
        generic: {
            calls: 0,
            totalMs: 0,
            maxCallMs: 0,
            discoveryMs: 0,
            nextStateOutcomes: {
                changed: 0,
                stableState: 0,
                controlDisabled: 0,
                controlUnavailable: 0
            }
        },
        rootReuse: {
            rootsSeen: 0,
            newRoots: 0,
            repeatedRootChecks: 0,
            changedRootChecks: 0,
            unchangedRootChecks: 0,
            alreadyProcessedRoots: 0
        },
        rootSizes: {
            slideElements: 0,
            mediaElements: 0,
            maxSlidesPerRoot: 0,
            maxMediaElementsPerRoot: 0
        },
        candidates: {
            total: 0,
            previouslySeen: 0,
            new: 0,
            directTargets: 0,
            previouslySeenTargets: 0,
            newTargets: 0
        },
        queries: {
            calls: 0,
            results: 0,
            allElementsCalls: 0,
            allElementsResults: 0,
            maxResultSize: 0
        },
        waits: {calls: 0, totalMs: 0, timeouts: 0, maxTimeoutOverrunMs: 0},
        phases: {}
    };
    let currentPassRecord = null;
    const addMetric = (metrics, name, value) => {
        if (!Number.isFinite(value)) return;

        if (metrics) metrics[name] = (metrics[name] ?? 0) + value;
        if (currentPassMetrics && currentPassMetrics !== metrics) {
            currentPassMetrics[name] = (currentPassMetrics[name] ?? 0) + value;
        }
        scanPerformanceMetrics[name] = (scanPerformanceMetrics[name] ?? 0) + value;
    };
    const recordCollectionMetric = (metrics, name, value) => addMetric(metrics, name, value);
    const roundPhotoSwipeValue = (value) => Number.isFinite(value) ? Math.round(value) : value;
    const addPhotoSwipeWaitPurposeMetrics = (waitPurposes = {}) => {
        Object.entries(waitPurposes).forEach(([purpose, metrics]) => {
            const summary = photoSwipeWaitPurposeMetrics.get(purpose) ?? {
                calls: 0,
                totalMs: 0,
                timeouts: 0,
                aborts: 0
            };
            summary.calls += metrics.calls;
            summary.totalMs += metrics.totalMs;
            summary.timeouts += metrics.timeouts;
            summary.aborts += metrics.aborts;
            photoSwipeWaitPurposeMetrics.set(purpose, summary);
        });
    };
    const getPhotoSwipeWaitPurposeSummary = () => Array.from(photoSwipeWaitPurposeMetrics.entries())
        .sort(([, first], [, second]) => second.totalMs - first.totalMs)
        .map(([purpose, metrics]) => `${purpose}: ${Math.round(metrics.totalMs)}ms, ` +
            `${metrics.calls} calls, ${metrics.timeouts} timeouts, ${metrics.aborts} aborts`)
        .join(' | ');
    const createSlowPhotoSwipeRecord = (detail, performanceMetrics) => ({
        callIndex: detail.callIndex,
        totalDurationMs: roundPhotoSwipeValue(performanceMetrics.scanPhotoSwipeMs),
        nonWaitDurationMs: roundPhotoSwipeValue(detail.nonWaitDurationMs),
        directPhotoSwipeMs: roundPhotoSwipeValue(performanceMetrics.directPhotoSwipeMs),
        genericCarouselMs: roundPhotoSwipeValue(performanceMetrics.genericCarouselMs),
        phases: Object.fromEntries(Object.entries(detail.phases).map(([name, durationMs]) => [
            name,
            roundPhotoSwipeValue(durationMs)
        ])),
        generic: {
            rootsConsidered: detail.generic.rootsConsidered,
            rootsPreviouslySeen: detail.generic.rootsPreviouslySeen,
            rootsNew: detail.generic.rootsNew,
            rootsRechecked: detail.generic.rootsRechecked,
            rootsChangedSincePreviousCall: detail.generic.rootsChangedSincePreviousCall,
            rootsUnchangedSincePreviousCall: detail.generic.rootsUnchangedSincePreviousCall,
            rootsAlreadyProcessed: detail.generic.rootsAlreadyProcessed,
            candidateCount: detail.generic.candidateCount,
            previouslySeenCandidates: detail.generic.previouslySeenCandidates,
            newCandidates: detail.generic.newCandidates,
            documentElementsScanned: detail.generic.documentElementsScanned,
            rootSlideElements: detail.generic.rootSlideElements,
            rootMediaElements: detail.generic.rootMediaElements,
            maxSlidesPerRoot: detail.generic.maxSlidesPerRoot,
            maxMediaElementsPerRoot: detail.generic.maxMediaElementsPerRoot,
            nextStateOutcomes: {...detail.generic.nextStateOutcomes},
            resultCount: detail.generic.resultCount
        },
        direct: {
            targetCount: detail.direct.targetCount,
            previouslySeenTargets: detail.direct.previouslySeenTargets,
            newTargets: detail.direct.newTargets,
            processedTargetsSkipped: detail.direct.processedTargetsSkipped,
            sourceDuplicatesSkipped: detail.direct.sourceDuplicatesSkipped,
            invisibleTargetsSkipped: detail.direct.invisibleTargetsSkipped,
            openModalChecks: detail.direct.openModalChecks,
            openModalSkips: detail.direct.openModalSkips,
            resultCount: detail.direct.resultCount
        },
        queries: {
            calls: detail.queries.calls,
            results: detail.queries.results,
            allElementsCalls: detail.queries.allElementsCalls,
            allElementsResults: detail.queries.allElementsResults,
            maxResultSize: detail.queries.maxResultSize,
            bySelector: Object.fromEntries(Object.entries(detail.queries.bySelector).map(
                ([selector, summary]) => [selector, {...summary}]
            ))
        },
        waits: {
            calls: detail.waits.calls,
            totalMs: roundPhotoSwipeValue(detail.waits.totalMs),
            timeoutCount: detail.waits.timeoutCount,
            maxTimeoutOverrunMs: roundPhotoSwipeValue(detail.waits.maxTimeoutOverrunMs)
        },
        resultsFound: detail.generic.resultCount + detail.direct.resultCount
    });
    const recordPhotoSwipePerformance = (performanceMetrics, phase = null) => {
        const detail = performanceMetrics?.detail;
        if (!detail) return;

        photoSwipeDetail.totalCalls += 1;
        photoSwipeDetail.totalMs += performanceMetrics.scanPhotoSwipeMs;
        photoSwipeDetail.maxCallMs = Math.max(
            photoSwipeDetail.maxCallMs,
            performanceMetrics.scanPhotoSwipeMs
        );
        photoSwipeDetail.direct.calls += performanceMetrics.directPhotoSwipeCalls;
        photoSwipeDetail.direct.totalMs += performanceMetrics.directPhotoSwipeMs;
        photoSwipeDetail.direct.maxCallMs = Math.max(
            photoSwipeDetail.direct.maxCallMs,
            performanceMetrics.directPhotoSwipeMs
        );
        photoSwipeDetail.direct.discoveryMs += detail.direct.discoveryMs;
        onlyFansScanner?.recordPhotoSwipePerformance(detail, phase);
        photoSwipeDetail.generic.calls += performanceMetrics.genericCarouselCalls;
        photoSwipeDetail.generic.totalMs += performanceMetrics.genericCarouselMs;
        photoSwipeDetail.generic.maxCallMs = Math.max(
            photoSwipeDetail.generic.maxCallMs,
            performanceMetrics.genericCarouselMs
        );
        photoSwipeDetail.generic.discoveryMs += detail.generic.discoveryMs;
        Object.keys(photoSwipeDetail.generic.nextStateOutcomes).forEach((name) => {
            photoSwipeDetail.generic.nextStateOutcomes[name] +=
                detail.generic.nextStateOutcomes[name];
        });
        photoSwipeDetail.rootReuse.newRoots += detail.generic.rootsNew;
        photoSwipeDetail.rootReuse.repeatedRootChecks += detail.generic.rootsRechecked;
        photoSwipeDetail.rootReuse.changedRootChecks += detail.generic.rootsChangedSincePreviousCall;
        photoSwipeDetail.rootReuse.unchangedRootChecks +=
            detail.generic.rootsUnchangedSincePreviousCall;
        photoSwipeDetail.rootReuse.alreadyProcessedRoots += detail.generic.rootsAlreadyProcessed;
        photoSwipeDetail.rootSizes.slideElements += detail.generic.rootSlideElements;
        photoSwipeDetail.rootSizes.mediaElements += detail.generic.rootMediaElements;
        photoSwipeDetail.rootSizes.maxSlidesPerRoot = Math.max(
            photoSwipeDetail.rootSizes.maxSlidesPerRoot,
            detail.generic.maxSlidesPerRoot
        );
        photoSwipeDetail.rootSizes.maxMediaElementsPerRoot = Math.max(
            photoSwipeDetail.rootSizes.maxMediaElementsPerRoot,
            detail.generic.maxMediaElementsPerRoot
        );
        photoSwipeDetail.candidates.total += detail.generic.candidateCount;
        photoSwipeDetail.candidates.previouslySeen += detail.generic.previouslySeenCandidates;
        photoSwipeDetail.candidates.new += detail.generic.newCandidates;
        photoSwipeDetail.candidates.directTargets += detail.direct.targetCount;
        photoSwipeDetail.candidates.previouslySeenTargets += detail.direct.previouslySeenTargets;
        photoSwipeDetail.candidates.newTargets += detail.direct.newTargets;
        photoSwipeDetail.queries.calls += detail.queries.calls;
        photoSwipeDetail.queries.results += detail.queries.results;
        photoSwipeDetail.queries.allElementsCalls += detail.queries.allElementsCalls;
        photoSwipeDetail.queries.allElementsResults += detail.queries.allElementsResults;
        photoSwipeDetail.queries.maxResultSize = Math.max(
            photoSwipeDetail.queries.maxResultSize,
            detail.queries.maxResultSize
        );
        photoSwipeDetail.waits.calls += detail.waits.calls;
        photoSwipeDetail.waits.totalMs += detail.waits.totalMs;
        photoSwipeDetail.waits.timeouts += detail.waits.timeoutCount;
        photoSwipeDetail.waits.maxTimeoutOverrunMs = Math.max(
            photoSwipeDetail.waits.maxTimeoutOverrunMs,
            detail.waits.maxTimeoutOverrunMs
        );
        addPhotoSwipeWaitPurposeMetrics(detail.waitPurposes);
        Object.entries(detail.phases).forEach(([name, durationMs]) => {
            const phase = photoSwipeDetail.phases[name] ?? {totalMs: 0, maxCallMs: 0};
            phase.totalMs += durationMs;
            phase.maxCallMs = Math.max(phase.maxCallMs, durationMs);
            photoSwipeDetail.phases[name] = phase;
        });

        if (performanceMetrics.scanPhotoSwipeMs < PHOTO_SWIPE_SLOW_CALL_THRESHOLD_MS) return;

        photoSwipeDetail.slowCalls += 1;
        photoSwipeSlowCalls.push(createSlowPhotoSwipeRecord(detail, performanceMetrics));
        photoSwipeSlowCalls.sort((first, second) => second.totalDurationMs - first.totalDurationMs);
        if (photoSwipeSlowCalls.length > MAX_PHOTO_SWIPE_SLOW_CALLS) photoSwipeSlowCalls.pop();
    };
    const recordEdgeRangeWait = ({scope, direction, container = null, durationMs, result}) => {
        edgeRangeWaits.push({
            scope,
            direction,
            ...(container ? {container} : {}),
            durationMs,
            endReason: result.endReason,
            rangeBefore: result.rangeBefore,
            rangeAfter: result.rangeAfter,
            rangeDelta: Number.isFinite(result.rangeBefore) && Number.isFinite(result.rangeAfter)
                ? result.rangeAfter - result.rangeBefore
                : null,
            relevantMutationCountBefore: result.relevantMutationCountBefore,
            relevantMutationCountAfter: result.relevantMutationCountAfter,
            lastRelevantMutationAgeMs: result.lastRelevantMutationAgeMs
        });
    };
    const createPerformanceSummary = (status) => {
        const onlyFansChatContainer = onlyFansScanner?.finalizeDiagnostics(
            photoSwipePerformanceState
        );
        const createEdgeRangeGrowthSummary = () => ({
            totalMs: 0,
            waits: 0,
            growths: 0,
            quietExits: 0,
            timeouts: 0,
            aborts: 0,
            unusable: 0,
            errors: 0
        });
        const addEdgeRangeWaitToSummary = (summary, wait) => {
            summary.totalMs += wait.durationMs;
            summary.waits += 1;
            const counter = {
                growth: 'growths',
                quiet: 'quietExits',
                timeout: 'timeouts',
                abort: 'aborts',
                unusable: 'unusable',
                error: 'errors'
            }[wait.endReason];
            if (counter) summary[counter] += 1;
        };
        const edgeRangeGrowth = createEdgeRangeGrowthSummary();
        const edgeRangeGrowthByScope = {
            document: createEdgeRangeGrowthSummary(),
            container: createEdgeRangeGrowthSummary()
        };
        const edgeRangeGrowthByDirection = {
            up: createEdgeRangeGrowthSummary(),
            down: createEdgeRangeGrowthSummary()
        };
        edgeRangeWaits.forEach((wait) => {
            addEdgeRangeWaitToSummary(edgeRangeGrowth, wait);
            addEdgeRangeWaitToSummary(edgeRangeGrowthByScope[wait.scope], wait);
            addEdgeRangeWaitToSummary(edgeRangeGrowthByDirection[wait.direction], wait);
        });
        const roundEdgeRangeGrowthSummary = (summary) => ({
            ...summary,
            totalMs: Math.round(summary.totalMs)
        });
        const createSettleSummary = () => ({
            totalMs: 0,
            waits: 0,
            quietExits: 0,
            maxTimeouts: 0,
            aborts: 0,
            noMutationWaits: 0,
            noMutationMs: 0,
            mutationWaits: 0,
            mutationMs: 0,
            mutationCount: 0,
            alreadyQuietWaits: 0,
            alreadyQuietMs: 0,
            minimumDelayMs: 0,
            beyondMinimumDelayMs: 0
        });
        // ✴️ NEW 2026-10-11: Separates mandatory settling time from waits justified by DOM activity.
        const addSettleWaitToSummary = (summary, wait) => {
            summary.totalMs += wait.durationMs;
            summary.waits += 1;
            const counter = {
                quiet: 'quietExits',
                'max-timeout': 'maxTimeouts',
                abort: 'aborts'
            }[wait.endReason];
            if (counter) summary[counter] += 1;

            const mutationDelta = Math.max(0, Number(wait.mutationDelta) || 0);
            const minimumDelayMs = Math.min(
                Math.max(0, Number(wait.durationMs) || 0),
                Math.max(0, Number(wait.minimumWaitMs) || 0)
            );
            summary.minimumDelayMs += minimumDelayMs;
            summary.beyondMinimumDelayMs += Math.max(0, wait.durationMs - minimumDelayMs);
            if (mutationDelta === 0) {
                summary.noMutationWaits += 1;
                summary.noMutationMs += wait.durationMs;
            } else {
                summary.mutationWaits += 1;
                summary.mutationMs += wait.durationMs;
                summary.mutationCount += mutationDelta;
            }

            if (wait.lastRelevantMutationAgeAtStart >= wait.quietTargetMs) {
                summary.alreadyQuietWaits += 1;
                summary.alreadyQuietMs += wait.durationMs;
            }
        };
        const settle = createSettleSummary();
        const settleByScope = {
            document: createSettleSummary(),
            container: createSettleSummary(),
            final: createSettleSummary()
        };
        const settleByDirection = {
            up: createSettleSummary(),
            down: createSettleSummary()
        };
        const settleDurationBuckets = {
            '<250': 0,
            '250-499': 0,
            '500-749': 0,
            '750-999': 0,
            '1000-1249': 0,
            '1250-1499': 0,
            '>=1500': 0
        };
        const getSettleDurationBucket = (durationMs) => {
            if (durationMs < 250) return '<250';
            if (durationMs < 500) return '250-499';
            if (durationMs < 750) return '500-749';
            if (durationMs < 1000) return '750-999';
            if (durationMs < 1250) return '1000-1249';
            if (durationMs < 1500) return '1250-1499';
            return '>=1500';
        };
        // ✴️ NEW 2026-10-11: Shows how long lazy DOM work takes to begin after a scroll action.
        const firstMutationDelay = {
            waits: 0,
            totalMs: 0,
            maxMs: 0,
            below50Ms: 0,
            from50To99Ms: 0,
            from100To149Ms: 0,
            from150To249Ms: 0,
            from250To349Ms: 0,
            from350Ms: 0
        };
        const getFirstMutationDelayBucket = (delayMs) => {
            if (delayMs < 50) return 'below50Ms';
            if (delayMs < 100) return 'from50To99Ms';
            if (delayMs < 150) return 'from100To149Ms';
            if (delayMs < 250) return 'from150To249Ms';
            if (delayMs < 350) return 'from250To349Ms';
            return 'from350Ms';
        };
        settleWaits.forEach((wait) => {
            addSettleWaitToSummary(settle, wait);
            addSettleWaitToSummary(settleByScope[wait.scope], wait);
            if (wait.direction) addSettleWaitToSummary(settleByDirection[wait.direction], wait);
            settleDurationBuckets[getSettleDurationBucket(wait.durationMs)] += 1;

            if (!Number.isFinite(wait.firstMutationDelayMs)) return;

            firstMutationDelay.waits += 1;
            firstMutationDelay.totalMs += wait.firstMutationDelayMs;
            firstMutationDelay.maxMs = Math.max(
                firstMutationDelay.maxMs,
                wait.firstMutationDelayMs
            );
            firstMutationDelay[
                getFirstMutationDelayBucket(wait.firstMutationDelayMs)
            ] += 1;
        });
        const roundSettleSummary = (summary) => ({
            ...summary,
            totalMs: Math.round(summary.totalMs),
            noMutationMs: Math.round(summary.noMutationMs),
            mutationMs: Math.round(summary.mutationMs),
            alreadyQuietMs: Math.round(summary.alreadyQuietMs),
            minimumDelayMs: Math.round(summary.minimumDelayMs),
            beyondMinimumDelayMs: Math.round(summary.beyondMinimumDelayMs)
        });
        const totalMs = Math.max(0, performance.now() - startedAtPerformance);
        const documentTraversalMs = scanPerformanceMetrics.documentUpMs +
            scanPerformanceMetrics.documentDownMs;
        const containerWorkMs = scanPerformanceMetrics.containerDetectionMs +
            scanPerformanceMetrics.containerAnalysisMs +
            scanPerformanceMetrics.containerTraversalMs;
        const initialAndFinalMs = scanPerformanceMetrics.initialCollectionMs +
            scanPerformanceMetrics.finalSettleMs + scanPerformanceMetrics.finalCollectionMs;
        const accountedExclusiveMs = scanPerformanceMetrics.readinessWaitMs +
            documentTraversalMs + containerWorkMs + initialAndFinalMs;
        const exclusive = {
            readinessMs: Math.round(scanPerformanceMetrics.readinessWaitMs),
            initialAndFinalMs: Math.round(initialAndFinalMs),
            documentTraversalMs: Math.round(documentTraversalMs),
            containerWorkMs: Math.round(containerWorkMs),
            otherMs: Math.round(Math.max(0, totalMs - accountedExclusiveMs))
        };
        const toPercent = (value) => totalMs > 0 ? Math.round(value * 100 / totalMs) : 0;
        const passRecords = passPerformanceRecords.map((record) => ({
            pass: record.pass,
            startPosition: record.startPosition,
            endPosition: record.endPosition,
            durationMs: Math.round(record.durationMs),
            documentUpMs: Math.round(record.metrics.documentUpMs),
            documentDownMs: Math.round(record.metrics.documentDownMs),
            containerMs: Math.round(
                record.metrics.containerDetectionMs + record.metrics.containerAnalysisMs +
                record.metrics.containerTraversalMs
            ),
            finalCollectionMs: Math.round(record.metrics.finalCollectionMs),
            repeatReason: record.repeatReason
        }));
        const photoSwipeSummary = {
            ...photoSwipeDetail,
            // ✴️ NEW 2026-10-14: Kept flat so DebugLogger can export the values without max-depth truncation.
            genericNextStateOutcomes: {...photoSwipeDetail.generic.nextStateOutcomes},
            waitPurposeSummary: getPhotoSwipeWaitPurposeSummary(),
            totalMs: roundPhotoSwipeValue(photoSwipeDetail.totalMs),
            maxCallMs: roundPhotoSwipeValue(photoSwipeDetail.maxCallMs),
            direct: {
                ...photoSwipeDetail.direct,
                totalMs: roundPhotoSwipeValue(photoSwipeDetail.direct.totalMs),
                maxCallMs: roundPhotoSwipeValue(photoSwipeDetail.direct.maxCallMs),
                discoveryMs: roundPhotoSwipeValue(photoSwipeDetail.direct.discoveryMs)
            },
            generic: {
                ...photoSwipeDetail.generic,
                totalMs: roundPhotoSwipeValue(photoSwipeDetail.generic.totalMs),
                maxCallMs: roundPhotoSwipeValue(photoSwipeDetail.generic.maxCallMs),
                discoveryMs: roundPhotoSwipeValue(photoSwipeDetail.generic.discoveryMs)
            },
            rootReuse: {
                ...photoSwipeDetail.rootReuse,
                rootsSeen: photoSwipePerformanceState.genericRoots.size
            },
            waits: {
                ...photoSwipeDetail.waits,
                totalMs: roundPhotoSwipeValue(photoSwipeDetail.waits.totalMs),
                maxTimeoutOverrunMs: roundPhotoSwipeValue(
                    photoSwipeDetail.waits.maxTimeoutOverrunMs
                )
            },
            phases: Object.fromEntries(Object.entries(photoSwipeDetail.phases).map(
                ([name, phase]) => [name, {
                    totalMs: roundPhotoSwipeValue(phase.totalMs),
                    maxCallMs: roundPhotoSwipeValue(phase.maxCallMs)
                }]
            )),
            rootChangeTracking: 'Changed light-DOM subtrees and image loads are scanned incrementally; ' +
                'pending generic Carousels additionally observe their own state attributes. Other ' +
                'class/style-only changes and newly attached open shadow roots remain covered by ' +
                'the final full scan.'
        };
        // ✴️ NEW 2026-10-12: Keeps the scroll-plan result flat so debug-log export preserves every counter.
        const documentScroll = {
            targetSteps: scanPerformanceMetrics.documentTargetSteps,
            targetMoves: scanPerformanceMetrics.documentTargetMoves,
            targetDistancePx: Math.round(scanPerformanceMetrics.documentTargetDistancePx),
            targetAverageDistancePx: scanPerformanceMetrics.documentTargetMoves > 0
                ? Math.round(
                    scanPerformanceMetrics.documentTargetDistancePx /
                    scanPerformanceMetrics.documentTargetMoves
                )
                : 0,
            anchorSteps: scanPerformanceMetrics.documentAnchorSteps,
            anchorMoves: scanPerformanceMetrics.documentAnchorMoves,
            anchorDistancePx: Math.round(scanPerformanceMetrics.documentAnchorDistancePx),
            anchorAverageDistancePx: scanPerformanceMetrics.documentAnchorMoves > 0
                ? Math.round(
                    scanPerformanceMetrics.documentAnchorDistancePx /
                    scanPerformanceMetrics.documentAnchorMoves
                )
                : 0,
            bottomDwellSteps: scanPerformanceMetrics.documentBottomDwellSteps,
            bottomDwellMoves: scanPerformanceMetrics.documentBottomDwellMoves,
            bottomDwellDistancePx: Math.round(
                scanPerformanceMetrics.documentBottomDwellDistancePx
            ),
            bottomDwellAverageDistancePx: scanPerformanceMetrics.documentBottomDwellMoves > 0
                ? Math.round(
                    scanPerformanceMetrics.documentBottomDwellDistancePx /
                    scanPerformanceMetrics.documentBottomDwellMoves
                )
                : 0,
            noActionSteps: scanPerformanceMetrics.documentNoneSteps,
            unmovedSteps: scanPerformanceMetrics.documentUnmovedSteps
        };

        return {
            status,
            totalMs: Math.round(totalMs),
            passes: passRecords,
            exclusive: {
                ...exclusive,
                percentages: Object.fromEntries(Object.entries(exclusive).map(([name, value]) => [
                    name,
                    toPercent(value)
                ]))
            },
            nestedTimings: {
                collectSourcesMs: Math.round(scanPerformanceMetrics.collectSourcesMs),
                scanImagesMs: Math.round(scanPerformanceMetrics.scanImagesMs),
                scanImagesCalls: scanPerformanceMetrics.scanImagesCalls,
                scanPhotoSwipeMs: Math.round(scanPerformanceMetrics.scanPhotoSwipeMs),
                scanPhotoSwipeCalls: scanPerformanceMetrics.scanPhotoSwipeCalls,
                genericCarouselMs: Math.round(scanPerformanceMetrics.genericCarouselMs),
                genericCarouselCalls: scanPerformanceMetrics.genericCarouselCalls,
                directPhotoSwipeMs: Math.round(scanPerformanceMetrics.directPhotoSwipeMs),
                directPhotoSwipeCalls: scanPerformanceMetrics.directPhotoSwipeCalls,
                photoSwipeOtherMs: Math.round(scanPerformanceMetrics.photoSwipeOtherMs),
                containerDetectionMs: Math.round(scanPerformanceMetrics.containerDetectionMs),
                containerAnalysisMs: Math.round(scanPerformanceMetrics.containerAnalysisMs),
                containerTraversalMs: Math.round(scanPerformanceMetrics.containerTraversalMs),
                scrollActionMs: Math.round(scanPerformanceMetrics.scrollActionMs),
                settleMs: Math.round(scanPerformanceMetrics.settleMs),
                edgeRangeGrowthMs: Math.round(scanPerformanceMetrics.edgeRangeGrowthMs),
                candidatePipelineMs: Math.round(scanPerformanceMetrics.candidatePipelineMs),
                batchDispatchMs: Math.round(scanPerformanceMetrics.batchDispatchMs)
            },
            domDelta: domState.getMetrics(),
            documentScroll,
            ...(collectContainerDiagnostics ? {onlyFansChatContainer} : {}),
            photoSwipeDetail: photoSwipeSummary,
            photoSwipeSlowCalls,
            edgeRangeGrowth: {
                ...roundEdgeRangeGrowthSummary(edgeRangeGrowth),
                byScope: Object.fromEntries(Object.entries(edgeRangeGrowthByScope).map(
                    ([scope, summary]) => [scope, roundEdgeRangeGrowthSummary(summary)]
                )),
                byDirection: Object.fromEntries(Object.entries(edgeRangeGrowthByDirection).map(
                    ([direction, summary]) => [direction, roundEdgeRangeGrowthSummary(summary)]
                ))
            },
            settle: {
                ...roundSettleSummary(settle),
                byScope: Object.fromEntries(Object.entries(settleByScope).map(
                    ([scope, summary]) => [scope, roundSettleSummary(summary)]
                )),
                byDirection: Object.fromEntries(Object.entries(settleByDirection).map(
                    ([direction, summary]) => [direction, roundSettleSummary(summary)]
                )),
                durationBuckets: settleDurationBuckets,
                firstMutationDelay: {
                    ...firstMutationDelay,
                    totalMs: Math.round(firstMutationDelay.totalMs),
                    averageMs: firstMutationDelay.waits > 0
                        ? Math.round(firstMutationDelay.totalMs / firstMutationDelay.waits)
                        : 0,
                    maxMs: Math.round(firstMutationDelay.maxMs)
                }
            },
            counters: {
                collectSourcesCalls: scanPerformanceMetrics.collectSourcesCalls,
                rawCandidates: scanPerformanceMetrics.rawCandidates,
                afterDedupe: scanPerformanceMetrics.dedupedCandidates,
                newBases: scanPerformanceMetrics.newBases,
                queryVariants: scanPerformanceMetrics.queryVariants,
                resolutionUpgrades: scanPerformanceMetrics.resolutionUpgrades,
                batches: scanPerformanceMetrics.batches,
                documentUpSteps: scanPerformanceMetrics.documentUpSteps,
                documentDownSteps: scanPerformanceMetrics.documentDownSteps,
                containerScrollSteps: scanPerformanceMetrics.containerScrollSteps,
                containersHandled: scanPerformanceMetrics.containersHandled,
                containersScanned: scanPerformanceMetrics.containersScanned,
                repeatContainers: scanPerformanceMetrics.repeatContainers,
                fullSourceCollections: scanPerformanceMetrics.fullSourceCollections,
                deltaSourceCollections: scanPerformanceMetrics.deltaSourceCollections,
                emptyDeltaCollections: scanPerformanceMetrics.emptyDeltaCollections,
                deltaRoots: scanPerformanceMetrics.deltaRoots
            },
            note: 'Exclusive percentages use only non-overlapping top-level phases; nested timings overlap with document/container traversal.'
        };
    };
    const wait = (milliseconds) => new Promise((resolve) => {
        if (signal?.aborted) {
            resolve(false);
            return;
        }

        let timeout = null;
        const finish = (completed) => {
            clearTimeout(timeout);
            signal?.removeEventListener?.('abort', onAbort);
            resolve(completed);
        };
        const onAbort = () => finish(false);

        timeout = setTimeout(() => finish(true), Math.max(0, milliseconds));
        signal?.addEventListener?.('abort', onAbort, {once: true});
    });
    const getTargetElements = () => Array.from(document.querySelectorAll([
        'img',
        'video',
        '[loading="lazy"]',
        '[data-src]',
        '[data-srcset]',
        '[data-lazy-src]',
        '[data-lazy-srcset]',
        '[data-image]',
        '[data-image-src]',
        '[data-full]',
        '[data-full-src]',
        '[data-fullsize]',
        '[data-large]',
        '[data-original]',
        '[data-lightbox-src]'
    ].join(',')));
    // ✴️ NEW 2026-10-14: Removes target nodes no longer present in virtualized documents.
    const getKnownTargets = () => {
        const targets = [];

        knownTargets.forEach((elm) => {
            if (elm?.isConnected === true) {
                targets.push(elm);
            } else {
                knownTargets.delete(elm);
            }
        });
        return targets;
    };
    // ✏️ EDIT 2026-10-14: Avoids rediscovering all document targets without DOM activity.
    const registerTargets = () => {
        if (!targetDiscoveryDirty) return 0;

        let added = 0;

        getTargetElements().forEach((elm) => {
            if (knownTargets.has(elm)) return;

            knownTargets.add(elm);
            added += 1;
        });
        targetDiscoveryDirty = false;
        return added;
    };
    const getCandidateURLClass = (candidateURL) => {
        try {
            const url = new URL(candidateURL);
            const base = url.protocol === 'data:' || url.protocol === 'blob:'
                ? candidateURL
                : `${url.origin}${url.pathname}`;
            const knownVariants = seenCandidateURLsByBase.get(base);

            return {
                base,
                baseKnown: (knownVariants?.size ?? 0) > 0,
                queryVariant: Boolean(knownVariants?.size && url.search)
            };
        } catch {
            return {
                base: candidateURL,
                baseKnown: false,
                queryVariant: false
            };
        }
    };
    const waitForSettle = async ({
        minimumMs = minimumSettleMs,
        scope = 'document',
        direction = null,
        phase = scope
    } = {}) => {
        const settleStartedAt = Date.now();
        // ✴️ NEW 2026-10-11: Records the first post-scroll DOM activity for an adaptive settle threshold.
        const settleActivity = {firstMutationAt: null};
        activeSettleWait = settleActivity;
        const relevantMutationCountBefore = relevantMutationCount;
        // ✴️ NEW 2026-10-11: Retains whether this wait began before or after the last relevant DOM activity.
        const lastRelevantMutationAgeAtStart = Math.max(
            0,
            settleStartedAt - lastRelevantMutationAt
        );
        const effectiveMinimumMs = Math.max(0, Math.min(minimumMs, maximumSettleMs));
        const maximumWaitMs = Math.max(effectiveMinimumMs, maximumSettleMs);
        const settleDeadline = settleStartedAt + maximumWaitMs;
        const finishSettleWait = (settled, endReason) => {
            if (activeSettleWait === settleActivity) activeSettleWait = null;
            const lastRelevantMutationAgeMs = Math.max(0, Date.now() - lastRelevantMutationAt);
            settleWaits.push({
                scope,
                ...(direction ? {direction} : {}),
                phase,
                durationMs: Date.now() - settleStartedAt,
                minimumWaitMs: effectiveMinimumMs,
                quietTargetMs: quietSettleMs,
                maximumWaitMs,
                endReason,
                relevantMutationCountBefore,
                relevantMutationCountAfter: relevantMutationCount,
                mutationDelta: relevantMutationCount - relevantMutationCountBefore,
                firstMutationDelayMs: settleActivity.firstMutationAt === null
                    ? null
                    : Math.max(0, settleActivity.firstMutationAt - settleStartedAt),
                lastRelevantMutationAgeAtStart,
                lastRelevantMutationAt,
                lastRelevantMutationAgeMs
            });
            return settled;
        };

        if (!(await wait(effectiveMinimumMs))) {
            return finishSettleWait(false, 'abort');
        }
        while (isActive() && Date.now() < settleDeadline) {
            const quietForMs = Date.now() - lastRelevantMutationAt;
            if (quietForMs >= quietSettleMs) return finishSettleWait(true, 'quiet');

            const remainingQuietMs = quietSettleMs - quietForMs;
            const remainingTotalMs = settleDeadline - Date.now();
            if (!(await wait(Math.min(50, remainingQuietMs, remainingTotalMs)))) {
                return finishSettleWait(false, 'abort');
            }
        }
        const stillActive = isActive();
        return finishSettleWait(stillActive, stillActive ? 'max-timeout' : 'abort');
    };
    // ✏️ EDIT 2026-10-16: Accepts pre-trigger rangeBefore so growth during async loader calls is caught.
    const waitForEdgeRangeGrowth = async (getRange, isUsable = () => true, initialRange = null) => {
        const waitStartedAt = Date.now();
        const relevantMutationCountBefore = relevantMutationCount;
        const wasQuietAtStart = waitStartedAt - lastRelevantMutationAt >= quietSettleMs;
        const createResult = (grew, endReason, rangeBefore, rangeAfter) => ({
            grew,
            endReason,
            rangeBefore,
            rangeAfter,
            relevantMutationCountBefore,
            relevantMutationCountAfter: relevantMutationCount,
            lastRelevantMutationAgeMs: Math.max(0, Date.now() - lastRelevantMutationAt)
        });
        let rangeBefore;
        let rangeAfter = null;
        try {
            const currentRange = getRange();
            rangeBefore = Number.isFinite(initialRange) ? initialRange : currentRange;
            rangeAfter = currentRange;
            if (rangeAfter > rangeBefore) {
                return createResult(true, 'growth', rangeBefore, rangeAfter);
            }
        } catch {
            return createResult(false, 'error', null, null);
        }

        const deadline = Date.now() + edgeLoadWaitMs;
        const quietConfirmationDeadline = wasQuietAtStart
            ? Math.min(deadline, waitStartedAt + maximumSettleMs)
            : null;
        while (isActive() && isUsable() && Date.now() < deadline) {
            const nextWaitMs = Math.min(
                edgeLoadPollMs,
                deadline - Date.now(),
                quietConfirmationDeadline === null
                    ? Infinity
                    : quietConfirmationDeadline - Date.now()
            );
            if (!(await wait(nextWaitMs))) {
                return createResult(false, 'abort', rangeBefore, rangeAfter);
            }

            try {
                rangeAfter = getRange();
                if (rangeAfter > rangeBefore) {
                    return createResult(true, 'growth', rangeBefore, rangeAfter);
                }
            } catch {
                return createResult(false, 'error', rangeBefore, null);
            }

            if (quietConfirmationDeadline !== null &&
                relevantMutationCount === relevantMutationCountBefore &&
                Date.now() >= quietConfirmationDeadline) {
                return createResult(false, 'quiet', rangeBefore, rangeAfter);
            }
        }

        const endReason = !isActive()
            ? 'abort'
            : Date.now() < deadline
                ? 'unusable'
                : 'timeout';
        return createResult(false, endReason, rangeBefore, rangeAfter);
    };
    const collectSources = async ({
        metrics = null,
        phase = 'delta',
        roots = null,
        traverseCarousel = true,
        skipDirectZoom = false
    } = {}) => {
        if (!isActive()) return 0;

        recordCollectionMetric(metrics, 'collectSourcesCalls', 1);
        const collectionScope = Array.isArray(roots)
            ? {
                phase,
                roots: roots.filter((root) => root?.isConnected),
                dirtyGenericRoots: new Set()
            }
            : domState.consumeScope(phase);
        if (collectionScope.phase === 'delta') {
            recordCollectionMetric(metrics, 'deltaSourceCollections', 1);
            recordCollectionMetric(metrics, 'deltaRoots', collectionScope.roots.length);
            if (collectionScope.roots.length === 0 && collectionScope.dirtyGenericRoots.size === 0) {
                recordCollectionMetric(metrics, 'emptyDeltaCollections', 1);
                return 0;
            }
        } else {
            recordCollectionMetric(metrics, 'fullSourceCollections', 1);
        }

        const collectionStartedAt = performance.now();
        const scanImagesStartedAt = performance.now();
        const foundCandidates = await scanImages(
            true,
            true,
            null,
            true,
            collectionScope.roots
        );
        const scanImagesMs = performance.now() - scanImagesStartedAt;
        recordCollectionMetric(metrics, 'scanImagesCalls', 1);
        const carouselStartedAt = performance.now();
        const photoSwipeRoots = Array.from(new Set([
            ...collectionScope.roots,
            ...collectionScope.dirtyGenericRoots
        ]));
        const onlyFansPhotoSwipeOptions = onlyFansScanner?.getPhotoSwipeOptions() ?? {};
        const photoSwipeCandidates = await scanPhotoSwipeImages({
            carouselScanner,
            photoSwipeScanner,
            performanceState: photoSwipePerformanceState,
            signal,
            onCarouselDiagnostic: (event, ...details) => {
                if (event === 'CAROUSEL' && details.includes('discovered')) {
                    recordCollectionMetric(metrics, 'newGalleries', 1);
                }
            },
            onActivity: () => {
                photoSwipeActivityCount += 1;
            },
            onPerformance: (performanceMetrics) => {
                recordPhotoSwipePerformance(performanceMetrics, collectionScope.phase);
                recordCollectionMetric(metrics, 'scanPhotoSwipeMs', performanceMetrics.scanPhotoSwipeMs);
                recordCollectionMetric(metrics, 'genericCarouselMs', performanceMetrics.genericCarouselMs);
                recordCollectionMetric(metrics, 'genericCarouselCalls', performanceMetrics.genericCarouselCalls);
                recordCollectionMetric(metrics, 'directPhotoSwipeMs', performanceMetrics.directPhotoSwipeMs);
                recordCollectionMetric(metrics, 'directPhotoSwipeCalls', performanceMetrics.directPhotoSwipeCalls);
                recordCollectionMetric(metrics, 'photoSwipeOtherMs', performanceMetrics.otherMs);
            },
            traverseCarousel,
            skipGenericCarousel: onlyFansPhotoSwipeOptions.skipGenericCarousel === true,
            skipDirectZoom,
            fallbackToOpenCarouselOnCloseFailure:
                onlyFansPhotoSwipeOptions.fallbackToOpenCarouselOnCloseFailure === true,
            shouldSkipDirectTarget: (target) =>
                onlyFansScanner?.shouldSkipGenericPhotoSwipeTarget(
                    target,
                    collectionScope.phase
                ) === true,
            allowRecycledDirectTargets:
                collectionScope.phase === 'of-virtual-swiper-slide',
            requestMainWorldPhotoSwipeClose:
                onlyFansPhotoSwipeOptions.requestMainWorldPhotoSwipeClose ?? null,
            scanRoots: photoSwipeRoots,
            dirtyGenericRoots: collectionScope.dirtyGenericRoots,
            registerGenericRoot: (root) => domState.registerGenericRoot(root),
            markGenericRootProcessed: (root) => domState.markGenericRootProcessed(root),
            registerPendingGenericRoot: (root) => domState.registerPendingGenericRoot(root),
            markGenericRootReady: (root) => domState.markGenericRootReady(root),
            registerDirectTarget: (target) => domState.registerDirectTarget(target)
        });
        const carouselPhotoSwipeMs = performance.now() - carouselStartedAt;
        recordCollectionMetric(metrics, 'scanPhotoSwipeCalls', 1);
        const candidatePipelineStartedAt = performance.now();
        const newCandidates = [];
        const candidateClasses = {
            newBases: 0,
            queryVariants: 0,
            resolutionUpgrades: 0
        };
        recordCollectionMetric(
            metrics,
            'rawCandidates',
            foundCandidates.length + photoSwipeCandidates.length
        );

        for (const candidate of [...foundCandidates, ...photoSwipeCandidates]) {
            if (typeof candidate?.url !== 'string') continue;

            const serializedCandidate = {
                url: candidate.url,
                width: Number.isFinite(candidate.width) ? Math.max(0, candidate.width) : 0,
                height: Number.isFinite(candidate.height) ? Math.max(0, candidate.height) : 0,
                source: candidate.source,
                visuallyBlurred: candidate.visuallyBlurred === true,
                ...(typeof candidate.mimeType === 'string' ? {mimeType: candidate.mimeType} : {}),
                ...(Number.isFinite(candidate.fileSize) ? {fileSize: candidate.fileSize} : {})
            };
            const previousCandidate = seenCandidatesByURL.get(serializedCandidate.url);
            const previousPixels = (previousCandidate?.width ?? 0) * (previousCandidate?.height ?? 0);
            const currentPixels = serializedCandidate.width * serializedCandidate.height;
            const isHigherResolution = currentPixels > previousPixels;

            if (previousCandidate && !isHigherResolution) continue;

            const candidateClass = getCandidateURLClass(serializedCandidate.url);
            if (previousCandidate) {
                candidateClasses.resolutionUpgrades += 1;
            } else if (candidateClass.baseKnown && candidateClass.queryVariant) {
                candidateClasses.queryVariants += 1;
            } else if (!candidateClass.baseKnown) {
                candidateClasses.newBases += 1;
            }

            const variants = seenCandidateURLsByBase.get(candidateClass.base) ?? new Set();
            variants.add(serializedCandidate.url);
            seenCandidateURLsByBase.set(candidateClass.base, variants);
            seenCandidatesByURL.set(serializedCandidate.url, serializedCandidate);
            newCandidates.push(serializedCandidate);
        }
        recordCollectionMetric(metrics, 'dedupedCandidates', newCandidates.length);
        recordCollectionMetric(metrics, 'newBases', candidateClasses.newBases);
        recordCollectionMetric(metrics, 'queryVariants', candidateClasses.queryVariants);
        recordCollectionMetric(metrics, 'resolutionUpgrades', candidateClasses.resolutionUpgrades);
        if (newCandidates.length > 0) {
            recordCollectionMetric(metrics, 'newSources', newCandidates.length);
            recordCollectionMetric(metrics, 'newRawCandidates', newCandidates.length);
        }
        if (newCandidates.length > 0 && typeof onBatch === 'function' && isActive()) {
            const batchDispatchStartedAt = performance.now();
            await onBatch(newCandidates);
            const batchDispatchMs = performance.now() - batchDispatchStartedAt;
            recordCollectionMetric(metrics, 'batchDispatchMs', batchDispatchMs);
            recordCollectionMetric(metrics, 'batches', 1);
        }
        const candidatePipelineMs = performance.now() - candidatePipelineStartedAt;
        const collectionMs = performance.now() - collectionStartedAt;
        recordCollectionMetric(metrics, 'scanImagesMs', scanImagesMs);
        recordCollectionMetric(metrics, 'carouselPhotoSwipeMs', carouselPhotoSwipeMs);
        recordCollectionMetric(metrics, 'candidatePipelineMs', candidatePipelineMs);
        recordCollectionMetric(metrics, 'collectSourcesMs', collectionMs);
        return newCandidates.length;
    };
    const markKnownGenericRootsChanged = (record) => {
        photoSwipePerformanceState.mutationVersion += 1;
        const mutationVersion = photoSwipePerformanceState.mutationVersion;
        const markAncestors = (node) => {
            let current = node?.nodeType === Node.ELEMENT_NODE
                ? node
                : node?.parentElement ?? null;
            while (current) {
                const rootState = photoSwipePerformanceState.genericRoots.get(current);
                if (rootState) rootState.lastMutationVersion = mutationVersion;
                current = current.parentElement ?? current.getRootNode?.().host ?? null;
            }
        };

        markAncestors(record.target);
        if (record.type !== 'childList') return;

        [...record.addedNodes ?? [], ...record.removedNodes ?? []].forEach((node) => {
            const rootState = photoSwipePerformanceState.genericRoots.get(node);
            if (rootState) rootState.lastMutationVersion = mutationVersion;
        });
    };
    // ✏️ EDIT 2026-10-16: Ensures OnlyFans chat containers are always recognized as scrollable.
    const isRelevantScrollableContainer = (element) => {
        if (!element || element === document.documentElement || element === document.body) return false;

        return onlyFansScanner?.isRelevantScrollableContainer(element) === true ||
            ContainerAnalyser.getScrollInfo(element).verticallyScrollable;
    };
    const getRelevantContainerCandidates = () => {
        const detectionStartedAt = performance.now();
        const candidates = new Map();
        const examinedElements = new WeakSet();

        getTargetElements().forEach((element) => {
            let parent = element.parentElement;
            while (parent && parent !== document.body && parent !== document.documentElement) {
                if (!examinedElements.has(parent)) {
                    examinedElements.add(parent);
                    const isScrollable = isRelevantScrollableContainer(parent);
                    const isStructural = ContainerAnalyser.isPlausibleStructureContainer(parent);
                    if (isScrollable || isStructural) {
                        candidates.set(parent, {container: parent, isScrollable, isStructural});
                    }
                }
                parent = parent.parentElement;
            }
        });

        const sortedCandidates = Array.from(candidates.values()).sort((first, second) => {
            if (first.container.contains(second.container)) return 1;
            if (second.container.contains(first.container)) return -1;
            return 0;
        });
        addMetric(null, 'containerDetectionMs', performance.now() - detectionStartedAt);
        return sortedCandidates;
    };
    const getContainerMetrics = (container) => {
        const targets = getTargetElements().filter((element) => container.contains(element));
        const {geometry} = ContainerAnalyser.getScrollInfo(container);

        return {
            scrollTop: geometry.scrollTop,
            scrollHeight: geometry.scrollHeight,
            clientHeight: geometry.clientHeight,
            images: container.querySelectorAll('img').length,
            targets: targets.length
        };
    };
    if (window.location.hostname.endsWith('onlyfans.com')) {
        onlyFansScanner = new OnlyFansScanner({
            signal,
            collectDiagnostics: collectContainerDiagnostics,
            getCurrentPass: () => currentPassRecord,
            markPageActivity: () => {
                lastRelevantMutationAt = Date.now();
            }
        });
    }
    const containerAnalyses = new WeakMap();
    const isInsideLowPriorityStructureContainer = (element) => {
        let current = element;
        while (current && current !== document.body && current !== document.documentElement) {
            if (lowPriorityStructureContainers.has(current)) return true;
            current = current.parentElement;
        }
        return false;
    };
    const getContainerTraversalState = (container) => {
        const metrics = getContainerMetrics(container);
        return [metrics.scrollHeight, metrics.clientHeight].join(':');
    };
    const getPendingRelevantContainerCandidates = () => {
        completedScrollContainerStates.forEach((_state, container) => {
            if (!container.isConnected) completedScrollContainerStates.delete(container);
        });

        return getRelevantContainerCandidates().filter((candidate) => candidate.isScrollable
            ? completedScrollContainerStates.get(candidate.container) !==
                getContainerTraversalState(candidate.container)
            : !handledStructureContainers.has(candidate.container));
    };
    const synchronizeCompletedScrollContainerStates = () => {
        getRelevantContainerCandidates().forEach(({container, isScrollable}) => {
            if (!isScrollable || !completedScrollContainerStates.has(container)) return;

            completedScrollContainerStates.set(container, getContainerTraversalState(container));
        });
    };
    const getScrollContainerIndex = (container) => {
        if (!knownScrollContainerIndices.has(container)) {
            knownScrollContainerIndices.set(container, knownScrollContainerIndices.size);
        }

        return knownScrollContainerIndices.get(container);
    };
    const getContainerAnalysis = (container) => {
        if (!containerAnalyses.has(container)) {
            const analysisStartedAt = performance.now();
            try {
                containerAnalyses.set(container, ContainerAnalyser.analyze(container, {
                    minimumImageWidth,
                    minimumImageHeight
                }));
            } finally {
                addMetric(null, 'containerAnalysisMs', performance.now() - analysisStartedAt);
            }
        }
        return containerAnalyses.get(container);
    };
    const createContainerPlan = (candidates) => {
        const entries = candidates.map(({container, isScrollable, isStructural}) => {
            const isNewContainer = !knownScrollContainerIndices.has(container);
            getScrollContainerIndex(container);
            const analysis = getContainerAnalysis(container);
            const priority = onlyFansScanner?.matchesChatContainer(container)
                ? 'high'
                : analysis.priority;
            return {
                container,
                analysis,
                priority,
                isNewContainer,
                isScrollable,
                isStructural
            };
        });
        const high = entries.filter((entry) => entry.priority === 'high');
        const medium = entries.filter((entry) => entry.priority === 'medium');
        const low = entries.filter((entry) => entry.priority === 'low');
        const analysisOnly = entries.filter((entry) => !entry.isScrollable);
        const skipped = skipLowPriorityContainers ? low.filter((entry) => entry.isScrollable) : [];
        const scanEntries = (skipLowPriorityContainers
            ? [...high, ...medium]
            : [...high, ...medium, ...low]
        ).filter((entry) => entry.isScrollable);

        return {entries, high, medium, low, analysisOnly, skipped, scanEntries};
    };
    const logPassSummary = (pass, metrics, durationMs, repeat, repeatReasons, newContainers) => {
        console.info(
            '[DeepScan PASS SUMMARY]',
            `pass=${pass}`,
            `durationMs=${Math.round(durationMs)}`,
            `newSources=${metrics.newSources}`,
            `rawCandidates=${metrics.newRawCandidates}`,
            `newImages=${metrics.newDomImages}`,
            `newContainers=${newContainers}`,
            `containersHandled=${metrics.containersHandled}`,
            `containersScanned=${metrics.containersScanned}`,
            `containerScrollSteps=${metrics.containerScrollSteps}`,
            `repeatContainers=${metrics.repeatContainers}`,
            `newGalleries=${metrics.newGalleries}`,
            `repeat=${repeat}`,
            `repeatReasons=${repeatReasons.join(',') || 'none'}`
        );
    };
    const isAtContainerTop = (metrics) => metrics.scrollTop <= 4;
    const isAtContainerBottom = (metrics) => metrics.scrollTop + metrics.clientHeight >=
        metrics.scrollHeight - 4;
    const getScrollRange = (metrics) => Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    const scanScrollableContainer = async (container, direction) => {
        let edgeStableCycles = 0;
        let edgeLoadWaited = false;
        const isOnlyFansChat = onlyFansScanner?.matchesChatContainer(container) === true;
        const directionStartedAt = performance.now();
        const directionMetrics = createPerformanceMetrics();
        let directionFinished = false;
        onlyFansScanner?.recordContainerDirection(container, direction, 'start');

        const finishContainerScan = (result) => {
            if (!directionFinished) {
                directionFinished = true;
                addMetric(
                    directionMetrics,
                    'containerTraversalMs',
                    performance.now() - directionStartedAt
                );
                onlyFansScanner?.recordContainerDirection(container, direction, 'end', result);
            }
            return result;
        };

        if (isOnlyFansChat && direction === 'up') {
            const result = await onlyFansScanner.scanHistory(container, {
                metrics: directionMetrics,
                isActive,
                wait,
                waitForSettle,
                collectSources,
                registerTargets,
                getContainerMetrics,
                addMetric,
                scrollStepFactor,
                minimumSettleMs
            });
            return finishContainerScan(result ?? 'stable');
        }

        while (isActive() && container.isConnected && isRelevantScrollableContainer(container)) {
            addMetric(directionMetrics, 'steps', 1);
            addMetric(directionMetrics, 'containerScrollSteps', 1);
            const before = getContainerMetrics(container);
            const atEdge = direction === 'up'
                ? isAtContainerTop(before)
                : isAtContainerBottom(before);
            const scrollActionStartedAt = performance.now();
            if (!atEdge) {
                const offset = Math.ceil(before.clientHeight * scrollStepFactor);
                const maximumScrollTop = Math.max(0, before.scrollHeight - before.clientHeight);
                const nextScrollTop = direction === 'up'
                    ? Math.max(0, before.scrollTop - offset)
                    : Math.min(maximumScrollTop, before.scrollTop + offset);
                container.scrollTop = nextScrollTop;
            }
            addMetric(directionMetrics, 'scrollActionMs', performance.now() - scrollActionStartedAt);

            const settleStartedAt = performance.now();
            const settled = await waitForSettle({
                minimumMs: atEdge ? 400 : minimumSettleMs,
                scope: 'container',
                direction,
                phase: `container-${direction}`
            });
            addMetric(directionMetrics, 'settleMs', performance.now() - settleStartedAt);
            if (!settled) {
                return finishContainerScan('aborted');
            }
            const reachedUpperEdge = direction === 'up' && isAtContainerTop(
                getContainerMetrics(container)
            );
            if (atEdge || reachedUpperEdge) {
                onlyFansScanner?.recordContainerEdge(container, direction);
            }

            await collectSources({
                metrics: directionMetrics,
                phase: isOnlyFansChat ? 'final' : 'delta'
            });
            registerTargets();
            let after = getContainerMetrics(container);
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = Math.max(0, after.targets - before.targets);
            let scrollMoved = direction === 'up'
                ? after.scrollTop < before.scrollTop
                : after.scrollTop > before.scrollTop;
            let scrollRangeGrew = getScrollRange(after) > getScrollRange(before);
            let reachedEdge = direction === 'up'
                ? isAtContainerTop(after)
                : isAtContainerBottom(after);

            // A lazy loader can materialize the next history block only after the browser has
            // already reached the edge. Wait locally for a newly reachable range, never for
            // arbitrary mutations, targets, candidates, or PhotoSwipe churn.
            if ((atEdge || reachedEdge) && !edgeLoadWaited) {
                edgeLoadWaited = true;
                const rangeBeforeEdgeLoad = getScrollRange(after);
                const edgeRangeGrowthStartedAt = performance.now();
                const edgeRangeGrowthResult = await waitForEdgeRangeGrowth(
                    () => getScrollRange(getContainerMetrics(container)),
                    () => container.isConnected && isRelevantScrollableContainer(container),
                    rangeBeforeEdgeLoad
                );
                const edgeRangeGrowthDurationMs = performance.now() - edgeRangeGrowthStartedAt;
                recordEdgeRangeWait({
                    scope: 'container',
                    direction,
                    durationMs: edgeRangeGrowthDurationMs,
                    result: edgeRangeGrowthResult
                });
                addMetric(
                    directionMetrics,
                    'edgeRangeGrowthMs',
                    edgeRangeGrowthDurationMs
                );
                if (!isActive()) return finishContainerScan('aborted');

                if (edgeRangeGrowthResult.grew) {
                    const growthSettleStartedAt = performance.now();
                    const growthSettled = await waitForSettle({
                        minimumMs: minimumSettleMs,
                        scope: 'container',
                        direction,
                        phase: `container-${direction}-growth`
                    });
                    addMetric(
                        directionMetrics,
                        'settleMs',
                        performance.now() - growthSettleStartedAt
                    );
                    if (!growthSettled) {
                        return finishContainerScan('aborted');
                    }
                    await collectSources({metrics: directionMetrics});
                    registerTargets();
                    after = getContainerMetrics(container);
                    newImages = Math.max(0, after.images - before.images);
                    newTargets = Math.max(0, after.targets - before.targets);
                    scrollRangeGrew = getScrollRange(after) > getScrollRange(before);
                    scrollMoved = direction === 'up'
                        ? after.scrollTop < before.scrollTop
                        : after.scrollTop > before.scrollTop;
                    reachedEdge = direction === 'up'
                        ? isAtContainerTop(after)
                        : isAtContainerBottom(after);
                    edgeLoadWaited = false;
                }
            }

            addMetric(directionMetrics, 'newDomImages', newImages);
            addMetric(directionMetrics, 'newTargets', newTargets);

            const traversalProgress = scrollMoved || scrollRangeGrew;

            if (!atEdge && !reachedEdge) {
                edgeLoadWaited = false;
            }

            if (atEdge || reachedEdge || !scrollMoved) {
                edgeStableCycles = traversalProgress ? 0 : edgeStableCycles + 1;
                if (edgeStableCycles >= stableCycleLimit) {
                    if (isOnlyFansChat) {
                        await collectSources({metrics: directionMetrics, phase: 'final'});
                        registerTargets();
                    }
                    return finishContainerScan('stable');
                }
            }
        }

        if (isActive()) {
            if (isOnlyFansChat) {
                await collectSources({metrics: directionMetrics, phase: 'final'});
                registerTargets();
            }
            return finishContainerScan('stable');
        }

        return finishContainerScan('aborted');
    };
    const scanRelevantScrollContainers = async () => {
        while (isActive()) {
            const candidates = getPendingRelevantContainerCandidates();
            if (candidates.length === 0) {
                onlyFansScanner?.recordContainerPlan([], null);
                return;
            }

            const plan = createContainerPlan(candidates);
            onlyFansScanner?.recordContainerPlan(candidates, plan);
            if (!isActive()) return;
            for (const entry of plan.entries) {
                const {container} = entry;
                addMetric(null, 'containersHandled', 1);
                if (!entry.isNewContainer) addMetric(null, 'repeatContainers', 1);
            }

            for (const entry of plan.analysisOnly) {
                handledStructureContainers.add(entry.container);
                if (entry.priority === 'low') lowPriorityStructureContainers.add(entry.container);
                else lowPriorityStructureContainers.delete(entry.container);
            }

            for (const {container} of plan.skipped) {
                if (container.isConnected && isRelevantScrollableContainer(container)) {
                    completedScrollContainerStates.set(
                        container,
                        getContainerTraversalState(container)
                    );
                }
            }

            for (const {container} of plan.scanEntries) {
                if (!container.isConnected || !isRelevantScrollableContainer(container)) continue;

                addMetric(null, 'containersScanned', 1);
                await scanScrollableContainer(container, 'up');
                if (!isActive()) return;

                await scanScrollableContainer(container, 'down');
                if (!isActive()) return;
                if (container.isConnected && isRelevantScrollableContainer(container)) {
                    completedScrollContainerStates.set(
                        container,
                        getContainerTraversalState(container)
                    );
                }
            }
        }
    };

    const startMutationObservation = () => domState.start();
    const stopMutationObservation = () => domState.stop();
    const waitForHiddenFrameReadiness = async () => {
        const readinessDeadline = Date.now() + DEEP_SCAN_READINESS_MAX_WAIT_MS;
        while (isActive() && (window.innerWidth <= 0 || window.innerHeight <= 0 ||
            document.readyState === 'loading') && Date.now() < readinessDeadline) {
            if (!(await wait(DEEP_SCAN_READINESS_POLL_INTERVAL_MS))) break;
        }
    };
    const setCurrentPass = (metrics, record) => {
        currentPassMetrics = metrics;
        currentPassRecord = record;
    };
    const clearCurrentPass = () => {
        currentPassMetrics = null;
        currentPassRecord = null;
    };
    const documentTraverser = new DocumentTraverser({
        scrollStepFactor,
        minimumSettleMs,
        // ✴️ NEW 2026-10-13: Keeps short document settles behind live DOM activity checks.
        hasRecentActivity: () => Date.now() - lastRelevantMutationAt < quietSettleMs,
        getRelevantMutationCount: () => relevantMutationCount,
        stableCycleLimit,
        getKnownTargetCount: () => knownTargets.size,
        getKnownTargets,
        isInsideLowPriorityStructureContainer,
        isActive,
        registerTargets,
        collectSources,
        waitForSettle,
        waitForEdgeRangeGrowth,
        recordEdgeRangeWait,
        addMetric,
        getScrollRange
    });
    const finalizeCurrentPass = (record, endReason) => {
        if (record?.endPosition === null) {
            record.endPosition = documentTraverser.getMetrics().scrollY;
            record.durationMs = performance.now() - record.startedAt;
            record.repeatReason = endReason;
        }
    };
    const controller = new DeepScanController({
        lifecycle: {
            isActive,
            isAborted: () => signal?.aborted === true,
            startMutationObservation,
            stopMutationObservation,
            waitForReadiness: waitForHiddenFrameReadiness,
            getPhotoSwipeActivityCount: () => photoSwipeActivityCount,
            getKnownScrollContainerCount: () => knownScrollContainerIndices.size,
            getCompletedScrollContainerStates: () => completedScrollContainerStates,
            getHandledStructureContainers: () => handledStructureContainers,
        },
        collection: {
            registerTargets,
            collectSources
        },
        traversal: {
            scanRelevantScrollContainers,
            waitForSettle,
            synchronizeCompletedScrollContainerStates,
            getPendingRelevantContainerCandidates
        },
        documentTraverser,
        diagnostics: {
            createPerformanceMetrics,
            addMetric,
            setCurrentPass,
            clearCurrentPass,
            finalizeCurrentPass,
            addPassRecord: (record) => passPerformanceRecords.push(record),
            logPassSummary,
            createPerformanceSummary
        }
    });
    return controller.run();

}

export function getPageURL() {
    return window.location.href;
}
