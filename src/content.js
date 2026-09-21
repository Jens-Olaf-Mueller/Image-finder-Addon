export async function scanImages(
    ignoreHiddenImages = false,
    includeAllImageSources = false,
    includeSupplementarySources = true,
    mutationObserverOptions = null,
    includeLightboxSources = false
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
        const roots = [document];
        const seenRoots = new Set(roots);

        for (let index = 0; index < roots.length; index += 1) {
            roots[index].querySelectorAll?.('*').forEach((element) => {
                if (element.shadowRoot && !seenRoots.has(element.shadowRoot)) {
                    seenRoots.add(element.shadowRoot);
                    roots.push(element.shadowRoot);
                }
            });
        }

        return roots;
    };

    const getDeepElements = (selector) => getOpenRoots().flatMap((root) =>
        Array.from(root.querySelectorAll?.(selector) ?? [])
    );

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
            for (let current = element; current;) {
                const style = current === element && computedStyle
                    ? computedStyle
                    : getComputedStyle(current);

                if (style.display === 'none' ||
                    style.visibility === 'hidden' ||
                    style.visibility === 'collapse') {
                    return true;
                }

                current = current.parentElement ?? current.getRootNode?.().host ?? null;
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

    const collectImageElement = (
        img,
        includeAllSources,
        seenURLs = null,
        includeHiddenImages = false
    ) => {
        if (!includeHiddenImages && isHidden(img)) return;

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

    for (const img of getDeepElements('img')) {
        collectImageElement(img, includeAllImageSources);
        if (includeLightboxSources && !isHidden(img)) {
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
                if (isHidden(element, style)) continue;

                const backgroundImage = style.backgroundImage;
                for (const url of getBackgroundURLs(backgroundImage)) {
                    addCandidate(url, 0, 0, 'backgroundimages', element);
                }
            } catch {
                continue;
            }
        }

        for (const link of getDeepElements('a[href]')) {
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
    processedCarouselRoots = new WeakSet(),
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
    const getOpenRoots = (initialRoot = document) => {
        const roots = [initialRoot];
        const seenRoots = new Set(roots);

        for (let index = 0; index < roots.length; index += 1) {
            roots[index].querySelectorAll?.('*').forEach((element) => {
                if (element.shadowRoot && !seenRoots.has(element.shadowRoot)) {
                    seenRoots.add(element.shadowRoot);
                    roots.push(element.shadowRoot);
                }
            });
        }

        return roots;
    };
    const queryDeep = (root, selector) => getOpenRoots(root).flatMap((queryRoot) =>
        Array.from(queryRoot.querySelectorAll?.(selector) ?? [])
    );
    const findDeep = (selector) => getOpenRoots().map((root) => root.querySelector?.(selector))
        .find(Boolean) ?? null;
    const findOpenPhotoSwipe = () => findDeep('.pswp.pswp--open');
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

        return queryDeep(root, selector).filter((element) => genericSlideTokens.test([
            getElementClassText(element),
            element.getAttribute?.('role'),
            element.getAttribute?.('data-slide-index'),
            element.getAttribute?.('data-swiper-slide-index')
        ].filter(Boolean).join(' ')) && getGenericGalleryMediaElements(element).length > 0);
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
        if (!control || !control.isConnected) return {usable: false, reason: 'control-unavailable'};
        if (control.hasAttribute('disabled') || control.hasAttribute('hidden') ||
            control.hasAttribute('inert') || control.getAttribute('aria-disabled') === 'true' ||
            /(?:^|\s)(?:disabled|swiper-button-disabled)(?:\s|$)/i.test(
                getElementClassText(control)
            )) {
            return {usable: false, reason: 'control-disabled'};
        }
        try {
            const style = getComputedStyle(control);
            if (style.display === 'none' || style.visibility === 'hidden' ||
                style.visibility === 'collapse' || style.pointerEvents === 'none') {
                return {usable: false, reason: 'control-unavailable'};
            }
        } catch {
            return {usable: false, reason: 'control-unavailable'};
        }
        return {usable: true, reason: null};
    };
    const getGenericCarouselControl = (root, direction) => {
        const controls = queryDeep(root, '*').filter((element) =>
            getGenericControlDirection(element) === direction
        );
        const control = controls.find((candidate) => getGenericControlAvailability(candidate).usable);
        if (control) return {
            control,
            kind: getGenericControlKind(control),
            reason: null
        };

        const disabled = controls.find((candidate) =>
            getGenericControlAvailability(candidate).reason === 'control-disabled'
        );
        return {
            control: null,
            kind: disabled ? getGenericControlKind(disabled) : null,
            reason: disabled ? 'control-disabled' : 'control-unavailable'
        };
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
        if (!rawKey) return null;

        return {
            active,
            key: rawKey,
            mountedSlides: slides.length,
            totalHint: getGenericTotalHint(root)
        };
    };
    const collectGenericCarouselSources = (root, gallery, stateLabel) => {
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
                candidates.push({
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
        return {newSources: preloadNew, lazySources, preloadSources: sourceURLs.size};
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
            candidates.push(...collectPhotoSwipeCandidates(photoSwipe, {includePreloaded: true}));
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
            if (zoomedSlide) candidates.push(...collectPhotoSwipeCandidates(
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
        const slides = getGenericSlideElements(root);
        const mediaCount = getGenericGalleryMediaElements(root).length;
        const hasControls = getGenericCarouselControl(root, 'forward').control ||
            getGenericCarouselControl(root, 'backward').control;
        const totalHint = getGenericTotalHint(root);
        const score = Number(hasGallerySignal) + Number(slides.length > 1) +
            Number(mediaCount > 0) + Number(Boolean(hasControls)) + Number(Boolean(totalHint));
        return hasGallerySignal && score >= 2;
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
        const roots = queryDeep(document, '*').filter(isGenericGalleryRoot);
        const isExplicitGalleryRoot = (root) => Boolean(
            root.id || root.getAttribute?.('data-carousel-id') || root.getAttribute?.('data-gallery-id')
        );
        const containsComposed = (ancestor, element) => {
            for (let current = element; current;) {
                if (current === ancestor) return true;
                current = current.parentElement ?? current.getRootNode?.().host ?? null;
            }
            return false;
        };
        const uniqueRoots = roots.filter((root) => !roots.some((other) => other !== root &&
            !isExplicitGalleryRoot(root) && isExplicitGalleryRoot(other) &&
            (containsComposed(root, other) || containsComposed(other, root))
        ));
        for (const root of uniqueRoots) {
            if (isAborted()) return;
            if (processedCarouselRoots.has(root)) continue;
            processedCarouselRoots.add(root);
            await traverseGenericCarousel(root);
        }
    };
    if (traverseCarousel) await traverseGenericCarousels();

    const targets = queryDeep(document, '[at-attr="media_locator"]');
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
    maximumSettleMs = 1500,
    minimumImageWidth = 200,
    minimumImageHeight = 200
} = {}) {
    const startedAt = Date.now();
    const startedAtPerformance = performance.now();
    const seenCandidatesByURL = new Map();
    const seenCandidateURLsByBase = new Map();
    const knownTargets = new Set();
    const attemptedUpwardTargets = new WeakSet();
    const attemptedDownwardTargets = new WeakSet();
    const processedPhotoSwipeTargets = new WeakSet();
    const processedPhotoSwipeTargetSources = new Set();
    const processedCarouselRoots = new WeakSet();
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
    let deepScanPass = 0;
    let currentPassMetrics = null;
    let lastNewSourceAt = null;
    let lastRawCandidateAt = null;
    let collectionSequence = 0;
    let observedMutationCount = 0;
    let observedChildListMutationCount = 0;
    let observedAttributeMutationCount = 0;
    let observedAddedElementCount = 0;
    let observedRemovedElementCount = 0;
    let deepScanMutationStart = null;
    // Kept central so a future setting can switch LOW traversal back on without
    // changing the planner or any discovery code.
    const skipLowPriorityContainers = true;
    const edgeLoadWaitMs = Math.max(5000, maximumSettleMs);
    const edgeLoadPollMs = 100;
    const isActive = () => signal?.aborted !== true;
    const getElapsedMs = () => Math.max(0, Math.round(performance.now() - startedAtPerformance));
    const createPerformanceMetrics = () => ({
        steps: 0,
        scrollActionMs: 0,
        settleMs: 0,
        collectSourcesMs: 0,
        scanImagesMs: 0,
        carouselPhotoSwipeMs: 0,
        candidatePipelineMs: 0,
        newSources: 0,
        newRawCandidates: 0,
        newDomImages: 0,
        newTargets: 0,
        newGalleries: 0,
        mutationStart: null
    });
    const addMetric = (metrics, name, value) => {
        if (!metrics || !Number.isFinite(value)) return;

        metrics[name] = (metrics[name] ?? 0) + value;
        if (currentPassMetrics && currentPassMetrics !== metrics) {
            currentPassMetrics[name] = (currentPassMetrics[name] ?? 0) + value;
        }
    };
    const recordCollectionMetric = (metrics, name, value) => {
        addMetric(metrics, name, value);
        if (currentPassMetrics && !metrics) {
            currentPassMetrics[name] = (currentPassMetrics[name] ?? 0) + value;
        }
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
    const getScrollElement = () => document.scrollingElement ?? document.documentElement;
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
        total: observedMutationCount,
        childList: observedChildListMutationCount,
        attributes: observedAttributeMutationCount,
        addedElements: observedAddedElementCount,
        removedElements: observedRemovedElementCount,
        relevantTotal: relevantMutationCount,
        relevantChildList: relevantChildListMutationCount,
        relevantAttributes: relevantAttributeMutationCount,
        relevantAddedElements: relevantAddedElementCount,
        relevantRemovedElements: relevantRemovedElementCount
    });
    const getMutationDelta = (before) => ({
        total: Math.max(0, observedMutationCount - before.total),
        childList: Math.max(0, observedChildListMutationCount - before.childList),
        attributes: Math.max(0, observedAttributeMutationCount - before.attributes),
        addedElements: Math.max(0, observedAddedElementCount - before.addedElements),
        removedElements: Math.max(0, observedRemovedElementCount - before.removedElements),
        relevantTotal: Math.max(0, relevantMutationCount - before.relevantTotal),
        relevantChildList: Math.max(
            0,
            relevantChildListMutationCount - before.relevantChildList
        ),
        relevantAttributes: Math.max(
            0,
            relevantAttributeMutationCount - before.relevantAttributes
        ),
        relevantAddedElements: Math.max(
            0,
            relevantAddedElementCount - before.relevantAddedElements
        ),
        relevantRemovedElements: Math.max(
            0,
            relevantRemovedElementCount - before.relevantRemovedElements
        )
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
    const reportActiveScrollContainer = (container = null, colorIndex = 0) => {
        if (typeof onActiveScrollContainer !== 'function') return;

        try {
            onActiveScrollContainer(container, colorIndex);
        } catch {
            // The temporary visible-tab marker must never affect the hidden traversal.
        }
    };
    const collectSources = async ({diagnosticPhase = null, metrics = null, context = null} = {}) => {
        if (!isActive()) return 0;

        const collectionStartedAt = performance.now();
        const scanImagesStartedAt = performance.now();
        const foundCandidates = await scanImages(
            ignoreHiddenImages,
            true,
            true,
            null,
            true
        );
        const scanImagesMs = performance.now() - scanImagesStartedAt;
        const carouselStartedAt = performance.now();
        const photoSwipeCandidates = await scanPhotoSwipeImages({
            processedTargets: processedPhotoSwipeTargets,
            processedTargetSources: processedPhotoSwipeTargetSources,
            processedCarouselRoots,
            signal,
            onDiagnostic: (message) => console.info('[DeepScan ZOOM]', message),
            onCarouselDiagnostic: (event, ...details) => {
                if (event === 'CAROUSEL' && details.includes('discovered')) {
                    recordCollectionMetric(metrics, 'newGalleries', 1);
                }
                console.info(`[DeepScan ${event}]`, ...details);
            },
            onActivity: () => {
                photoSwipeActivityCount += 1;
            },
            traverseCarousel: true
        });
        const carouselPhotoSwipeMs = performance.now() - carouselStartedAt;
        const candidatePipelineStartedAt = performance.now();
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
        if (newCandidates.length > 0) {
            const discoveredAt = getElapsedMs();
            lastNewSourceAt = discoveredAt;
            lastRawCandidateAt = discoveredAt;
            recordCollectionMetric(metrics, 'newSources', newCandidates.length);
            recordCollectionMetric(metrics, 'newRawCandidates', newCandidates.length);
        }
        if (newCandidates.length > 0 && typeof onBatch === 'function' && isActive()) {
            const diagnostic = {
                id: `${startedAt}-${++progressDiagnosticBatchSequence}`,
                phase: diagnosticPhase ?? context?.scope ?? 'deep-scan',
                rawCandidates: newCandidates.length,
                collection: ++collectionSequence,
                ...(Number.isInteger(context?.pass) ? {pass: context.pass} : {}),
                ...(typeof context?.container === 'string' ? {container: context.container} : {}),
                ...(typeof context?.direction === 'string' ? {direction: context.direction} : {}),
                scanImagesMs: Math.round(scanImagesMs),
                carouselPhotoSwipeMs: Math.round(carouselPhotoSwipeMs),
                ...candidateClasses
            };
            console.info(
                '[DeepScan CANDIDATE CLASS]',
                `phase=${diagnostic.phase}`,
                `collection=${diagnostic.collection}`,
                ...(Number.isInteger(diagnostic.pass) ? [`pass=${diagnostic.pass}`] : []),
                ...(diagnostic.container ? [`container=${diagnostic.container}`] : []),
                ...(diagnostic.direction ? [`direction=${diagnostic.direction}`] : []),
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
            await onBatch(newCandidates, diagnostic);
        }
        const candidatePipelineMs = performance.now() - candidatePipelineStartedAt;
        const collectionMs = performance.now() - collectionStartedAt;
        recordCollectionMetric(metrics, 'scanImagesMs', scanImagesMs);
        recordCollectionMetric(metrics, 'carouselPhotoSwipeMs', carouselPhotoSwipeMs);
        recordCollectionMetric(metrics, 'candidatePipelineMs', candidatePipelineMs);
        recordCollectionMetric(metrics, 'collectSourcesMs', collectionMs);
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
    const countMutationElements = (nodes) => Array.from(nodes ?? []).reduce((count, node) => {
        if (node?.nodeType === Node.ELEMENT_NODE) return count + 1;
        if (node?.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return count;
        return count + (node.querySelectorAll?.('*').length ?? 0);
    }, 0);
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
    const containerAnalyses = new WeakMap();
    const getClassTokens = (element) => String(element?.getAttribute?.('class') ?? '')
        .split(/\s+/)
        .map((token) => token.trim().toLowerCase())
        .filter((token) => /^[a-z][a-z-]{1,40}$/.test(token))
        .slice(0, 4);
    const getStructureAttributeNames = (element) => Array.from(element?.attributes ?? [])
        .map((attribute) => attribute.name.toLowerCase())
        .filter((name) => name === 'role' || name.startsWith('aria-') || name.startsWith('data-'))
        .slice(0, 6);
    const getRowFingerprint = (row) => {
        const childTags = Array.from(row.children ?? [], (child) => child.tagName.toLowerCase())
            .slice(0, 8)
            .join(',');
        const directCounts = ['img', 'svg', 'a', 'button'].map((tagName) =>
            row.querySelectorAll(tagName).length
        ).join(',');

        return [
            row.tagName.toLowerCase(),
            getClassTokens(row).join(','),
            row.getAttribute?.('role') ?? '',
            getStructureAttributeNames(row).join(','),
            childTags,
            directCounts
        ].join('|');
    };
    const getImageDimensions = (image) => {
        let width = Math.max(0, image?.naturalWidth ?? 0, Number(image?.getAttribute?.('width')) || 0);
        let height = Math.max(0, image?.naturalHeight ?? 0, Number(image?.getAttribute?.('height')) || 0);

        if (width > 0 && height > 0) return {width: Math.round(width), height: Math.round(height)};

        try {
            const rect = image.getBoundingClientRect();
            width = Math.max(width, Math.round(rect.width));
            height = Math.max(height, Math.round(rect.height));
        } catch {
            // A removed page element is not relevant for the passive diagnosis.
        }
        return {width, height};
    };
    const analyzeScrollContainer = (container) => {
        const directGroups = [container, ...Array.from(container.children ?? [])]
            .map((element) => ({element, rows: Array.from(element.children ?? [])}))
            .filter(({rows}) => rows.length >= 4)
            .sort((first, second) => second.rows.length - first.rows.length);
        const rowGroup = directGroups[0] ?? {element: container, rows: []};
        const rows = rowGroup.rows;
        const sampledRows = rows.slice(0, 160);
        const fingerprints = new Map();
        sampledRows.forEach((row) => {
            const fingerprint = getRowFingerprint(row);
            fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + 1);
        });
        const dominantStructureCount = Math.max(0, ...fingerprints.values());
        const repeatedStructureRatio = sampledRows.length > 0
            ? dominantStructureCount / sampledRows.length
            : 0;
        const hasRepeatedRows = rows.length >= 4 && repeatedStructureRatio >= .7;
        const images = Array.from(container.querySelectorAll('img'));
        const links = container.querySelectorAll('a').length;
        const buttons = container.querySelectorAll('button').length;
        const svgs = container.querySelectorAll('svg').length;
        const videos = container.querySelectorAll('video').length;
        const mediaElements = container.querySelectorAll('picture, source, video').length;
        const sizeCounts = new Map();
        let smallImageCount = 0;
        let largeEnoughImageCount = 0;

        images.forEach((image) => {
            const {width, height} = getImageDimensions(image);
            if (width <= 0 || height <= 0) return;

            const key = `${width}x${height}`;
            sizeCounts.set(key, (sizeCounts.get(key) ?? 0) + 1);
            if (width < minimumImageWidth || height < minimumImageHeight) smallImageCount += 1;
            else largeEnoughImageCount += 1;
        });
        const [dominantImageSize = 'none', dominantImageSizeCount = 0] =
            [...sizeCounts.entries()].sort((first, second) => second[1] - first[1])[0] ?? [];
        const dominantImageSizeRatio = images.length > 0 ? dominantImageSizeCount / images.length : 0;
        const [dominantImageWidth = 0, dominantImageHeight = 0] = dominantImageSize
            .split('x')
            .map(Number);
        const dominantImageIsSmall = dominantImageWidth > 0 && dominantImageHeight > 0 &&
            (dominantImageWidth < minimumImageWidth || dominantImageHeight < minimumImageHeight);
        const dominantImageIsAvatarSized = dominantImageWidth > 0 && dominantImageHeight > 0 &&
            Math.max(dominantImageWidth, dominantImageHeight) <= 192;
        const eligibleImageRatio = images.length > 0 ? largeEnoughImageCount / images.length : 0;
        const semanticElements = [container, ...Array.from(container.querySelectorAll('*')).slice(0, 200)];
        const semanticStructure = semanticElements.map((element) => [
            ...getClassTokens(element),
            element.getAttribute?.('role') ?? '',
            ...getStructureAttributeNames(element)
        ].join(' ')).join(' ');
        const navigationSemantic = /\b(?:menu|navigation|nav|icon|sidebar|toolbar)\b/i.test(
            semanticStructure
        );
        const inboxSemantic = /\b(?:user|avatar|message|chat|conversation|inbox|thread)\b/i.test(
            semanticStructure
        );
        const contentSemantic = /\b(?:media|gallery|carousel|slide|poster|picture|source)\b/i.test(
            semanticStructure
        );
        const containerTag = container.tagName.toLowerCase();
        const hasNavigationLandmark = containerTag === 'nav' || containerTag === 'aside' ||
            container.querySelector('nav, aside') !== null;
        const hasContentLandmark = containerTag === 'main' || containerTag === 'article';
        const positiveSignals = [];
        const negativeSignals = [];
        let navigationStrength = 0;
        let inboxStrength = 0;
        let contentStrength = 0;

        if (hasRepeatedRows) {
            negativeSignals.push(`repeated-rows=${rows.length}`);
            if (dominantImageIsSmall && dominantImageSizeRatio >= .6) {
                negativeSignals.push(`dominant-small-images=${dominantImageSize}`);
            }
        }
        if (hasRepeatedRows && hasNavigationLandmark) {
            navigationStrength += 3;
            negativeSignals.push('navigation-landmark-with-repeated-rows');
        }
        if (hasRepeatedRows && (links + buttons + svgs) >= Math.max(4, rows.length / 2)) {
            navigationStrength += 2;
            negativeSignals.push('repeated-interactive-or-icon-rows');
        }
        if (hasRepeatedRows && dominantImageIsSmall && dominantImageSizeRatio >= .6) {
            navigationStrength += 1;
        }
        if (hasRepeatedRows && navigationSemantic) {
            navigationStrength += 1;
            negativeSignals.push('navigation-structure-token');
        }
        if (hasRepeatedRows && dominantImageIsAvatarSized && dominantImageSizeRatio >= .6) {
            inboxStrength += 3;
            negativeSignals.push('repeated-avatar-or-thumbnail-rows');
        }
        if (hasRepeatedRows && dominantImageIsAvatarSized && inboxSemantic) {
            inboxStrength += 1;
            negativeSignals.push('inbox-structure-token');
        }
        if (largeEnoughImageCount > 0) {
            contentStrength += 2;
            positiveSignals.push(`eligible-images=${largeEnoughImageCount}/${images.length}`);
        }
        if (sizeCounts.size >= 3) {
            contentStrength += 1;
            positiveSignals.push(`diverse-image-sizes=${sizeCounts.size}`);
        }
        if (contentSemantic && (mediaElements > 0 || largeEnoughImageCount > 0)) {
            contentStrength += 2;
            positiveSignals.push('media-or-gallery-structure');
        }
        if (videos > 0 || hasContentLandmark) {
            contentStrength += 1;
            positiveSignals.push('content-landmark-or-video');
        }

        let classification = 'unknown';
        if (navigationStrength >= 4 && navigationStrength >= inboxStrength &&
            navigationStrength >= contentStrength) {
            classification = 'navigation';
        } else if (inboxStrength >= 3 && inboxStrength > contentStrength) {
            classification = 'list/inbox';
        } else if (contentStrength >= 2) {
            classification = 'content';
        } else if (navigationStrength > 0 || inboxStrength > 0 || contentStrength > 0) {
            classification = 'mixed';
        }
        const baseScore = Math.max(0, Math.min(
            100,
            50 + contentStrength * 12 - navigationStrength * 14 - inboxStrength * 9
        ));
        const score = classification === 'navigation' ? Math.min(10, baseScore) : baseScore;
        const suggestedAction = classification === 'navigation' ? 'skip' :
            classification === 'list/inbox' ? 'deprioritize' :
                classification === 'content' ? 'scan-first' : 'normal';
        const hasStrongEligibleMedia = largeEnoughImageCount >= 3 &&
            (eligibleImageRatio >= .35 || sizeCounts.size >= 3) &&
            (contentSemantic || mediaElements > 0 || videos > 0 || hasContentLandmark);
        const hasStructuredMediaContent = contentSemantic &&
            (mediaElements > 0 || videos > 0 || largeEnoughImageCount >= 3);
        const hasStrongContentSignals = hasStrongEligibleMedia || hasStructuredMediaContent ||
            (hasContentLandmark && largeEnoughImageCount >= 3);
        const clearNavigationPattern = classification === 'navigation' && hasRepeatedRows &&
            hasNavigationLandmark && navigationSemantic;
        const clearInboxPattern = classification === 'list/inbox' && hasRepeatedRows &&
            dominantImageIsAvatarSized && dominantImageSizeRatio >= .6 && inboxSemantic;
        const priority = classification === 'content' && hasStrongContentSignals
            ? 'high'
            : (clearNavigationPattern || clearInboxPattern) && !hasStrongContentSignals
                ? 'low'
                : 'medium';

        return {
            classification,
            priority,
            score,
            suggestedAction,
            repeatedStructureRatio,
            rowCount: rows.length,
            rowGroupTag: rowGroup.element.tagName?.toLowerCase() ?? 'unknown',
            links,
            buttons,
            svgs,
            imageCount: images.length,
            smallImageCount,
            largeEnoughImageCount,
            eligibleImageRatio,
            dominantImageSize,
            dominantImageSizeRatio,
            distinctImageSizes: sizeCounts.size,
            mediaSignals: mediaElements + videos + Number(contentSemantic),
            positiveSignals,
            negativeSignals
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
    const getContainerAnalysis = (container) => {
        if (!containerAnalyses.has(container)) {
            containerAnalyses.set(container, analyzeScrollContainer(container));
        }
        return containerAnalyses.get(container);
    };
    const logContainerAnalysis = (container, index) => {
        const analysis = getContainerAnalysis(container);
        console.info(
            '[DeepScan CONTAINER ANALYSIS]',
            getContainerLogLabel(container, index),
            `classification=${analysis.classification}`,
            `priority=${analysis.priority}`,
            `score=${analysis.score}`,
            `suggestedAction=${analysis.suggestedAction}`,
            `repeatedStructureRatio=${analysis.repeatedStructureRatio.toFixed(2)}`,
            `rows=${analysis.rowCount}`,
            `rowGroup=${analysis.rowGroupTag}`,
            `links=${analysis.links}`,
            `buttons=${analysis.buttons}`,
            `svg=${analysis.svgs}`,
            `images=${analysis.imageCount}`,
            `smallImages=${analysis.smallImageCount}`,
            `largeEnoughImages=${analysis.largeEnoughImageCount}`,
            `eligibleImageRatio=${analysis.eligibleImageRatio.toFixed(2)}`,
            `dominantImageSize=${analysis.dominantImageSize}`,
            `dominantImageSizeRatio=${analysis.dominantImageSizeRatio.toFixed(2)}`,
            `distinctImageSizes=${analysis.distinctImageSizes}`,
            `mediaSignals=${analysis.mediaSignals}`,
            `positiveSignals=${analysis.positiveSignals.join(',') || 'none'}`,
            `negativeSignals=${analysis.negativeSignals.join(',') || 'none'}`
        );
        return analysis;
    };
    const getContainerPlanLabel = (container, index) => {
        const id = typeof container?.id === 'string' ? container.id.trim() : '';
        return id ? `#${id}` : `?=${index}`;
    };
    const createContainerPlan = (containers) => {
        const entries = containers.map((container) => {
            const isNewContainer = !knownScrollContainerIndices.has(container);
            const index = getScrollContainerIndex(container);
            const analysis = getContainerAnalysis(container);
            return {container, index, analysis, priority: analysis.priority, isNewContainer};
        });
        const high = entries.filter((entry) => entry.priority === 'high');
        const medium = entries.filter((entry) => entry.priority === 'medium');
        const low = entries.filter((entry) => entry.priority === 'low');
        const skipped = skipLowPriorityContainers ? low : [];
        const scanEntries = skipLowPriorityContainers
            ? [...high, ...medium]
            : [...high, ...medium, ...low];

        return {entries, high, medium, low, skipped, scanEntries};
    };
    const logContainerPriority = (entry) => {
        const action = entry.priority === 'low' && skipLowPriorityContainers ? 'skip' : 'scan';
        console.info(
            '[DeepScan CONTAINER PRIORITY]',
            `container=${getContainerPlanLabel(entry.container, entry.index)}`,
            `classification=${entry.analysis.classification}`,
            `priority=${entry.priority}`,
            `score=${entry.analysis.score}`,
            `action=${action}`,
            ...(action === 'skip' ? ['reason=low-priority-policy'] : [])
        );
    };
    const logContainerPlan = (plan) => {
        const labels = (entries) => entries.map(({container, index}) =>
            getContainerPlanLabel(container, index)
        ).join(',');
        console.info(
            '[DeepScan CONTAINER PLAN]',
            `high=[${labels(plan.high)}]`,
            `medium=[${labels(plan.medium)}]`,
            `low=[${labels(plan.low)}]`,
            `skipLowPriorityContainers=${skipLowPriorityContainers}`,
            `scanOrder=[${labels(plan.scanEntries)}]`,
            `skipped=[${labels(plan.skipped)}]`
        );
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
    const logContainerPerformance = (container, index, direction, result, metrics, durationMs) => {
        const mutations = getMutationDelta(metrics.mutationStart ?? getMutationSnapshot());
        const otherMs = Math.max(
            0,
            durationMs - metrics.scrollActionMs - metrics.settleMs - metrics.collectSourcesMs
        );
        console.info(
            '[DeepScan CONTAINER PERF]',
            `container=${getContainerLogLabel(container, index)}`,
            `direction=${direction}`,
            `result=${result}`,
            `durationMs=${Math.round(durationMs)}`,
            `steps=${metrics.steps}`,
            `scrollActionMs=${Math.round(metrics.scrollActionMs)}`,
            `settleMs=${Math.round(metrics.settleMs)}`,
            `collectSourcesMs=${Math.round(metrics.collectSourcesMs)}`,
            `scanImagesMs=${Math.round(metrics.scanImagesMs)}`,
            `carouselPhotoSwipeMs=${Math.round(metrics.carouselPhotoSwipeMs)}`,
            `candidatePipelineMs=${Math.round(metrics.candidatePipelineMs)}`,
            `otherMs=${Math.round(otherMs)}`,
            `newSources=${metrics.newSources}`,
            `newRawCandidates=${metrics.newRawCandidates}`,
            'newAcceptedCandidates=pipeline-reported',
            `newDomImages=${metrics.newDomImages}`,
            `newTargets=${metrics.newTargets}`,
            `mutations=${mutations.total}`,
            `mutationChildList=${mutations.childList}`,
            `mutationAttributes=${mutations.attributes}`,
            `mutationAddedElements=${mutations.addedElements}`,
            `mutationRemovedElements=${mutations.removedElements}`,
            `relevantMutations=${mutations.relevantTotal}`
        );
    };
    const logPassSummary = (pass, metrics, durationMs, repeat, repeatReasons, newContainers) => {
        const mutations = getMutationDelta(metrics.mutationStart ?? getMutationSnapshot());
        console.info(
            '[DeepScan PASS SUMMARY]',
            `pass=${pass}`,
            `durationMs=${Math.round(durationMs)}`,
            `newSources=${metrics.newSources}`,
            `newCandidates=${metrics.newRawCandidates}`,
            `newImages=${metrics.newDomImages}`,
            `newContainers=${newContainers}`,
            `newGalleries=${metrics.newGalleries}`,
            `mutations=${mutations.total}`,
            `mutationChildList=${mutations.childList}`,
            `mutationAttributes=${mutations.attributes}`,
            `mutationAddedElements=${mutations.addedElements}`,
            `mutationRemovedElements=${mutations.removedElements}`,
            `relevantMutations=${mutations.relevantTotal}`,
            `lastNewSourceAt=${lastNewSourceAt ?? 'none'}`,
            `lastRawCandidateAt=${lastRawCandidateAt ?? 'none'}`,
            'lastAcceptedCandidateAt=pipeline-reported',
            `repeat=${repeat}`,
            `repeatReasons=${repeatReasons.join(',') || 'none'}`
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
        const directionMetrics = createPerformanceMetrics();
        directionMetrics.mutationStart = getMutationSnapshot();
        const containerLabel = getContainerLogLabel(container, index);
        let directionFinished = false;

        const finishContainerScan = (result) => {
            if (!directionFinished) {
                directionFinished = true;
                logContainerPerformance(
                    container,
                    index,
                    direction,
                    result,
                    directionMetrics,
                    performance.now() - directionStartedAt
                );
            }
            return result;
        };

        logContainerDirection(label, container, index);

        while (isActive() && container.isConnected && isRelevantScrollableContainer(container)) {
            addMetric(directionMetrics, 'steps', 1);
            const before = getContainerMetrics(container);
            const atEdge = direction === 'up'
                ? isAtContainerTop(before)
                : isAtContainerBottom(before);
            const mutationsBefore = getMutationSnapshot();

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
            const settled = await waitForSettle({minimumMs: atEdge ? 400 : minimumSettleMs});
            addMetric(directionMetrics, 'settleMs', performance.now() - settleStartedAt);
            if (!settled) {
                return finishContainerScan('aborted');
            }

            let newCandidates = await collectSources({
                metrics: directionMetrics,
                context: {
                    scope: 'container',
                    pass: deepScanPass,
                    container: containerLabel,
                    direction
                }
            });
            registerTargets();
            let after = getContainerMetrics(container);
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = Math.max(0, after.targets - before.targets);
            const mutations = getMutationDelta(mutationsBefore).relevantTotal;
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
                if (!isActive()) return finishContainerScan('aborted');

                if (rangeGrewAfterEdgeWait) {
                    newCandidates += await collectSources({
                        metrics: directionMetrics,
                        context: {
                            scope: 'container',
                            pass: deepScanPass,
                            container: containerLabel,
                            direction
                        }
                    });
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
                    return finishContainerScan('stable');
                }
            }
        }

        if (isActive()) {
            logContainerDirection(`${label} END`, container, index, {
                reason: 'stable',
                durationMs: performance.now() - directionStartedAt
            });
            return finishContainerScan('stable');
        }

        return finishContainerScan('aborted');
    };
    const scanRelevantScrollContainers = async () => {
        while (isActive()) {
            const containers = getPendingRelevantScrollContainers();
            if (containers.length === 0) return;

            const plan = createContainerPlan(containers);
            for (const entry of plan.entries) {
                const {container, index} = entry;
                if (entry.isNewContainer) {
                    logContainerAnalysis(container, index);
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
                logContainerPriority(entry);
            }
            logContainerPlan(plan);

            for (const {container} of plan.skipped) {
                if (container.isConnected && isRelevantScrollableContainer(container)) {
                    completedScrollContainerStates.set(
                        container,
                        getContainerTraversalState(container)
                    );
                }
            }

            for (const {container, index} of plan.scanEntries) {
                if (!container.isConnected || !isRelevantScrollableContainer(container)) continue;

                reportActiveScrollContainer(container, index);
                try {
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
                } finally {
                    reportActiveScrollContainer();
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
                    : null,
                metrics: currentPassMetrics,
                context: {scope: 'document', pass: deepScanPass, direction}
            });
            let afterNewTargets = registerTargets();
            let after = getMetrics();
            let newImages = Math.max(0, after.images - before.images);
            let newTargets = beforeNewTargets + afterNewTargets;
            const mutationDelta = getMutationDelta(mutationsBefore);
            const mutations = mutationDelta.relevantTotal;
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
                            : null,
                        metrics: currentPassMetrics,
                        context: {scope: 'document', pass: deepScanPass, direction}
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
            addMetric(currentPassMetrics, 'newDomImages', newImages);
            addMetric(currentPassMetrics, 'newTargets', newTargets);

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
                        `mutations=${mutationDelta.total}`,
                        `mutationChildList=${mutationDelta.childList}`,
                        `mutationAttributes=${mutationDelta.attributes}`,
                        `mutationAddedElements=${mutationDelta.addedElements}`,
                        `mutationRemovedElements=${mutationDelta.removedElements}`,
                        `relevantMutations=${mutations}`,
                        `relevantMutationChildList=${mutationDelta.relevantChildList}`,
                        `relevantMutationAttributes=${mutationDelta.relevantAttributes}`,
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
                records.forEach((record) => {
                    observedMutationCount += 1;
                    if (record.type === 'attributes') {
                        observedAttributeMutationCount += 1;
                        return;
                    }

                    observedChildListMutationCount += 1;
                    observedAddedElementCount += countMutationElements(record.addedNodes);
                    observedRemovedElementCount += countMutationElements(record.removedNodes);
                });
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
                ]
            });
        }

        const readinessDeadline = Date.now() + DEEP_SCAN_READINESS_MAX_WAIT_MS;
        deepScanMutationStart = getMutationSnapshot();
        while (isActive() && (window.innerWidth <= 0 || window.innerHeight <= 0 ||
            document.readyState === 'loading') && Date.now() < readinessDeadline) {
            if (!(await wait(DEEP_SCAN_READINESS_POLL_INTERVAL_MS))) break;
        }

        registerTargets();
        await collectSources({context: {scope: 'initial'}});
        while (isActive()) {
            const pass = ++deepScanPass;
            const passStartedAt = performance.now();
            const passMetrics = createPerformanceMetrics();
            passMetrics.mutationStart = getMutationSnapshot();
            const containersAtPassStart = knownScrollContainerIndices.size;
            currentPassMetrics = passMetrics;
            console.info('[DeepScan PASS START]', `pass=${pass}`);
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
            const newCandidates = await collectSources({
                metrics: passMetrics,
                context: {scope: 'final-settle', pass}
            });
            const newTargets = registerTargets();
            addMetric(passMetrics, 'newTargets', newTargets);
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
            const repeatReasons = [];
            if (documentChangedAfterDirections) repeatReasons.push('document-scroll-range-changed');
            if (pendingContainers.length > 0) repeatReasons.push('container-still-open');
            if (newContainersDetected) repeatReasons.push('new-container-discovered');

            logPassSummary(
                pass,
                passMetrics,
                performance.now() - passStartedAt,
                repeatPass,
                repeatReasons,
                Math.max(0, knownScrollContainerIndices.size - containersAtPassStart)
            );
            currentPassMetrics = null;

            if (!repeatPass) {
                console.info('[DeepScan PASS] complete');
                completedNaturally = true;
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
        observer?.disconnect();
        currentPassMetrics = null;
        reportActiveScrollContainer();
    }

    const status = signal?.aborted === true ? 'cancelled' : 'completed';
    if (status === 'completed' && completedNaturally) {
        const mutations = getMutationDelta(deepScanMutationStart ?? getMutationSnapshot());
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
        const mutations = getMutationDelta(deepScanMutationStart ?? getMutationSnapshot());
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

    return {
        status,
        endReason: status === 'cancelled' ? 'aborted' : 'stable'
    };
}

export function getPageURL() {
    return window.location.href;
}
