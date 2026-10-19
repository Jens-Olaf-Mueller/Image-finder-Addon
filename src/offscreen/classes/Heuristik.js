export const MAX_ANALYSIS_DIMENSION = 384;
const IMAGE_LOAD_TIMEOUT_MS = 1000;

/**
 * @file Heuristik.js
 * @module Heuristik
 * @version 0.1.12
 * @date 2026-10-04
 * @author Jens-Olaf-Mueller
 *
 * Heuristik - Shared image-analysis preparation and cache access.
 * ===============================================================
 *
 * Provides BlurScanner and DuplicateFinder with a shared, session-scoped cache
 * of normalized luminance data. Source images are decoded, proportionally
 * reduced to the analysis limit, and converted to a Float32Array once per
 * explicit cache key.
 * - Key Features:
 * - Shared analysis cache:  Reuses the injected Map across heuristic consumers.
 * - Normalized preparation: Scales source images to the maximum analysis dimension.
 * - Luminance conversion:   Stores perceptual RGB luminance in a Float32Array.
 * - Input validation:       Rejects missing keys, invalid sources, and unusable images.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link hasAnalysis}     - Checks whether a cache key already has analysis data.
 * - {@link getAnalysis}     - Returns the cached analysis data for a key.
 * - {@link setAnalysis}     - Stores analysis data for a key.
 * - {@link deleteAnalysis}  - Removes analysis data for a key.
 * - {@link clearAnalysis}   - Clears the complete shared analysis cache.
 * - {@link prepareAnalysis} - Decodes, normalizes, converts, and caches an image source.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #loadImage} - Resolves and validates an image element or source URL.
 */
export default class Heuristik {
    #analysisStore;

    constructor(analysisStore) {
        if (!(analysisStore instanceof Map)) {
            throw new TypeError('Heuristik requires an injected analysis store Map');
        }

        this.#analysisStore = analysisStore;
    }

    hasAnalysis(key) {
        return this.#analysisStore.has(key);
    }

    getAnalysis(key) {
        return this.#analysisStore.get(key);
    }

    setAnalysis(key, value) {
        this.#analysisStore.set(key, value);
    }

    deleteAnalysis(key) {
        return this.#analysisStore.delete(key);
    }

    clearAnalysis() {
        this.#analysisStore.clear();
    }

    async prepareAnalysis(source, key, {onTiming = null} = {}) {
        if (key === null || key === undefined || key === '') {
            throw new TypeError('An explicit analysis cache key is required');
        }
        if (this.hasAnalysis(key)) {
            onTiming?.({stage: 'cache'});
            return this.getAnalysis(key);
        }

        const imageLoadStartedAt = performance.now();
        let image;
        try {
            image = await this.#loadImage(source);
            onTiming?.({
                stage: 'imageLoad',
                durationMs: performance.now() - imageLoadStartedAt,
                failed: false
            });
        } catch (error) {
            onTiming?.({
                stage: 'imageLoad',
                durationMs: performance.now() - imageLoadStartedAt,
                failed: true
            });
            throw error;
        }

        const preparationStartedAt = performance.now();
        try {
            const sourceWidth = image.naturalWidth;
            const sourceHeight = image.naturalHeight;
            const scale = Math.min(
                1,
                MAX_ANALYSIS_DIMENSION / Math.max(sourceWidth, sourceHeight)
            );
            const width = Math.max(1, Math.round(sourceWidth * scale));
            const height = Math.max(1, Math.round(sourceHeight * scale));
            const canvas = document.createElement('canvas');

            canvas.width = width;
            canvas.height = height;

            const context = canvas.getContext('2d', {willReadFrequently: true});
            if (!context) throw new Error('Cannot create analysis canvas context');

            context.drawImage(image, 0, 0, width, height);

            const {data} = context.getImageData(0, 0, width, height);
            const luminance = new Float32Array(width * height);

            for (let pixelIndex = 0, luminanceIndex = 0;
                pixelIndex < data.length;
                pixelIndex += 4, luminanceIndex += 1) {
                luminance[luminanceIndex] =
                    data[pixelIndex] * 0.2126 +
                    data[pixelIndex + 1] * 0.7152 +
                    data[pixelIndex + 2] * 0.0722;
            }

            const analysis = {
                sourceWidth,
                sourceHeight,
                width,
                height,
                luminance
            };

            this.setAnalysis(key, analysis);
            onTiming?.({
                stage: 'preparation',
                durationMs: performance.now() - preparationStartedAt,
                failed: false
            });
            return analysis;
        } catch (error) {
            onTiming?.({
                stage: 'preparation',
                durationMs: performance.now() - preparationStartedAt,
                failed: true
            });
            throw error;
        }
    }

    async #loadImage(source) {
        const isImageElement = typeof HTMLImageElement !== 'undefined' &&
            source instanceof HTMLImageElement;
        const image = isImageElement
            ? source
            : typeof source === 'string' && source
                ? new Image()
                : null;

        if (!image) {
            throw new TypeError('Image source must be an HTMLImageElement or source URL');
        }
        // ✏️ EDIT 2026-10-08: Offscreen image.decode() may never settle for a valid source.
        await this.#waitForImageLoad(image, {
            source: isImageElement ? null : source,
            cancelOnTimeout: !isImageElement
        });

        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
            throw new Error('Image has no analyzable dimensions');
        }

        return image;
    }

    async #waitForImageLoad(image, {source = null, cancelOnTimeout = false} = {}) {
        await new Promise((resolve, reject) => {
            let settled = false;
            let timeoutId = null;
            const finish = (callback) => {
                if (settled) return;

                settled = true;
                window.clearTimeout(timeoutId);
                image.removeEventListener('load', onLoad);
                image.removeEventListener('error', onError);
                callback();
            };
            const onLoad = () => finish(resolve);
            const onError = () => finish(() => reject(new Error('Cannot load image for analysis')));

            image.addEventListener('load', onLoad, {once: true});
            image.addEventListener('error', onError, {once: true});
            timeoutId = window.setTimeout(() => {
                // ✴️ NEW 2026-10-08: Do not let one source delay the whole offscreen pipeline.
                if (cancelOnTimeout) image.removeAttribute('src');
                finish(() => reject(new Error(
                    `Image loading timed out after ${IMAGE_LOAD_TIMEOUT_MS} ms`
                )));
            }, IMAGE_LOAD_TIMEOUT_MS);

            if (source !== null) image.src = source;

            if (!image.complete) return;
            if (image.naturalWidth > 0 && image.naturalHeight > 0) {
                finish(resolve);
            } else {
                finish(() => reject(new Error('Image has no analyzable dimensions')));
            }
        });
    }
}
