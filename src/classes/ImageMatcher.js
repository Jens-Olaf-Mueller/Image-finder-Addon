import Heuristik from './Heuristik.js';

const PHASH_SAMPLE_SIZE = 32;
const PHASH_SIZE = 8;
const PHASH_BIT_COUNT = PHASH_SIZE ** 2;
const MATCHER_MODES = new Set(['strict', 'alike']);
export const STRICT_MATCH_THRESHOLD = 4;
const DCT_COSINES = Array.from({length: PHASH_SIZE}, (_, frequency) =>
    Array.from({length: PHASH_SAMPLE_SIZE}, (_, position) =>
        Math.cos(Math.PI * (position + 0.5) * frequency / PHASH_SAMPLE_SIZE)
    )
);

/**
 * Measures visual image identity with a compact perceptual hash.
 * Pipeline grouping and representative selection deliberately remain outside
 * this class while its measurements are calibrated.
 */
export default class ImageMatcher extends Heuristik {
    #mode = 'strict';

    get mode() {
        return this.#mode;
    }

    set mode(value) {
        if (!MATCHER_MODES.has(value)) {
            throw new RangeError(`Unsupported ImageMatcher mode: ${String(value)}`);
        }

        this.#mode = value;
    }

    async compare(imageA, keyA, imageB, keyB) {
        if (this.mode !== 'strict') {
            throw new Error(`ImageMatcher mode "${this.mode}" is not implemented yet`);
        }

        const analysisA = await this.prepareAnalysis(imageA, keyA);
        const analysisB = keyA === keyB
            ? analysisA
            : await this.prepareAnalysis(imageB, keyB);
        const strictFeaturesA = this.#getStrictFeatures(analysisA);
        const strictFeaturesB = this.#getStrictFeatures(analysisB);

        return {
            mode: this.mode,
            hashA: this.#formatHash(strictFeaturesA.hashValue),
            hashB: this.#formatHash(strictFeaturesB.hashValue),
            hammingDistance: this.#getHammingDistance(
                strictFeaturesA.hashValue,
                strictFeaturesB.hashValue
            ),
            normalizedDifference: this.#getNormalizedDifference(
                strictFeaturesA.normalizedLuminance,
                strictFeaturesB.normalizedLuminance
            ),
            reference: this.#getImageInfo(analysisA),
            candidate: this.#getImageInfo(analysisB)
        };
    }

    isStrictMatch(comparison) {
        return Number.isInteger(comparison?.hammingDistance) &&
            comparison.hammingDistance >= 0 &&
            comparison.hammingDistance <= STRICT_MATCH_THRESHOLD;
    }

    #getStrictFeatures(analysis) {
        const cachedFeatures = analysis.strictImageMatcher;

        if (typeof cachedFeatures?.hashValue === 'bigint' &&
            cachedFeatures.normalizedLuminance instanceof Float64Array) {
            return cachedFeatures;
        }

        const normalizedLuminance = this.#normalizeLuminance(analysis);
        const strictFeatures = {
            hashValue: this.#createPerceptualHash(normalizedLuminance),
            normalizedLuminance
        };

        analysis.strictImageMatcher = strictFeatures;
        return strictFeatures;
    }

    #normalizeLuminance(analysis) {
        const normalized = new Float64Array(PHASH_SAMPLE_SIZE ** 2);

        for (let y = 0; y < PHASH_SAMPLE_SIZE; y++) {
            const sourceY = Math.min(
                analysis.height - 1,
                Math.floor((y + 0.5) * analysis.height / PHASH_SAMPLE_SIZE)
            );

            for (let x = 0; x < PHASH_SAMPLE_SIZE; x++) {
                const sourceX = Math.min(
                    analysis.width - 1,
                    Math.floor((x + 0.5) * analysis.width / PHASH_SAMPLE_SIZE)
                );

                normalized[y * PHASH_SAMPLE_SIZE + x] =
                    analysis.luminance[sourceY * analysis.width + sourceX];
            }
        }

        return normalized;
    }

    #createPerceptualHash(normalizedLuminance) {
        const coefficients = new Float64Array(PHASH_BIT_COUNT);
        const firstFrequencyScale = Math.sqrt(1 / PHASH_SAMPLE_SIZE);
        const otherFrequencyScale = Math.sqrt(2 / PHASH_SAMPLE_SIZE);
        let coefficientIndex = 0;

        for (let verticalFrequency = 0;
            verticalFrequency < PHASH_SIZE;
            verticalFrequency++) {
            const verticalScale = verticalFrequency === 0
                ? firstFrequencyScale
                : otherFrequencyScale;

            for (let horizontalFrequency = 0;
                horizontalFrequency < PHASH_SIZE;
                horizontalFrequency++, coefficientIndex++) {
                const horizontalScale = horizontalFrequency === 0
                    ? firstFrequencyScale
                    : otherFrequencyScale;
                let coefficient = 0;

                for (let y = 0; y < PHASH_SAMPLE_SIZE; y++) {
                    const verticalCosine = DCT_COSINES[verticalFrequency][y];
                    const rowOffset = y * PHASH_SAMPLE_SIZE;

                    for (let x = 0; x < PHASH_SAMPLE_SIZE; x++) {
                        coefficient += normalizedLuminance[rowOffset + x] *
                            DCT_COSINES[horizontalFrequency][x] * verticalCosine;
                    }
                }

                coefficients[coefficientIndex] = coefficient * horizontalScale * verticalScale;
            }
        }

        const median = this.#median([...coefficients].slice(1));
        let hash = 0n;

        for (const coefficient of coefficients) {
            hash = (hash << 1n) | (coefficient > median ? 1n : 0n);
        }

        return hash;
    }

    #getNormalizedDifference(normalizedA, normalizedB) {
        let differenceSum = 0;

        for (let index = 0; index < normalizedA.length; index++) {
            differenceSum += Math.abs(normalizedA[index] - normalizedB[index]);
        }

        return differenceSum / (normalizedA.length * 255);
    }

    #getHammingDistance(hashA, hashB) {
        let difference = hashA ^ hashB;
        let count = 0;

        while (difference !== 0n) {
            difference &= difference - 1n;
            count += 1;
        }

        return count;
    }

    #formatHash(hash) {
        return hash.toString(16).padStart(PHASH_BIT_COUNT / 4, '0');
    }

    #getImageInfo(analysis) {
        return {
            sourceWidth: analysis.sourceWidth,
            sourceHeight: analysis.sourceHeight,
            analysisWidth: analysis.width,
            analysisHeight: analysis.height,
            aspectRatio: analysis.sourceWidth / analysis.sourceHeight
        };
    }

    #median(values) {
        const sorted = [...values].sort((first, second) => first - second);
        const middleIndex = Math.floor(sorted.length / 2);

        return sorted.length % 2 === 0
            ? (sorted[middleIndex - 1] + sorted[middleIndex]) / 2
            : sorted[middleIndex];
    }
}
