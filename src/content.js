export async function scanImages(
    ignoreHiddenImages = false,
    includeAllImageSources = false,
    includeSupplementarySources = true,
    mutationObserverOptions = null,
    includeLightboxSources = false
) {
    const getURL = (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), document.baseURI).href;
        } catch {
            return null;
        }
    };

    const getImageURL = (value) => {
        const url = getURL(value);
        if (!url) return null;
        if (/^(?:data:image\/|blob:)/i.test(url)) return url;

        try {
            const {protocol} = new URL(url);
            return ['http:', 'https:'].includes(protocol) ? url : null;
        } catch {
            return null;
        }
    };

    const getPreferredSrcsetURL = (srcset) => {
        if (typeof srcset !== 'string' || !srcset.trim()) return null;

        const singleDataImage = srcset.trim().match(
            /^(data:image\/[^,]+,[^\s]+)(?:\s+(?:\d+w|\d*\.?\d+x))?$/i
        );
        if (singleDataImage) return getURL(singleDataImage[1]);

        const candidates = srcset
            .split(',')
            .map((candidate) => {
                const [value, descriptor = ''] = candidate.trim().split(/\s+/, 2);
                const url = getURL(value);

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

        return Array.from(picture.querySelectorAll('source[srcset], source[data-srcset]'))
            .map((source) => getPreferredSrcsetURL(
                source.getAttribute('data-srcset') || source.getAttribute('srcset')
            ))
            .filter(Boolean);
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

    const isHidden = (element, computedStyle = null) => {
        if (!ignoreHiddenImages) return false;

        try {
            for (let current = element; current; current = current.parentElement) {
                const style = current === element && computedStyle
                    ? computedStyle
                    : getComputedStyle(current);

                if (style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.visibility === 'collapse') {
                    return true;
                }
            }
        } catch {
            return false;
        }

        return false;
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
            for (let current = element; current; current = current.parentElement) {
                const style = current === element && computedStyle
                    ? computedStyle
                    : getComputedStyle(current);

                if (hasNonZeroBlur(style.filter)) return true;
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
        ? Array.from(document.querySelectorAll('*'))
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

    const collectImageElement = (
        img,
        includeAllSources,
        seenURLs = null,
        includeHiddenImages = false
    ) => {
        if (!includeHiddenImages && isHidden(img)) return;

        const currentSrc = getURL(img.currentSrc);
        const src = getURL(img.getAttribute('src'));
        const dataSrc = getURL(img.getAttribute('data-src'));
        const dataSrcset = img.getAttribute('data-srcset');
        const hasLazySource = Boolean(dataSrc || dataSrcset);
        const currentSrcLooksLikePlaceholder = hasLazySource && (!currentSrc || currentSrc === src);

        if (includeAllSources) {
            const imageSources = [
                currentSrc,
                src,
                getPreferredSrcsetURL(img.getAttribute('srcset')),
                dataSrc,
                getPreferredSrcsetURL(dataSrcset),
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
            url = getPreferredSrcsetURL(dataSrcset) || dataSrc;
        }
        if (!url) url = getPreferredSrcsetURL(img.getAttribute('srcset')) || src;
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
        'data-image',
        'data-image-src',
        'data-full',
        'data-full-src',
        'data-fullsize',
        'data-large',
        'data-original',
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
        const url = getImageURL(srcset ? getPreferredSrcsetURL(value) : value);
        addCandidate(url, 0, 0, 'linkedimages', element, seenURLs);
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

        return Array.from(ids, (id) => document.getElementById(id)).filter(Boolean);
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
                        if (includeLightboxSources && !isHidden(image)) {
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

    for (const img of document.images) {
        collectImageElement(img, includeAllImageSources);
        if (includeLightboxSources && !isHidden(img)) {
            collectLightboxSources(img);
        }
    }

    if (includeSupplementarySources) {
        for (const element of elements) {
            try {
                const style = getComputedStyle(element);
                if (isHidden(element, style)) continue;

                const backgroundImage = style.backgroundImage;
                for (const url of getBackgroundURLs(backgroundImage)) {
                    addCandidate(url, 0, 0, 'backgroundimages', element);
                }
            } catch {
                continue;
            }
        }

        for (const link of document.querySelectorAll('a[href]')) {
            if (isHidden(link)) continue;

            const url = getURL(link.href);

            if (!isLinkedImageURL(url)) continue;

            addCandidate(url, 0, 0, 'linkedimages', link);
        }
    }

    await enrichBlobCandidates();

    return images;
}

export async function scanPhotoSwipeImages() {
    const findOpenPhotoSwipe = () => document.querySelector('.pswp.pswp--open');
    const getActiveSlide = (photoSwipe) => photoSwipe?.querySelector(
        '.pswp__item[aria-hidden="false"]'
    ) ?? photoSwipe?.querySelector('.pswp__item:not([aria-hidden="true"])') ?? null;
    const getSlideImages = (photoSwipe) => {
        const slide = getActiveSlide(photoSwipe);
        if (!slide) return [];

        return Array.from(slide.querySelectorAll('.pswp__img, img')).flatMap((element) => {
            if (element instanceof HTMLImageElement) return [element];
            return Array.from(element.querySelectorAll('img'));
        }).filter((image, index, images) => images.indexOf(image) === index);
    };
    const getReadyActiveSlideImage = (photoSwipe) => {
        if (!photoSwipe?.matches('.pswp.pswp--open')) return null;

        const slide = getActiveSlide(photoSwipe);
        if (!slide) return null;

        const image = getSlideImages(photoSwipe).find((candidate) =>
            candidate.complete === true && candidate.naturalWidth > 0 && candidate.naturalHeight > 0
        );
        return image ? {photoSwipe, slide, image} : null;
    };
    const waitFor = (predicate, timeoutMs = 2000) => new Promise((resolve) => {
        let observer = null;
        let interval = null;
        let timeout = null;
        let settled = false;
        const finish = (value) => {
            if (settled) return;

            settled = true;
            observer?.disconnect();
            clearInterval(interval);
            clearTimeout(timeout);
            resolve(value);
        };
        const check = () => {
            try {
                const result = predicate();
                if (result) finish(result);
            } catch {
                // A failed inspection is treated like a state that has not appeared yet.
            }
        };

        check();
        if (settled) return;
        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver(check);
            observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: ['class', 'src', 'srcset', 'role', 'aria-hidden']
            });
        }
        interval = setInterval(check, 50);
        timeout = setTimeout(() => finish(null), timeoutMs);
    });
    const closePhotoSwipe = async () => {
        const photoSwipe = findOpenPhotoSwipe();
        if (!photoSwipe) return true;

        const closeButton = await waitFor(
            () => photoSwipe.querySelector('.pswp__button--close'),
            500
        );
        if (!closeButton) return false;

        try {
            closeButton.click();
        } catch {
            return false;
        }

        const closed = await waitFor(() => {
            if (!photoSwipe.isConnected) return true;
            return !photoSwipe.classList.contains('pswp--open');
        }, 1500);
        return Boolean(closed);
    };

    const getURL = (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), document.baseURI).href;
        } catch {
            return null;
        }
    };
    const getSrcsetURLs = (srcset) => typeof srcset === 'string'
        ? srcset.split(',').map((entry) => getURL(entry.trim().split(/\s+/, 1)[0])).filter(Boolean)
        : [];
    const collectSlideCandidates = (photoSwipe) => getSlideImages(photoSwipe).flatMap((image) => {
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
    const isVisibleMediaTarget = (target) => {
        if (!target?.querySelector('img')) return false;

        try {
            const style = getComputedStyle(target);
            const rect = target.getBoundingClientRect();
            return style.display !== 'none' && style.visibility !== 'hidden' &&
                style.visibility !== 'collapse' && rect.width > 0 && rect.height > 0;
        } catch {
            return false;
        }
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

    const candidates = [];
    const processedTargets = new WeakSet();
    const targets = Array.from(document.querySelectorAll('[at-attr="media_locator"]'));
    for (const target of targets) {
        if (processedTargets.has(target) || !isVisibleMediaTarget(target) || findOpenPhotoSwipe()) {
            continue;
        }
        processedTargets.add(target);

        let temporaryStyle = null;
        try {
            temporaryStyle = createTemporaryStyle();
            target.click();

            const photoSwipe = await waitFor(findOpenPhotoSwipe, 2000);
            if (!photoSwipe) continue;

            const readySlide = await waitFor(
                () => getReadyActiveSlideImage(findOpenPhotoSwipe()),
                3000
            );
            if (!readySlide) continue;

            candidates.push(...collectSlideCandidates(readySlide.photoSwipe));
        } catch {
            // One page-owned PhotoSwipe target must not stop the remaining DeepScan.
        } finally {
            try {
                const closed = await closePhotoSwipe();
                if (!closed && findOpenPhotoSwipe()) await closePhotoSwipe();
            } finally {
                temporaryStyle?.remove();
            }
        }
    }

    return candidates;
}

const DEEP_SCAN_READINESS_POLL_INTERVAL_MS = 100;
const DEEP_SCAN_READINESS_STABLE_MS = 300;
const DEEP_SCAN_READINESS_MAX_WAIT_MS = 2000;

export async function runIsolatedDeepScan({
    ignoreHiddenImages = false,
    onBatch = null,
    signal = null,
    totalLimitMs = 30000,
    scrollStepFactor = 0.8,
    scrollSettleMs = 150,
    maxScrollSteps = 40,
    lightboxSettleMs = 250,
    maxLightboxActivations = 40,
    finalSettleMs = 1000
} = {}) {
    const startedAt = Date.now();
    const deadline = startedAt + Math.max(0, totalLimitMs);
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
    const isActive = () => signal?.aborted !== true && Date.now() < deadline;
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
            readyState: document.readyState,
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
        const readinessDeadline = Math.min(
            deadline,
            readinessStartedAt + DEEP_SCAN_READINESS_MAX_WAIT_MS
        );
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
            ignoreHiddenImages,
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
            if (!isActive() || lightboxActivations >= maxLightboxActivations) return;
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
        for (let step = 0; step < maxScrollSteps && isActive() && hasLazyViewport; step += 1) {
            const scrollElement = document.scrollingElement ?? document.documentElement;
            const before = window.scrollY;
            const scrollHeightBefore = scrollElement.scrollHeight;
            const maximumScrollY = Math.max(0, scrollHeightBefore - viewportHeight);
            const target = Math.min(
                maximumScrollY,
                before + Math.ceil(viewportHeight * scrollStepFactor)
            );

            if (target <= before) break;
            if (!scrollToDocumentPosition(target)) break;

            if (!(await wait(scrollSettleMs)) || !isActive()) break;
            const after = window.scrollY;
            let scrollHeight = scrollElement.scrollHeight;
            if (after <= before) break;

            await queueCollection();
            await activateLightboxTargets();
            scrollHeight = scrollElement.scrollHeight;
            const reachedBottom = after + viewportHeight >= scrollHeight - 2;
            if (reachedBottom && scrollHeight <= previousScrollHeight) break;

            previousScrollHeight = scrollHeight;
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
        status: signal?.aborted === true
            ? 'cancelled'
            : Date.now() >= deadline
                ? 'timedOut'
                : 'completed',
        lightboxActivations
    };
}

export function getPageURL() {
    return window.location.href;
}
