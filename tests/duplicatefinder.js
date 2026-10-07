import DuplicateFinder, {STRICT_MATCH_THRESHOLD} from '../src/classes/DuplicateFinder.js';

const DUPLICATE_TEST_PAIRS = [
    {referenceId: 'imgTest1Reference', candidateId: 'imgTest1Candidate'},
    {referenceId: 'imgTest2Reference', candidateId: 'imgTest2Candidate'},
    {referenceId: 'imgTest3Reference', candidateId: 'imgTest3Candidate'}
];
const analysisStore = new Map();
const duplicateFinder = new DuplicateFinder(analysisStore);

duplicateFinder.mode = 'strict';

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

function getAnalysisKey(image) {
    return image.currentSrc || image.src;
}

function addMeasurement(definitions, label, value) {
    const term = document.createElement('dt');
    const description = document.createElement('dd');

    term.textContent = label;
    description.textContent = value;
    definitions.append(term, description);
}

function formatDimensions(imageInfo) {
    return `${imageInfo.sourceWidth} × ${imageInfo.sourceHeight}`;
}

function formatDifference(value) {
    return value.toFixed(6);
}

function renderResult(container, result) {
    const definitions = document.createElement('dl');
    const classification = duplicateFinder.isStrictMatch(result) ? 'SAME' : 'DIFFERENT';

    definitions.className = 'analysis-summary';
    addMeasurement(definitions, 'Reference dimensions', formatDimensions(result.reference));
    addMeasurement(definitions, 'Reference hash', result.hashA);
    addMeasurement(definitions, 'Candidate dimensions', formatDimensions(result.candidate));
    addMeasurement(definitions, 'Candidate hash', result.hashB);
    addMeasurement(definitions, 'Hamming Distance', String(result.hammingDistance));
    addMeasurement(definitions, 'Normalized Difference', formatDifference(result.normalizedDifference));
    addMeasurement(definitions, 'Threshold', String(STRICT_MATCH_THRESHOLD));
    addMeasurement(definitions, 'Classification', classification);
    container.classList.remove('analysis-failed');
    container.replaceChildren(definitions);
}

function renderFailure(container) {
    const message = document.createElement('p');

    message.textContent = 'Comparison failed';
    container.classList.add('analysis-failed');
    container.replaceChildren(message);
}

async function comparePair(pair) {
    const reference = document.getElementById(pair.referenceId);
    const candidate = document.getElementById(pair.candidateId);
    const container = reference?.closest('.test-group')?.querySelector('[data-analysis-result]');

    if (!reference || !candidate || !container) {
        console.error(`Cannot find DuplicateFinder test elements for ${pair.referenceId}`);
        return;
    }

    try {
        await Promise.all([waitForImage(reference), waitForImage(candidate)]);
        const result = await duplicateFinder.compare(
            reference,
            getAnalysisKey(reference),
            candidate,
            getAnalysisKey(candidate)
        );

        renderResult(container, result);
    } catch (error) {
        console.error(`DuplicateFinder comparison failed for ${pair.referenceId}`, error);
        renderFailure(container);
    }
}

async function runDuplicateFinderTests(button) {
    button.disabled = true;
    button.textContent = 'Comparing…';
    document.querySelectorAll('[data-analysis-result]').forEach(container => {
        container.textContent = 'Comparing…';
        container.classList.remove('analysis-failed');
    });

    try {
        for (const pair of DUPLICATE_TEST_PAIRS) {
            await comparePair(pair);
        }
    } finally {
        button.disabled = false;
        button.textContent = 'Run duplicate finder tests';
    }
}

const runButton = document.getElementById('btnRunDuplicateFinderTests');

if (!runButton) {
    console.error('Cannot find DuplicateFinder test button');
} else {
    runButton.addEventListener('click', () => runDuplicateFinderTests(runButton));
}
