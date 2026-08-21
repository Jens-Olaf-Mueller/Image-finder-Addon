export function scanImages(ignoreHiddenImages = false) {
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

    const isLinkedImageURL = (url) => {
        if (isDataImageURL(url)) return true;

        try {
            const {protocol, pathname} = new URL(url);

            if (!['http:', 'https:'].includes(protocol)) return false;

            return /\.(?:jpe?g|png|gif|webp|svg|avif)$/i.test(pathname);
        } catch {
            return false;
        }
    };

    const images = [];

    const addCandidate = (url, width, height, source) => {
        if (!url) return;

        images.push({
            url,
            width,
            height,
            source: isDataImageURL(url) ? 'dataimages' : source
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
            'imageelements'
        );
    }

    for (const element of document.querySelectorAll('*')) {
        try {
            const style = getComputedStyle(element);
            if (isHidden(element, style)) continue;

            const backgroundImage = style.backgroundImage;
            for (const url of getBackgroundURLs(backgroundImage)) {
                addCandidate(url, 0, 0, 'backgroundimages');
            }
        } catch {
            continue;
        }
    }

    for (const link of document.querySelectorAll('a[href]')) {
        if (isHidden(link)) continue;

        const url = getURL(link.href);

        if (!isLinkedImageURL(url)) continue;

        addCandidate(url, 0, 0, 'linkedimages');
    }

    return images;
}
