const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_TARGET = 'image-finder-offscreen';
const TERMINAL_DOWNLOAD_STATES = new Set(['complete', 'interrupted']);

const backgroundObjectUrlsByDownloadId = new Map();
const offscreenTokensByDownloadId = new Map();
let creatingOffscreenDocument = null;

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function isTerminalDownloadState(state) {
    return TERMINAL_DOWNLOAD_STATES.has(state);
}

function canCreateObjectUrlHere() {
    return typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

function canUseOffscreenDocument() {
    return typeof chrome.offscreen?.createDocument === 'function';
}

async function dataUrlToBlob(dataUrl) {
    if (!/^data:image\//i.test(dataUrl)) {
        throw new Error('The data-image download URL is invalid');
    }

    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error('Cannot convert data image to Blob');

    return response.blob();
}

function releaseBackgroundObjectUrl(downloadId) {
    const objectUrl = backgroundObjectUrlsByDownloadId.get(downloadId);
    if (!objectUrl) return;

    backgroundObjectUrlsByDownloadId.delete(downloadId);
    URL.revokeObjectURL(objectUrl);
}

async function isOffscreenDocumentOpen() {
    const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_DOCUMENT_PATH);

    if (typeof chrome.runtime?.getContexts === 'function') {
        const contexts = await chrome.runtime.getContexts({
            contextTypes: ['OFFSCREEN_DOCUMENT'],
            documentUrls: [offscreenUrl]
        });

        return contexts.length > 0;
    }

    if (typeof clients !== 'undefined' && typeof clients.matchAll === 'function') {
        const matchedClients = await clients.matchAll();
        return matchedClients.some(client => client.url === offscreenUrl);
    }

    throw new Error('Cannot determine whether the offscreen document already exists');
}

async function ensureOffscreenDocument() {
    if (!canUseOffscreenDocument()) {
        throw new Error('This background context cannot create Blob URLs or an offscreen document');
    }

    if (await isOffscreenDocumentOpen()) return;
    if (creatingOffscreenDocument) return creatingOffscreenDocument;

    creatingOffscreenDocument = chrome.offscreen.createDocument({
        url: OFFSCREEN_DOCUMENT_PATH,
        reasons: ['BLOBS'],
        justification: 'Create durable Blob URLs for data-image downloads while the extension popup may close.'
    });

    try {
        await creatingOffscreenDocument;
    } finally {
        creatingOffscreenDocument = null;
    }
}

async function sendOffscreenMessage(action, payload = {}) {
    const response = await chrome.runtime.sendMessage({
        target: OFFSCREEN_TARGET,
        action,
        ...payload
    });

    if (response?.success !== true) {
        throw new Error(response?.error || `Offscreen request "${action}" failed`);
    }

    return response;
}

async function releaseOffscreenObjectUrlForDownload(downloadId) {
    const token = offscreenTokensByDownloadId.get(downloadId);
    offscreenTokensByDownloadId.delete(downloadId);

    if (!canUseOffscreenDocument()) return;

    try {
        if (token) {
            await sendOffscreenMessage('releaseObjectUrl', {token});
            return;
        }

        if (await isOffscreenDocumentOpen()) {
            await sendOffscreenMessage('releaseObjectUrlForDownload', {downloadId});
        }
    } catch (error) {
        console.warn('Cannot release offscreen Object URL:', downloadId, error);
    }
}

async function releaseFinishedDownloadUrl(downloadId) {
    try {
        const [download] = await chrome.downloads.search({id: downloadId});
        if (!isTerminalDownloadState(download?.state)) return false;

        releaseBackgroundObjectUrl(downloadId);
        await releaseOffscreenObjectUrlForDownload(downloadId);
        return true;
    } catch (error) {
        console.warn('Cannot read download status:', downloadId, error);
        return false;
    }
}

async function downloadDataImageWithBackgroundObjectUrl(dataUrl, options) {
    const blob = await dataUrlToBlob(dataUrl);
    const objectUrl = URL.createObjectURL(blob);

    try {
        const downloadId = await chrome.downloads.download({
            url: objectUrl,
            ...options
        });

        backgroundObjectUrlsByDownloadId.set(downloadId, objectUrl);
        await releaseFinishedDownloadUrl(downloadId);
        return downloadId;
    } catch (error) {
        URL.revokeObjectURL(objectUrl);
        throw error;
    }
}

async function downloadDataImageWithOffscreenDocument(dataUrl, options) {
    await ensureOffscreenDocument();

    const {token, objectUrl} = await sendOffscreenMessage('createObjectUrl', {dataUrl});
    if (typeof token !== 'string' || typeof objectUrl !== 'string') {
        throw new Error('Offscreen document returned an invalid Blob URL');
    }

    let downloadId;
    try {
        downloadId = await chrome.downloads.download({
            url: objectUrl,
            ...options
        });
    } catch (error) {
        try {
            await sendOffscreenMessage('releaseObjectUrl', {token});
        } catch (releaseError) {
            console.warn('Cannot release failed offscreen download URL:', releaseError);
        }
        throw error;
    }

    offscreenTokensByDownloadId.set(downloadId, token);

    try {
        await sendOffscreenMessage('associateDownload', {downloadId, token});
    } catch (error) {
        if (await releaseFinishedDownloadUrl(downloadId)) return downloadId;
        throw error;
    }

    await releaseFinishedDownloadUrl(downloadId);
    return downloadId;
}

async function downloadDataImage(dataUrl, options) {
    if (canCreateObjectUrlHere()) {
        return downloadDataImageWithBackgroundObjectUrl(dataUrl, options);
    }

    return downloadDataImageWithOffscreenDocument(dataUrl, options);
}

function getDownloadRequest(image) {
    if (!image || typeof image.url !== 'string' || !image.url.trim()) {
        throw new Error('The image download URL is invalid');
    }

    return {
        url: image.url.trim(),
        source: image.source,
        options: image.options && typeof image.options === 'object'
            ? image.options
            : {}
    };
}

async function startImageDownload(image) {
    const {url, source, options} = getDownloadRequest(image);

    if (source === 'dataimages') {
        return downloadDataImage(url, options);
    }

    return chrome.downloads.download({url, ...options});
}

async function downloadImageList(images) {
    const results = [];

    for (const image of images) {
        try {
            const downloadId = await startImageDownload(image);
            results.push({
                imageId: image?.imageId,
                url: image?.url,
                success: true,
                downloadId
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.warn('Cannot download image from list:', image?.url, error);
            results.push({
                imageId: image?.imageId,
                url: image?.url,
                success: false,
                error: message
            });
        }
    }

    return results;
}

chrome.downloads.onChanged.addListener((delta) => {
    const state = delta.state?.current;
    if (!isTerminalDownloadState(state)) return;

    releaseBackgroundObjectUrl(delta.id);
    void releaseOffscreenObjectUrlForDownload(delta.id);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target === OFFSCREEN_TARGET) {
        return undefined;
    }

    if (message?.action === 'downloadImage') {
        Promise.resolve(startImageDownload(message)).then(
            (downloadId) => sendResponse({success: true, downloadId}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );

        return true;
    }

    if (message?.action !== 'downloadImageList' || !Array.isArray(message.images)) {
        return undefined;
    }

    downloadImageList(message.images).then(
        (results) => sendResponse({success: true, results}),
        (error) => sendResponse({success: false, error: getErrorMessage(error)})
    );

    return true;
});
