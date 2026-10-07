import Heuristik from './Heuristik.js';

const SQUARE_ASPECT_RATIO_TOLERANCE = 0.15;
export const GLOBAL_LAPLACIAN_BLUR_THRESHOLD = 75;
export const BLUR_CLASSIFICATIONS = Object.freeze({
    blurred: 'blurred',
    sharp: 'sharp',
    uncertain: 'uncertain'
});

// ✴️ NEW 2026-10-04: Add the required class module JSDoc header.
/**
 * @file BlurScanner.js
 * @module BlurScanner
 * @extends Heuristik
 * @version 0.1.12
 * @date 2026-10-04
 * @author Jens-Olaf-Mueller
 *
 * BlurScanner - Measures image detail for conservative blur classification.
 * ===============================================================
 *
 * Uses the shared normalized luminance analysis supplied by Heuristik to
 * measure global and tile-level image detail. Its adaptive grid and two
 * complementary sharpness metrics provide stable data for later filtering
 * without treating an uncertain image as sharp.
 * - Key Features:
 * - Adaptive grid selection:     Chooses a grid that respects the image aspect ratio.
 * - Dual sharpness metrics:      Calculates Tenengrad energy and Laplacian variance.
 * - Conservative classification: Marks only values below the threshold as blurred.
 * - Tile-level detail:           Returns per-tile and global measurement results.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link measure}  - Measures global and tile-level sharpness information.
 * - {@link classify} - Classifies a measurement as blurred or uncertain.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #selectGrid}    - Selects an aspect-ratio-aware analysis grid.
 * - {@link #measureRegion} - Calculates sharpness metrics for one image region.
 * - {@link #median}        - Returns the median value of a numeric collection.
 */
export default class BlurScanner extends Heuristik {
    async measure(imageSource, key) {
        const analysis = await this.prepareAnalysis(imageSource, key);
        const grid = this.#selectGrid(analysis.width, analysis.height);
        const tiles = [];

        for (let row = 0; row < grid.rows; row++) {
            const startY = Math.floor(row * analysis.height / grid.rows);
            const endY = Math.floor((row + 1) * analysis.height / grid.rows);

            for (let column = 0; column < grid.columns; column++) {
                const startX = Math.floor(column * analysis.width / grid.columns);
                const endX = Math.floor((column + 1) * analysis.width / grid.columns);
                const measurement = this.#measureRegion(
                    analysis.luminance,
                    analysis.width,
                    analysis.height,
                    startX,
                    endX,
                    startY,
                    endY
                );

                tiles.push({
                    row: row + 1,
                    column: column + 1,
                    ...measurement
                });
            }
        }

        const globalMeasurement = this.#measureRegion(
            analysis.luminance,
            analysis.width,
            analysis.height,
            0,
            analysis.width,
            0,
            analysis.height
        );
        const tenengradValues = tiles.map(tile => tile.tenengrad);
        const laplacianValues = tiles.map(tile => tile.laplacian);

        return {
            sourceWidth: analysis.sourceWidth,
            sourceHeight: analysis.sourceHeight,
            analysisWidth: analysis.width,
            analysisHeight: analysis.height,
            grid,
            globalTenengrad: globalMeasurement.tenengrad,
            globalLaplacian: globalMeasurement.laplacian,
            medianTenengrad: this.#median(tenengradValues),
            maxTenengrad: Math.max(...tenengradValues),
            medianLaplacian: this.#median(laplacianValues),
            maxLaplacian: Math.max(...laplacianValues),
            tiles
        };
    }

    classify(measurement) {
        return Number.isFinite(measurement?.globalLaplacian) &&
            measurement.globalLaplacian < GLOBAL_LAPLACIAN_BLUR_THRESHOLD
            ? BLUR_CLASSIFICATIONS.blurred
            : BLUR_CLASSIFICATIONS.uncertain;
    }

    #selectGrid(width, height) {
        const aspectRatio = width / height;

        if (Math.abs(aspectRatio - 1) <= SQUARE_ASPECT_RATIO_TOLERANCE) {
            return {columns: 4, rows: 4};
        }

        return aspectRatio > 1
            ? {columns: 5, rows: 3}
            : {columns: 3, rows: 5};
    }

    #measureRegion(luminance, width, height, startX, endX, startY, endY) {
        const minimumX = Math.max(startX + 1, 1);
        const maximumX = Math.min(endX - 1, width - 1);
        const minimumY = Math.max(startY + 1, 1);
        const maximumY = Math.min(endY - 1, height - 1);
        let tenengradSum = 0;
        let laplacianMean = 0;
        let laplacianSumOfSquares = 0;
        let count = 0;

        for (let y = minimumY; y < maximumY; y++) {
            for (let x = minimumX; x < maximumX; x++) {
                const topLeft = luminance[(y - 1) * width + x - 1];
                const top = luminance[(y - 1) * width + x];
                const topRight = luminance[(y - 1) * width + x + 1];
                const left = luminance[y * width + x - 1];
                const center = luminance[y * width + x];
                const right = luminance[y * width + x + 1];
                const bottomLeft = luminance[(y + 1) * width + x - 1];
                const bottom = luminance[(y + 1) * width + x];
                const bottomRight = luminance[(y + 1) * width + x + 1];
                const gradientX = -topLeft + topRight - (2 * left) + (2 * right) - bottomLeft + bottomRight;
                const gradientY = -topLeft - (2 * top) - topRight + bottomLeft + (2 * bottom) + bottomRight;
                const laplacian = top + left - (4 * center) + right + bottom;

                tenengradSum += gradientX ** 2 + gradientY ** 2;
                count += 1;

                const delta = laplacian - laplacianMean;
                laplacianMean += delta / count;
                laplacianSumOfSquares += delta * (laplacian - laplacianMean);
            }
        }

        return {
            tenengrad: count > 0 ? tenengradSum / count : 0,
            laplacian: count > 0 ? laplacianSumOfSquares / count : 0
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