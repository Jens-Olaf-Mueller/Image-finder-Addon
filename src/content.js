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

export async function scanPhotoSwipeImages({
    processedTargets = new WeakSet(),
    processedTargetSources = new Set(),
    signal = null,
    onDiagnostic = null,
    onCarouselDiagnostic = null,
    onActivity = null,
    traverseCarousel = false,
    abortKey = null
} = {}) {
    const abortRegistryKey = '__imageFinderPhotoSwipeAbortKeys';
    const isAborted = () => signal?.aborted === true ||
        (typeof abortKey === 'string' && globalThis[abortRegistryKey]?.has(abortKey));
    const findOpenPhotoSwipe = () => document.querySelector('.pswp.pswp--open');
    const getActiveSlide = (photoSwipe) => photoSwipe?.querySelector(
        '.pswp__item[aria-hidden="false"]'
    ) ?? photoSwipe?.querySelector('.pswp__item:not([aria-hidden="true"])') ?? null;
    const getPhotoSwipeImages = (photoSwipe) => Array.from(
        photoSwipe?.querySelectorAll?.('.pswp__item .pswp__img, .pswp__item img') ?? []
    ).flatMap((element) => {
        if (element instanceof HTMLImageElement) return [element];
        return Array.from(element.querySelectorAll('img'));
    }).filter((image, index, images) => images.indexOf(image) === index);
    const getSlideImages = (photoSwipe) => {
        const slide = getActiveSlide(photoSwipe);
        if (!slide) return [];

        return getPhotoSwipeImages(photoSwipe).filter((image) => slide.contains(image));
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
            signal?.removeEventListener?.('abort', onAbort);
            resolve(value);
        };
        const onAbort = () => finish(null);
        const check = () => {
            if (isAborted()) {
                finish(null);
                return;
            }
            try {
                const result = predicate();
                if (result) finish(result);
            } catch {
                // A failed inspection is treated like a state that has not appeared yet.
            }
        };

        check();
        if (settled) return;
        if (isAborted()) {
            finish(null);
            return;
        }
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
        signal?.addEventListener?.('abort', onAbort, {once: true});
    });
    const closePhotoSwipe = async () => {
        const photoSwipe = findOpenPhotoSwipe();
        if (!photoSwipe) return true;

        const closeButton = photoSwipe.querySelector('.pswp__button--close') ?? await waitFor(
            () => photoSwipe.querySelector('.pswp__button--close'),
            500
        );
        if (!closeButton) return false;

        try {
            closeButton.click();
        } catch {
            return false;
        }
        if (isAborted()) return true;

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
    const collectPhotoSwipeCandidates = (photoSwipe, {includePreloaded = false} = {}) => (
        includePreloaded ? getPhotoSwipeImages(photoSwipe) : getSlideImages(photoSwipe)
    ).flatMap((image) => {
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
    const getTargetSourceKey = (target) => {
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
            ...(target?.querySelectorAll?.('img, source') ?? [])
        ];

        for (const element of sourceElements) {
            const currentSrc = element instanceof HTMLImageElement
                ? getURL(element.currentSrc)
                : null;
            if (currentSrc) return currentSrc;

            for (const attributeName of sourceAttributes) {
                const value = element?.getAttribute?.(attributeName);
                const source = attributeName.endsWith('srcset')
                    ? getSrcsetURLs(value)[0]
                    : getURL(value);
                if (source) return source;
            }
        }

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
    const getCarouselStateLabel = (carousel, key) => {
        if (!carousel.stateLabels.has(key)) {
            carousel.stateLabels.set(key, 'state#' + carousel.stateLabels.size);
        }
        return carousel.stateLabels.get(key);
    };
    const isCarouselControlUsable = (control) => {
        if (!control || !control.isConnected ||
            control.hasAttribute?.('disabled') ||
            control.getAttribute?.('aria-disabled') === 'true' ||
            control.hasAttribute?.('hidden') ||
            /(?:^|\s)disabled(?:\s|$)/i.test(control.className ?? '')) {
            return false;
        }

        try {
            return getComputedStyle(control).display !== 'none';
        } catch {
            return false;
        }
    };
    const getCarouselControl = (photoSwipe, direction) => {
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
        const explicitControl = explicitSelector.map((selector) =>
            photoSwipe.querySelector(selector)
        ).find(isCarouselControlUsable);
        if (explicitControl) return explicitControl;

        return Array.from(photoSwipe.querySelectorAll('button, [role="button"], a')).find(
            (control) => isCarouselControlUsable(control) && semanticPattern.test([
                control.getAttribute('aria-label'),
                control.getAttribute('title'),
                control.textContent
            ].filter(Boolean).join(' '))
        ) ?? null;
    };
    const collectCarouselSources = (photoSwipe, carousel, stateLabel) => {
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
            processedTargetSources.add(url);
        });
        candidates.push(...availableCandidates);
        reportCarousel(
            'CAROUSEL',
            'state=' + stateLabel,
            'preloadSources=' + sourceURLs.size,
            'preloadNew=' + newSources
        );
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
        }, 3000);
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
        const initialState = await waitFor(() => getCarouselState(photoSwipe, carousel), 3000);
        if (!initialState || isAborted()) return;

        const initialStateLabel = getCarouselStateLabel(carousel, initialState.key);
        reportCarousel(
            'CAROUSEL',
            'discovered',
            'type=unknown',
            'state=' + initialStateLabel
        );
        await processCarouselState(photoSwipe, carousel, initialState, 'initial');
        if (isAborted()) return;

        const traverseDirection = async (direction) => {
            let successfulTransitions = 0;

            while (!isAborted()) {
                const beforeState = await waitFor(
                    () => getCarouselState(photoSwipe, carousel),
                    1000
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
                }, 3000);
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
        if (forward.kind === 'aborted' || forward.kind === 'cycle') return;

        const backward = await traverseDirection('backward');
        if (backward.kind !== 'edge' || isAborted()) return;

        carousel.type = 'finite';
        reportCarousel(
            'CAROUSEL END',
            'type=finite',
            'reason=both-edges-exhausted',
            'forward=' + forward.reason,
            'backward=' + backward.reason,
            'states=' + carousel.visitedStates.size
        );
    };
    const targets = Array.from(document.querySelectorAll('[at-attr="media_locator"]'));
    for (const target of targets) {
        const targetSource = getTargetSourceKey(target);
        if (isAborted() || processedTargets.has(target) ||
            (targetSource && processedTargetSources.has(targetSource)) || !isVisibleMediaTarget(target) ||
            findOpenPhotoSwipe()) {
            continue;
        }
        processedTargets.add(target);
        if (targetSource) processedTargetSources.add(targetSource);

        let temporaryStyle = null;
        try {
            temporaryStyle = createTemporaryStyle();
            target.click();

            const photoSwipe = await waitFor(findOpenPhotoSwipe, 2000);
            if (isAborted()) break;
            if (!photoSwipe) continue;

            reportActivity();
            if (traverseCarousel) {
                await traversePhotoSwipeCarousel(photoSwipe);
                continue;
            }

            const readySlide = await waitFor(
                () => getReadyActiveSlideImage(findOpenPhotoSwipe()),
                3000
            );
            if (isAborted()) break;
            if (!readySlide) continue;

            candidates.push(...collectPhotoSwipeCandidates(readySlide.photoSwipe));
            const beforeZoom = getImageSnapshot(readySlide.image);
            try {
                readySlide.image.click();
                reportActivity();
            } catch {
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
            }, 3000);
            if (isAborted()) break;
            if (!zoomedSlide) {
                reportZoom(imageDimensions(beforeZoom) + ' no-upgrade');
                continue;
            }

            candidates.push(...collectPhotoSwipeCandidates(zoomedSlide.activeSlide.photoSwipe));
            const afterZoom = zoomedSlide.afterZoom;
            const resolutionImproved = afterZoom.naturalWidth > beforeZoom.naturalWidth ||
                afterZoom.naturalHeight > beforeZoom.naturalHeight;
            reportZoom(resolutionImproved
                ? imageDimensions(beforeZoom) + ' -> ' + imageDimensions(afterZoom) + ' replaced'
                : imageDimensions(beforeZoom) + ' no-upgrade');
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

    if (typeof abortKey === 'string') {
        globalThis[abortRegistryKey]?.delete(abortKey);
    }
    return candidates;
}

