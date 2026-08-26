export const MAX_ANALYSIS_DIMENSION = 384;

/**
 * Base class for shared image preparation used by BlurScanner and ImageMatcher.
 * The injected store contains session-scoped normalized luminance data.
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

    async prepareAnalysis(imageSource, key) {
        if (key === null || key === undefined || key === '') {
            throw new TypeError('An explicit analysis cache key is required');
        }
        if (this.hasAnalysis(key)) return this.getAnalysis(key);

        const image = await this.#loadImage(imageSource);
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
        return analysis;
    }

    async #loadImage(imageSource) {
        const isImageElement = typeof HTMLImageElement !== 'undefined' &&
            imageSource instanceof HTMLImageElement;
        const image = isImageElement
            ? imageSource
            : typeof imageSource === 'string' && imageSource
                ? new Image()
                : null;

        if (!image) {
            throw new TypeError('Image source must be an HTMLImageElement or source URL');
        }
        if (!isImageElement) image.src = imageSource;

        if (typeof image.decode === 'function') {
            await image.decode();
        } else if (!image.complete) {
            await new Promise((resolve, reject) => {
                image.addEventListener('load', resolve, {once: true});
                image.addEventListener('error', () => {
                    reject(new Error('Cannot load image for analysis'));
                }, {once: true});
            });
        }

        if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
            throw new Error('Image has no analyzable dimensions');
        }

        return image;
    }
}