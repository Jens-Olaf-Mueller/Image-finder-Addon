import BlurScanner from '../src/classes/BlurScanner.js';

const IMAGE_IDS = [
    'imgTest1Sharp',
    'imgTest1Blurred',
    'imgTest2Sharp',
    'imgTest2Blurred',
    'imgTest3Sharp',
    'imgTest3Blurred'
];
const analysisStore = new Map();
const blurScanner = new BlurScanner(analysisStore);

async function waitForImage(image) {
    if (!image.complete) {
        await new Promise((resolve, reject) => {
            image.addEventListener('load', resolve, {once: true});
            image.addEventListener('error', () => {
                reject(new Error('Image failed to load'));
            }, {once: true});
        });
    }

    if (image.naturalWidth <= 0 || image.naturalHeight <= 0) {
        throw new Error('Image has no analyzable dimensions');
    }
    if (typeof image.decode === 'function') await image.decode();
}

function addMeasurement(definitions, label, value) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');

    term.textContent = label;
    description.textContent = value;
    definitions.append(term, description);
}

function formatNumber(value) {
    return value.toFixed(2);
}

function getDecision(classification) {
    return classification === 'blurred' ? 'FILTER' : 'KEEP';
}

function getExpectedDecision(image) {
    return image.closest('.image-card')?.querySelector('h3')?.textContent === 'Blurred'
        ? 'FILTER'
        : 'KEEP';
}

function addClassificationMeasurements(definitions, classification, expectedDecision) {
    const decision = getDecision(classification);

    addMeasurement(definitions, 'Classification', classification.toUpperCase());
    addMeasurement(definitions, 'Decision', decision);
    addMeasurement(definitions, 'Expected decision', expectedDecision);
    addMeasurement(definitions, 'Result', decision === expectedDecision ? 'PASS' : 'FAIL');
}

function renderResult(container, result, classification, expectedDecision) {
    const definitions = document.createElement('dl');
    const details = document.createElement('details');
    const summary = document.createElement('summary');
    const table = document.createElement('table');
    const header = document.createElement('thead');
    const headerRow = document.createElement('tr');
    const body = document.createElement('tbody');

    definitions.className = 'analysis-summary';
    addMeasurement(definitions, 'Original', `${result.sourceWidth} × ${result.sourceHeight}`);
    addMeasurement(definitions, 'Analysis', `${result.analysisWidth} × ${result.analysisHeight}`);
    addMeasurement(definitions, 'Grid', `${result.grid.columns} × ${result.grid.rows}`);
    addMeasurement(definitions, 'Tenengrad', [
        `Global ${formatNumber(result.globalTenengrad)}`,
        `Median tile ${formatNumber(result.medianTenengrad)}`,
        `Max tile ${formatNumber(result.maxTenengrad)}`
    ].join(' · '));
    addMeasurement(definitions, 'Laplacian', [
        `Global ${formatNumber(result.globalLaplacian)}`,
        `Median tile ${formatNumber(result.medianLaplacian)}`,
        `Max tile ${formatNumber(result.maxLaplacian)}`
    ].join(' · '));
    addClassificationMeasurements(definitions, classification, expectedDecision);

    ['Row', 'Column', 'Tenengrad', 'Laplacian'].forEach(label => {
        const cell = document.createElement('th');
        cell.scope = 'col';
        cell.textContent = label;
        headerRow.appendChild(cell);
    });
    header.appendChild(headerRow);

    result.tiles.forEach(tile => {
        const row = document.createElement('tr');
        [
            tile.row,
            tile.column,
            formatNumber(tile.tenengrad),
            formatNumber(tile.laplacian)
        ].forEach(value => {
            const cell = document.createElement('td');
            cell.textContent = value;
            row.appendChild(cell);
        });
        body.appendChild(row);
    });

    summary.textContent = 'Tile values';
    table.append(header, body);
    details.append(summary, table);
    container.classList.remove('analysis-failed');
    container.replaceChildren(definitions, details);
}

function renderFailure(container, classification, expectedDecision) {
    const message = document.createElement('p');
    const definitions = document.createElement('dl');

    message.textContent = 'Analysis failed';
    definitions.className = 'analysis-summary';
    addClassificationMeasurements(definitions, classification, expectedDecision);
    container.classList.add('analysis-failed');
    container.replaceChildren(message, definitions);
}

async function measureImage(imageId) {
    const image = document.getElementById(imageId);
    const container = image?.closest('.image-card')?.querySelector('[data-analysis-result]');

    if (!image || !container) {
        console.error(`Cannot find BlurScanner test elements for ${imageId}`);
        return;
    }

    try {
        await waitForImage(image);
        const result = await blurScanner.measure(image, imageId);
        const classification = blurScanner.classify(result);

        renderResult(container, result, classification, getExpectedDecision(image));
    } catch (error) {
        console.error(`BlurScanner analysis failed for ${imageId}`, error);
        renderFailure(container, 'uncertain', getExpectedDecision(image));
    }
}

async function runMeasurements(button) {
    button.disabled = true;
    button.textContent = 'Analyzing…';
    document.querySelectorAll('[data-analysis-result]').forEach(container => {
        container.textContent = 'Analyzing…';
        container.classList.remove('analysis-failed');
    });

    try {
        await Promise.all(IMAGE_IDS.map(measureImage));
    } finally {
        button.disabled = false;
        button.textContent = 'Run BlurScanner analysis';
    }
}

const runButton = document.getElementById('btnRunBlurScan');

if (!runButton) {
    console.error('Cannot find BlurScanner analysis button');
} else {
    runButton.addEventListener('click', () => runMeasurements(runButton));
}
