export async function scanImages(ignoreHiddenImages = false) {
    const getURL = (value) => {
        if (typeof value !== 'string' || !value.trim()) return null;

        try {
            return new URL(value.trim(), document.baseURI).href;
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

    const elements = Array.from(document.querySelectorAll('*'));
    const backdropBlurElements = new Set();
    const initialScrollPosition = {x: window.scrollX, y: window.scrollY};
    let scrollPositionChanged = false;

    for (const element of elements) {
        try {
            const style = getComputedStyle(element);
            if (hasBackdropBlur(style) && isVisibleBackdropElement(element, style)) {
                backdropBlurElements.add(element);
            }
        } catch {
            continue;
        }
    }

    const rectanglesOverlap = (first, second) => {
        const firstRight = first.right ?? first.left + first.width;
        const firstBottom = first.bottom ?? first.top + first.height;
        const secondRight = second.right ?? second.left + second.width;
        const secondBottom = second.bottom ?? second.top + second.height;

        return first.left < secondRight && firstRight > second.left &&
            first.top < secondBottom && firstBottom > second.top;
    };

    const hasPotentialBackdropOverlap = (rect) => {
        for (const backdropElement of backdropBlurElements) {
            try {
                if (rectanglesOverlap(rect, backdropElement.getBoundingClientRect())) {
                    return true;
                }
            } catch {
                continue;
            }
        }

        return false;
    };

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
            let rect = element.getBoundingClientRect();
            if (rect.width <= 0 || rect.height <= 0) return false;

            const getStackedElementsAtCenter = () => document.elementsFromPoint(
                rect.left + rect.width / 2,
                rect.top + rect.height / 2
            );
            let stackedElements = getStackedElementsAtCenter();
            let sourceIndex = getSourceStackIndex(stackedElements, element);

            if (sourceIndex === -1 && hasPotentialBackdropOverlap(rect)) {
                window.scrollBy(
                    rect.left + rect.width / 2 - window.innerWidth / 2,
                    rect.top + rect.height / 2 - window.innerHeight / 2
                );
                scrollPositionChanged = true;

                rect = element.getBoundingClientRect();
                stackedElements = getStackedElementsAtCenter();
                sourceIndex = getSourceStackIndex(stackedElements, element);
            }

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

    const addCandidate = (url, width, height, source, element) => {
        if (!url) return;

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

    for (const img of document.images) {
        if (isHidden(img)) continue;

        const currentSrc = getURL(img.currentSrc);
        const src = getURL(img.getAttribute('src'));
        const dataSrc = getURL(img.getAttribute('data-src'));
        const dataSrcset = img.getAttribute('data-srcset');
        const hasLazySource = Boolean(dataSrc || dataSrcset);
        const currentSrcLooksLikePlaceholder = hasLazySource && (!currentSrc || currentSrc === src);

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
            img
        );
    }

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

    if (scrollPositionChanged) {
        window.scrollTo(initialScrollPosition.x, initialScrollPosition.y);
    }

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

    return images;
}
