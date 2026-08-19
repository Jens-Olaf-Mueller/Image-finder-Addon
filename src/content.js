(() => {
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

    const isLinkedImageURL = (url) => {
        if (isDataImageURL(url)) return true;

        try {
            const {protocol, pathname} = new URL(url);

            if (!['http:', 'https:', 'file:'].includes(protocol)) return false;

            return /\.(?:jpe?g|png|gif|webp|svg|avif)$/i.test(pathname);
        } catch {
            return false;
        }
    };

    const images = [];

    // ❌
    // const seen = new Set();
    //
    // const addCandidate = (url, width, height, source) => {
    //     const key = `${source}:${url}`;
    //     if (!url || seen.has(key)) return;
    //     seen.add(key);
    //     images.push({
    //         url,
    //         width,
    //         height,
    //         source
    //     });
    // };

    const addCandidate = (url, width, height, source) => {
        if (!url) return;

        images.push({
            url,
            width,
            height,
            // ❌ source
            source: isDataImageURL(url) ? 'dataimages' : source
        });
    };

    for (const img of document.images) {
        const currentSrc = getURL(img.currentSrc);
        const src = getURL(img.getAttribute('src'));
        const srcset = getPreferredSrcsetURL(img.getAttribute('srcset'));
        const dataSrc = getURL(img.getAttribute('data-src'));
        const dataSrcset = getPreferredSrcsetURL(img.getAttribute('data-srcset'));
        const hasLazySource = Boolean(dataSrc || dataSrcset);
        const currentSrcLooksLikePlaceholder = hasLazySource && (!currentSrc || currentSrc === src);

        let url = currentSrc;
        if (currentSrcLooksLikePlaceholder) url = dataSrcset || dataSrc;
        url ??= srcset || src;
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
            const backgroundImage = getComputedStyle(element).backgroundImage;
            for (const url of getBackgroundURLs(backgroundImage)) {
                addCandidate(url, 0, 0, 'backgroundimages');
            }
        } catch {
            continue;
        }
    }

    for (const link of document.querySelectorAll('a[href]')) {
        const url = getURL(link.href);

        if (!isLinkedImageURL(url)) continue;

        addCandidate(url, 0, 0, 'linkedimages');
    }

    return images;
})();