export function abortPhotoSwipeImages(abortKey) {
    if (typeof abortKey !== 'string' || !abortKey) return;

    const registryKey = '__imageFinderPhotoSwipeAbortKeys';
    const abortKeys = globalThis[registryKey] ?? new Set();
    abortKeys.add(abortKey);
    globalThis[registryKey] = abortKeys;
}

const DEEP_SCAN_READINESS_POLL_INTERVAL_MS = 100;
const DEEP_SCAN_READINESS_STABLE_MS = 300;
const DEEP_SCAN_READINESS_MAX_WAIT_MS = 2000;

export async function runIsolatedDeepScan({
    ignoreHiddenImages = false,
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
    ignoreHiddenImages = false,
    onBatch = null,
    onActiveScrollContainer = null,
    signal = null,
    stableCycleLimit = 3,
    scrollStepFactor = 0.8,
    minimumSettleMs = 150,
    quietSettleMs = 350,
    maximumSettleMs = 1500
} = {}) {
    const startedAt = Date.now();
    const seenCandidatesByURL = new Map();
    const seenCandidateURLsByBase = new Map();
    const knownTargets = new Set();
    const attemptedUpwardTargets = new WeakSet();
    const attemptedDownwardTargets = new WeakSet();
    const processedPhotoSwipeTargets = new WeakSet();
    const processedPhotoSwipeTargetSources = new Set();
    const knownScrollContainerIndices = new Map();
    const completedScrollContainerStates = new Map();
    let observer = null;
    let lastRelevantMutationAt = startedAt;
    let relevantMutationCount = 0;
    let relevantChildListMutationCount = 0;
    let relevantAttributeMutationCount = 0;
    let relevantAddedElementCount = 0;
    let relevantRemovedElementCount = 0;
    let photoSwipeActivityCount = 0;
    let progressDiagnosticBatchSequence = 0;
    let completedNaturally = false;
    const edgeLoadWaitMs = Math.max(5000, maximumSettleMs);
    const edgeLoadPollMs = 100;
    const isActive = () => signal?.aborted !== true;
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
    const getScrollElement = () => document.scrollingElement ?? document.documentElement;
    const getTargetElements = () => Array.from(document.querySelectorAll([
        'img',
        'video',
        '[loading="lazy"]',
        '[data-src]',
        '[data-srcset]',
        '[data-image]',
        '[data-image-src]',
        '[data-full]',
        '[data-full-src]',
        '[data-fullsize]',
        '[data-large]',
        '[data-original]',
        '[data-lightbox-src]'
    ].join(',')));
    const registerTargets = () => {
        let added = 0;

        getTargetElements().forEach((element) => {
            if (knownTargets.has(element)) return;

            knownTargets.add(element);
            added += 1;
        });
        return added;
    };
    const getMetrics = () => {
        const scrollElement = getScrollElement();
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
            targets: knownTargets.size
        };
    };
    const getMutationSnapshot = () => ({
        total: relevantMutationCount,
        childList: relevantChildListMutationCount,
        attributes: relevantAttributeMutationCount,
        addedElements: relevantAddedElementCount,
        removedElements: relevantRemovedElementCount
    });
    const getMutationDelta = (before) => ({
        total: Math.max(0, relevantMutationCount - before.total),
        childList: Math.max(0, relevantChildListMutationCount - before.childList),
        attributes: Math.max(0, relevantAttributeMutationCount - before.attributes),
        addedElements: Math.max(0, relevantAddedElementCount - before.addedElements),
        removedElements: Math.max(0, relevantRemovedElementCount - before.removedElements)
    });
    const getCandidateURLClass = (candidateURL) => {
        try {
            const url = new URL(candidateURL);
            const isDataURL = url.protocol === 'data:';
            const isBlobURL = url.protocol === 'blob:';
            const base = isDataURL || isBlobURL
                ? candidateURL
                : `${url.origin}${url.pathname}`;
            const knownVariants = seenCandidateURLsByBase.get(base);

            return {
                base,
                baseKnown: (knownVariants?.size ?? 0) > 0,
                queryVariant: Boolean(knownVariants?.size && url.search),
                dataURL: isDataURL,
                blobURL: isBlobURL
            };
        } catch {
            return {
                base: candidateURL,
                baseKnown: false,
                queryVariant: false,
                dataURL: false,
                blobURL: false
            };
        }
    };
    const getNextScrollTarget = (direction) => {
        const viewportHeight = Math.max(window.innerHeight, 1);
        const minimumTargetTop = Math.ceil(viewportHeight * scrollStepFactor);
        const attemptedTargets = direction === 'up'
            ? attemptedUpwardTargets
            : attemptedDownwardTargets;
        const targets = getTargetElements().flatMap((element) => {
            if (attemptedTargets.has(element)) return [];

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
    };
    const getBottomDwellTarget = () => {
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
    };
    const scrollElementIntoView = (element, block = 'start') => {
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
    };
    const scrollFurtherWithAnchor = (before, direction) => {
        const parent = document.body ?? document.documentElement;
        const viewportHeight = Math.max(window.innerHeight, 1);
        const maximumPosition = Math.max(0, before.scrollHeight - viewportHeight);
        const offset = Math.ceil(viewportHeight * scrollStepFactor);
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
            return scrollElementIntoView(anchor);
        } finally {
            anchor.remove();
        }
    };
    const waitForSettle = async ({minimumMs = minimumSettleMs} = {}) => {
        const settleStartedAt = Date.now();
        const effectiveMinimumMs = Math.max(0, Math.min(minimumMs, maximumSettleMs));
        const settleDeadline = settleStartedAt + Math.max(effectiveMinimumMs, maximumSettleMs);

        if (!(await wait(effectiveMinimumMs))) {
            return false;
        }
        while (isActive() && Date.now() < settleDeadline) {
            const quietForMs = Date.now() - lastRelevantMutationAt;
            if (quietForMs >= quietSettleMs) return true;

            const remainingQuietMs = quietSettleMs - quietForMs;
            const remainingTotalMs = settleDeadline - Date.now();
            if (!(await wait(Math.min(50, remainingQuietMs, remainingTotalMs)))) return false;
        }
        return isActive();
    };
    const waitForEdgeRangeGrowth = async (getRange, isUsable = () => true) => {
        let rangeBefore;
        try {
            rangeBefore = getRange();
        } catch {
            return false;
        }

        const deadline = Date.now() + edgeLoadWaitMs;
        while (isActive() && isUsable() && Date.now() < deadline) {
            if (!(await wait(Math.min(edgeLoadPollMs, deadline - Date.now())))) return false;

            try {
                if (getRange() > rangeBefore) return true;
            } catch {
                return false;
            }
        }

        return false;
    };
    const reportActiveScrollContainer = (container = null) => {
        if (typeof onActiveScrollContainer !== 'function') return;

        try {
            onActiveScrollContainer(container);
        } catch {
            // The temporary visible-tab marker must never affect the hidden traversal.
        }
    };
    const collectSources = async ({diagnosticPhase = null} = {}) => {
        if (!isActive()) return 0;

        const foundCandidates = await scanImages(
            ignoreHiddenImages,
            true,
            true,
            null,
            true
        );
        const photoSwipeCandidates = await scanPhotoSwipeImages({
            processedTargets: processedPhotoSwipeTargets,
            processedTargetSources: processedPhotoSwipeTargetSources,
            signal,
            onDiagnostic: (message) => console.info('[DeepScan ZOOM]', message),
            onCarouselDiagnostic: (event, ...details) => console.info(
                `[DeepScan ${event}]`,
                ...details
            ),
            onActivity: () => {
                photoSwipeActivityCount += 1;
            },
            traverseCarousel: true
        });
        const newCandidates = [];
        const photoSwipeURLs = new Set(photoSwipeCandidates.map((candidate) => candidate?.url));
        const candidateClasses = {
            newBases: 0,
            queryVariants: 0,
            resolutionUpgrades: 0,
            dataURLs: 0,
            blobURLs: 0,
            zeroDimensions: 0,
            smallDimensions: 0,
            photoSwipe: 0
        };

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
            if (candidateClass.dataURL) candidateClasses.dataURLs += 1;
            if (candidateClass.blobURL) candidateClasses.blobURLs += 1;
            if (serializedCandidate.width <= 0 || serializedCandidate.height <= 0) {
                candidateClasses.zeroDimensions += 1;
            } else if (serializedCandidate.width <= 144 && serializedCandidate.height <= 144) {
                candidateClasses.smallDimensions += 1;
            }
            if (photoSwipeURLs.has(serializedCandidate.url)) candidateClasses.photoSwipe += 1;

            const variants = seenCandidateURLsByBase.get(candidateClass.base) ?? new Set();
            variants.add(serializedCandidate.url);
            seenCandidateURLsByBase.set(candidateClass.base, variants);
            seenCandidatesByURL.set(serializedCandidate.url, serializedCandidate);
            newCandidates.push(serializedCandidate);
        }
        if (newCandidates.length > 0 && typeof onBatch === 'function' && isActive()) {
            const diagnostic = diagnosticPhase
                ? {
                    id: `${startedAt}-${++progressDiagnosticBatchSequence}`,
                    phase: diagnosticPhase,
                    rawCandidates: newCandidates.length,
                    ...candidateClasses
                }
                : null;
            if (diagnostic) {
                console.info(
                    '[DeepScan CANDIDATE CLASS]',
                    `phase=${diagnostic.phase}`,
                    `rawCandidates=${diagnostic.rawCandidates}`,
                    `newBases=${diagnostic.newBases}`,
                    `queryVariants=${diagnostic.queryVariants}`,
                    `resolutionUpgrades=${diagnostic.resolutionUpgrades}`,
                    `dataURLs=${diagnostic.dataURLs}`,
                    `blobURLs=${diagnostic.blobURLs}`,
                    `zeroDimensions=${diagnostic.zeroDimensions}`,
                    `smallDimensions=${diagnostic.smallDimensions}`,
                    `photoSwipe=${diagnostic.photoSwipe}`
                );
            }
            await onBatch(newCandidates, diagnostic);
        }
        return newCandidates.length;
    };
    const isGeneratedScrollAnchor = (node) => node?.nodeType === Node.ELEMENT_NODE &&
        node.hasAttribute?.('data-image-finder-scroll-anchor');
    const containsRealElement = (node) => {
        if (!node || isGeneratedScrollAnchor(node)) return false;
        if (node.nodeType === Node.ELEMENT_NODE) return true;
        if (node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return false;

        return Array.from(node.children).some((element) => !isGeneratedScrollAnchor(element));
    };
    const isRelevantMutation = (record) => {
        if (record.type === 'attributes') {
            return !isGeneratedScrollAnchor(record.target) && record.attributeName !== 'class' &&
                record.attributeName !== 'style';
        }

        return Array.from(record.addedNodes ?? []).some(containsRealElement) ||
            Array.from(record.removedNodes ?? []).some(containsRealElement);
    };
    const isRelevantScrollableContainer = (element) => {
        if (!element || element === document.documentElement || element === document.body) return false;

        try {
            const style = getComputedStyle(element);
            return element.scrollHeight > element.clientHeight && element.clientHeight > 0 &&
                /(?:auto|scroll|overlay)/i.test(style.overflowY);
        } catch {
            return false;
        }
    };
    const getRelevantScrollContainers = () => {
        const containers = new Set();

        getTargetElements().forEach((element) => {
            let parent = element.parentElement;
            while (parent && parent !== document.body && parent !== document.documentElement) {
                if (isRelevantScrollableContainer(parent)) containers.add(parent);
                parent = parent.parentElement;
            }
        });

        return Array.from(containers).sort((first, second) => {
            if (first.contains(second)) return 1;
            if (second.contains(first)) return -1;
            return 0;
        });
    };
    const getContainerMetrics = (container) => {
        const targets = getTargetElements().filter((element) => container.contains(element));

        return {
            scrollTop: Math.max(0, Math.round(container.scrollTop ?? 0)),
            scrollHeight: Math.max(0, container.scrollHeight ?? 0),
            clientHeight: Math.max(0, container.clientHeight ?? 0),
            images: container.querySelectorAll('img').length,
            targets: targets.length
        };
    };
    const getContainerTraversalState = (container) => {
        const metrics = getContainerMetrics(container);
        return [metrics.scrollHeight, metrics.clientHeight].join(':');
    };
    const getPendingRelevantScrollContainers = () => {
        completedScrollContainerStates.forEach((_state, container) => {
            if (!container.isConnected) completedScrollContainerStates.delete(container);
        });

        return getRelevantScrollContainers().filter((container) =>
            completedScrollContainerStates.get(container) !== getContainerTraversalState(container)
        );
    };
    const synchronizeCompletedScrollContainerStates = () => {
        getRelevantScrollContainers().forEach((container) => {
            if (!completedScrollContainerStates.has(container)) return;

            completedScrollContainerStates.set(container, getContainerTraversalState(container));
        });
    };
    const getContainerDiagnosticState = (container) => {
        let style = null;
        try {
            style = getComputedStyle(container);
        } catch {
            // Diagnostics must not affect traversal when a page removes a container.
        }

        return {
            scrollTop: container?.scrollTop,
            scrollHeight: container?.scrollHeight,
            clientHeight: container?.clientHeight,
            overflowY: style?.overflowY ?? '(unavailable)',
            flexDirection: style?.flexDirection ?? '(unavailable)'
        };
    };
    const getScrollContainerIndex = (container) => {
        if (!knownScrollContainerIndices.has(container)) {
            knownScrollContainerIndices.set(container, knownScrollContainerIndices.size);
        }

        return knownScrollContainerIndices.get(container);
    };
    const getLogTimestamp = () => {
        const now = new Date();
        const pad = (value, length = 2) => String(value).padStart(length, '0');

        return [now.getHours(), now.getMinutes(), now.getSeconds()]
            .map((value) => pad(value))
            .join(':') + `.${pad(now.getMilliseconds(), 3)}`;
    };
    const getContainerLogLabel = (container, index) => {
        const id = typeof container?.id === 'string' ? container.id.trim() : '';
        return id ? `container#${id}` : `container#?=${index}`;
    };
    const logContainerDirection = (label, container, index, {
        reason = null,
        durationMs = null
    } = {}) => {
        const state = getContainerDiagnosticState(container);
        console.info(
            `[DeepScan ${label}]`,
            `time=${getLogTimestamp()}`,
            ...(Number.isFinite(durationMs) ? [`durationMs=${Math.round(durationMs)}`] : []),
            getContainerLogLabel(container, index),
            ...(reason ? [`reason=${reason}`] : []),
            `scrollTop=${state.scrollTop}`,
            `scrollHeight=${state.scrollHeight}`,
            `clientHeight=${state.clientHeight}`,
            `overflowY=${state.overflowY}`,
            `flexDirection=${state.flexDirection}`
        );
    };
    const logDocumentDirection = (label, {reason = null, durationMs = null} = {}) => {
        const metrics = getMetrics();
        console.info(
            `[DeepScan ${label}]`,
            `time=${getLogTimestamp()}`,
            ...(Number.isFinite(durationMs) ? [`durationMs=${Math.round(durationMs)}`] : []),
            'document',
            ...(reason ? [`reason=${reason}`] : []),
            `scrollY=${metrics.scrollY}`,
            `scrollHeight=${metrics.scrollHeight}`,
            `clientHeight=${metrics.clientHeight}`
        );
    };
    const isAtContainerTop = (metrics) => metrics.scrollTop <= 4;
    const isAtContainerBottom = (metrics) => metrics.scrollTop + metrics.clientHeight >=
        metrics.scrollHeight - 4;
    const getScrollRange = (metrics) => Math.max(0, metrics.scrollHeight - metrics.clientHeight);
    const isAtCurrentDocumentBottom = (metrics) => metrics.scrollY + metrics.clientHeight >=
        metrics.scrollHeight - 4;
    const isAtCurrentDocumentTop = (metrics) => metrics.scrollY <= 4;

    const getDocumentTraversalState = () => {
        const metrics = getMetrics();
        return [metrics.scrollHeight, metrics.clientHeight].join(':');
    };
    const scanScrollableContainer = async (container, direction, index) => {
        let edgeStableCycles = 0;
        let edgeLoadWaited = false;
        let progressDiagnosticLogged = false;
        const label = direction === 'up' ? 'UP' : 'DOWN';
        const directionStartedAt = performance.now();

        reportActiveScrollContainer(container);
        logContainerDirection(label, container, index);

        while (isActive() && container.isConnected && isRelevantScrollableContainer(container)) {
            const before = getContainerMetrics(container);
            const atEdge = direction === 'up'
                ? isAtContainerTop(before)
                : isAtContainerBottom(before);
            const mutationsBefore = getMutationSnapshot();

            if (!atEdge) {
                const offset = Math.ceil(before.clientHeight * scrollStepFactor);
                const maximumScrollTop = Math.max(0, before.scrollHeight - before.clientHeight);
                const nextScrollTop = direction === 'up'
                    ? Math.max(0, before.scrollTop - offset)
                    : Math.min(maximumScrollTop, before.scrollTop + offset);
                container.scrollTop = nextScrollTop;
            }

            if (!(await waitForSettle({minimumMs: atEdge ? 400 : minimumSettleMs}))) {
                return 'aborted';
            }

            let newCandidates = await collectSources();
            registerTargets();
            let after = getContainerMetrics(container);
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = Math.max(0, after.targets - before.targets);
            const mutations = getMutationDelta(mutationsBefore).total;
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
                const rangeGrewAfterEdgeWait = await waitForEdgeRangeGrowth(
                    () => getScrollRange(getContainerMetrics(container)),
                    () => container.isConnected && isRelevantScrollableContainer(container)
                );
                if (!isActive()) return 'aborted';

                if (rangeGrewAfterEdgeWait) {
                    newCandidates += await collectSources();
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

            const traversalProgress = scrollMoved || scrollRangeGrew;
            const structuralProgress = newImages > 0 || newTargets > 0 || mutations > 0;

            if (!atEdge && !reachedEdge) edgeLoadWaited = false;

            if (!progressDiagnosticLogged && (scrollRangeGrew || structuralProgress ||
                newCandidates > 0)) {
                progressDiagnosticLogged = true;
                console.info(
                    '[DeepScan CONTAINER PROGRESS]',
                    `time=${getLogTimestamp()}`,
                    getContainerLogLabel(container, index),
                    `direction=${direction}`,
                    `scrollMoved=${scrollMoved}`,
                    `scrollRangeChanged=${scrollRangeGrew}`,
                    `newTargets=${newTargets}`,
                    `newCandidates=${newCandidates}`,
                    `structure=${structuralProgress}`,
                    `scrollHeightBefore=${before.scrollHeight}`,
                    `scrollHeightAfter=${after.scrollHeight}`
                );
            }

            if (atEdge || reachedEdge || !scrollMoved) {
                edgeStableCycles = traversalProgress ? 0 : edgeStableCycles + 1;
                if (edgeStableCycles >= stableCycleLimit) {
                    logContainerDirection(`${label} END`, container, index, {
                        reason: 'stable',
                        durationMs: performance.now() - directionStartedAt
                    });
                    return 'stable';
                }
            }
        }

        if (isActive()) {
            logContainerDirection(`${label} END`, container, index, {
                reason: 'stable',
                durationMs: performance.now() - directionStartedAt
            });
            return 'stable';
        }

        return 'aborted';
    };
    const scanRelevantScrollContainers = async () => {
        while (isActive()) {
            const containers = getPendingRelevantScrollContainers();
            if (containers.length === 0) return;

            for (const container of containers) {
                const isNewContainer = !knownScrollContainerIndices.has(container);
                const index = getScrollContainerIndex(container);
                if (isNewContainer) {
                    const state = getContainerDiagnosticState(container);
                    console.info(
                        '[DeepScan CONTAINER] added',
                        `time=${getLogTimestamp()}`,
                        getContainerLogLabel(container, index),
                        `scrollHeight=${state.scrollHeight}`,
                        `clientHeight=${state.clientHeight}`,
                        `overflowY=${state.overflowY}`,
                        `flexDirection=${state.flexDirection}`
                    );
                } else {
                    console.info(
                        '[DeepScan CONTAINER] requeue',
                        `time=${getLogTimestamp()}`,
                        getContainerLogLabel(container, index),
                        `previous=${completedScrollContainerStates.get(container)}`,
                        `current=${getContainerTraversalState(container)}`
                    );
                }
                await scanScrollableContainer(container, 'up', index);
                if (!isActive()) return;

                await scanScrollableContainer(container, 'down', index);
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
    const scanDocumentDirection = async (direction) => {
        const label = direction === 'up' ? 'UP' : 'DOWN';
        let edgeStableCycles = 0;
        let edgeLoadWaited = false;
        let progressDiagnosticLogged = false;
        const directionStartedAt = performance.now();

        reportActiveScrollContainer();
        logDocumentDirection(label);
        while (isActive()) {
            const beforeNewTargets = registerTargets();
            const before = getMetrics();
            const atEdge = direction === 'up'
                ? isAtCurrentDocumentTop(before)
                : isAtCurrentDocumentBottom(before);
            const mutationsBefore = getMutationSnapshot();
            const photoSwipeActivityBefore = photoSwipeActivityCount;
            let scrollResult = {scrolled: false, targetMovement: 0};

            if (atEdge) {
                if (direction === 'down') {
                    const bottomTarget = getBottomDwellTarget();
                    if (bottomTarget) scrollResult = scrollElementIntoView(bottomTarget, 'end');
                }
            } else {
                const target = getNextScrollTarget(direction);
                if (target) {
                    if (direction === 'up') attemptedUpwardTargets.add(target.element);
                    else attemptedDownwardTargets.add(target.element);
                    scrollResult = scrollElementIntoView(target.element);
                } else {
                    scrollResult = scrollFurtherWithAnchor(before, direction);
                }
            }

            if (!(await waitForSettle({minimumMs: atEdge ? 400 : minimumSettleMs}))) {
                return 'aborted';
            }

            let newCandidates = await collectSources({
                diagnosticPhase: direction === 'down' && !progressDiagnosticLogged
                    ? 'document-down'
                    : null
            });
            let afterNewTargets = registerTargets();
            let after = getMetrics();
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = beforeNewTargets + afterNewTargets;
            const mutationDelta = getMutationDelta(mutationsBefore);
            const mutations = mutationDelta.total;
            let scrollRangeGrew = getScrollRange(after) > getScrollRange(before);
            let documentScrollMoved = direction === 'up'
                ? after.effectiveScrollTop < before.effectiveScrollTop
                : after.effectiveScrollTop > before.effectiveScrollTop;
            const targetGeometryMoved = direction === 'up'
                ? scrollResult.targetMovement > 1
                : scrollResult.targetMovement < -1;
            let scrollMoved = documentScrollMoved;
            let reachedEdge = direction === 'up'
                ? isAtCurrentDocumentTop(after)
                : isAtCurrentDocumentBottom(after);

            if ((atEdge || reachedEdge) && !edgeLoadWaited) {
                edgeLoadWaited = true;
                const rangeGrewAfterEdgeWait = await waitForEdgeRangeGrowth(
                    () => getScrollRange(getMetrics())
                );
                if (!isActive()) return 'aborted';

                if (rangeGrewAfterEdgeWait) {
                    newCandidates += await collectSources({
                        diagnosticPhase: direction === 'down' && !progressDiagnosticLogged
                            ? 'document-down'
                            : null
                    });
                    afterNewTargets += registerTargets();
                    after = getMetrics();
                    newImages = Math.max(0, after.images - before.images);
                    newTargets = beforeNewTargets + afterNewTargets;
                    scrollRangeGrew = getScrollRange(after) > getScrollRange(before);
                    documentScrollMoved = direction === 'up'
                        ? after.effectiveScrollTop < before.effectiveScrollTop
                        : after.effectiveScrollTop > before.effectiveScrollTop;
                    scrollMoved = documentScrollMoved;
                    reachedEdge = direction === 'up'
                        ? isAtCurrentDocumentTop(after)
                        : isAtCurrentDocumentBottom(after);
                    edgeLoadWaited = false;
                }
            }

            const traversalProgress = scrollMoved || scrollRangeGrew;
            const discoveryProgress = newImages > 0 || newTargets > 0 || newCandidates > 0 ||
                mutations > 0;

            if (!atEdge && !reachedEdge) edgeLoadWaited = false;

            if (atEdge || reachedEdge || !scrollMoved) {
                if (direction === 'down' && (traversalProgress || discoveryProgress) &&
                    !progressDiagnosticLogged) {
                    progressDiagnosticLogged = true;
                    console.info(
                        '[DeepScan PROGRESS]',
                        'phase=document-down',
                        `structure=${newImages > 0 || newTargets > 0 || mutations > 0}`,
                        `scrollRange=${scrollRangeGrew}`,
                        `newCandidates=${newCandidates}`,
                        `newTargets=${newTargets}`,
                        `newImages=${newImages}`,
                        `mutations=${mutations}`,
                        `mutationChildList=${mutationDelta.childList}`,
                        `mutationAttributes=${mutationDelta.attributes}`,
                        `mutationAddedElements=${mutationDelta.addedElements}`,
                        `mutationRemovedElements=${mutationDelta.removedElements}`,
                        `photoSwipeActivity=${photoSwipeActivityCount - photoSwipeActivityBefore}`,
                        'acceptedCandidates=pending-pipeline',
                        'visibleImageDelta=pending-pipeline',
                        `effectiveScrollBefore=${before.effectiveScrollTop}`,
                        `effectiveScrollAfter=${after.effectiveScrollTop}`,
                        `scrollHeightBefore=${before.scrollHeight}`,
                        `scrollHeightAfter=${after.scrollHeight}`,
                        `clientHeightBefore=${before.clientHeight}`,
                        `clientHeightAfter=${after.clientHeight}`,
                        `scrollRangeBefore=${getScrollRange(before)}`,
                        `scrollRangeAfter=${getScrollRange(after)}`,
                        `documentScrollMoved=${documentScrollMoved}`,
                        `scrollAttempted=${scrollResult.scrolled}`,
                        `targetGeometryMovement=${scrollResult.targetMovement}`,
                        `targetGeometryMoved=${targetGeometryMoved}`,
                        `scrollMoved=${scrollMoved}`
                    );
                }
                edgeStableCycles = traversalProgress ? 0 : edgeStableCycles + 1;
                if (edgeStableCycles >= stableCycleLimit) {
                    logDocumentDirection(`${label} END`, {
                        reason: 'stable',
                        durationMs: performance.now() - directionStartedAt
                    });
                    return 'stable';
                }
            }
        }

        return 'aborted';
    };

    try {
        if (typeof MutationObserver === 'function' && document.documentElement) {
            observer = new MutationObserver((records) => {
                const relevantMutations = records.filter(isRelevantMutation);
                if (relevantMutations.length === 0) return;

                lastRelevantMutationAt = Date.now();
                relevantMutationCount += relevantMutations.length;
                relevantMutations.forEach((record) => {
                    if (record.type === 'attributes') {
                        relevantAttributeMutationCount += 1;
                        return;
                    }

                    relevantChildListMutationCount += 1;
                    relevantAddedElementCount += Array.from(record.addedNodes ?? []).filter(
                        containsRealElement
                    ).length;
                    relevantRemovedElementCount += Array.from(record.removedNodes ?? []).filter(
                        containsRealElement
                    ).length;
                });
            });
            observer.observe(document.documentElement, {
                subtree: true,
                childList: true,
                attributes: true,
                attributeFilter: [
                    'src',
                    'srcset',
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
                ]
            });
        }

        const readinessDeadline = Date.now() + DEEP_SCAN_READINESS_MAX_WAIT_MS;
        while (isActive() && (window.innerWidth <= 0 || window.innerHeight <= 0 ||
            document.readyState === 'loading') && Date.now() < readinessDeadline) {
            if (!(await wait(DEEP_SCAN_READINESS_POLL_INTERVAL_MS))) break;
        }

        registerTargets();
        await collectSources();
        while (isActive()) {
            const photoSwipeActivityAtPassStart = photoSwipeActivityCount;
            await scanRelevantScrollContainers();
            if (!isActive()) break;

            await scanDocumentDirection('up');
            if (!isActive()) break;

            await scanDocumentDirection('down');
            if (!isActive()) break;

            const documentStateAfterDirections = getDocumentTraversalState();
            const mutationCountAfterDirections = relevantMutationCount;
            await scanRelevantScrollContainers();
            if (!isActive()) break;

            if (!(await waitForSettle({minimumMs: 400}))) break;

            const photoSwipeActivityBeforeFinalCollection = photoSwipeActivityCount;
            const newCandidates = await collectSources();
            const newTargets = registerTargets();
            const documentStateAfterFinalSettle = getDocumentTraversalState();
            const mutationCountAfterFinalSettle = relevantMutationCount;
            const documentChangedAfterDirections = documentStateAfterDirections !==
                documentStateAfterFinalSettle;
            const mutationDetected = mutationCountAfterDirections !== mutationCountAfterFinalSettle;
            const candidatesDetected = newCandidates > 0;
            const targetsDetected = newTargets > 0;
            const photoSwipeActivityDetected = photoSwipeActivityCount !==
                photoSwipeActivityAtPassStart;
            const photoSwipeActivityDuringFinalCollection = photoSwipeActivityCount !==
                photoSwipeActivityBeforeFinalCollection;

            // Opening and closing PhotoSwipe changes page-owned DOM. Its candidates have already
            // been collected above, so treat that temporary DOM as the current baseline instead
            // of scheduling a complete traversal of unchanged containers.
            if (photoSwipeActivityDuringFinalCollection) {
                synchronizeCompletedScrollContainerStates();
            }

            const pendingContainers = getPendingRelevantScrollContainers();
            const newContainersDetected = pendingContainers.some((container) =>
                !completedScrollContainerStates.has(container)
            );
            const containersDetected = pendingContainers.some((container) =>
                completedScrollContainerStates.has(container)
            );

            // Discovery work has already been collected and sent to the client. Repeat traversal
            // only when the reachable document range changed or a container range is unfinished.
            const repeatPass = documentChangedAfterDirections || pendingContainers.length > 0;

            if (!repeatPass) {
                console.info('[DeepScan PASS] complete');
                completedNaturally = true;
                break;
            }

            console.info(
                '[DeepScan PASS] repeat',
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
        observer?.disconnect();
        reportActiveScrollContainer();
    }

    const status = signal?.aborted === true ? 'cancelled' : 'completed';
    if (status === 'completed' && completedNaturally) {
        console.info('[DeepScan END] status=completed');
    }

    return {
        status,
        endReason: status === 'cancelled' ? 'aborted' : 'stable'
    };
}

export function getPageURL() {
    return window.location.href;
}
