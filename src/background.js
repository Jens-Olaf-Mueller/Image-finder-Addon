const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_TARGET = 'image-finder-offscreen';
const TERMINAL_DOWNLOAD_STATES = new Set(['complete', 'interrupted']);

if (typeof importScripts === 'function' && typeof JSZip === 'undefined') {
    importScripts('../vendor/jszip.min.js');
}

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

function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    const chunkSize = 0x8000;
    let binary = '';

    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
    }

    return btoa(binary);
}

async function blobToDataUrl(blob) {
    const mimeType = blob.type || 'application/octet-stream';
    const base64 = arrayBufferToBase64(await blob.arrayBuffer());
    return `data:${mimeType};base64,${base64}`;
}

async function readPageBlobAsDataUrl(blobUrl) {
    if (typeof blobUrl !== 'string' || !/^blob:/i.test(blobUrl)) {
        throw new Error('The page Blob URL is invalid');
    }

    const response = await fetch(blobUrl);
    if (!response.ok) throw new Error('Cannot read the page Blob URL');

    const blob = await response.blob();

    return new Promise((resolve, reject) => {
        const reader = new FileReader();

        reader.onload = () => {
            if (typeof reader.result === 'string') {
                resolve(reader.result);
            } else {
                reject(new Error('Cannot convert the page Blob to a Data URL'));
            }
        };
        reader.onerror = () => reject(new Error('Cannot read the page Blob'));
        reader.readAsDataURL(blob);
    });
}

async function resolvePageBlob(tabId, blobUrl) {
    if (!Number.isInteger(tabId)) {
        throw new Error('The Blob image source tab is missing');
    }

    let results;
    try {
        results = await chrome.scripting.executeScript({
            target: {tabId},
            func: readPageBlobAsDataUrl,
            args: [blobUrl]
        });
    } catch (error) {
        throw new Error(`Cannot resolve Blob image in its source tab: ${getErrorMessage(error)}`);
    }

    const dataUrl = results[0]?.result;
    if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
        throw new Error('The source tab did not return a valid image Data URL');
    }

    return dataUrl;
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

async function downloadBlobWithBackgroundObjectUrl(blob, options) {
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

async function downloadBlobWithOffscreenDocument(blob, options) {
    await ensureOffscreenDocument();

    const dataUrl = await blobToDataUrl(blob);
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

async function downloadBlob(blob, options) {
    if (canCreateObjectUrlHere()) {
        return downloadBlobWithBackgroundObjectUrl(blob, options);
    }

    return downloadBlobWithOffscreenDocument(blob, options);
}

async function downloadDataImage(dataUrl, options) {
    return downloadBlob(await dataUrlToBlob(dataUrl), options);
}

function getDownloadRequest(image) {
    if (!image || typeof image.url !== 'string' || !image.url.trim()) {
        throw new Error('The image download URL is invalid');
    }

    return {
        url: image.url.trim(),
        source: image.source,
        tabId: image.tabId,
        options: image.options && typeof image.options === 'object'
            ? image.options
            : {}
    };
}

async function startImageDownload(image) {
    const {url, source, tabId, options} = getDownloadRequest(image);

    if (source === 'dataimages') {
        return downloadDataImage(url, options);
    }

    if (source === 'blobimages') {
        const dataUrl = await resolvePageBlob(tabId, url);
        return downloadDataImage(dataUrl, options);
    }

    return chrome.downloads.download({url, ...options});
}

async function resolveImageBytes(image) {
    const {url, source, tabId} = getDownloadRequest(image);
    const dataUrl = source === 'blobimages'
        ? await resolvePageBlob(tabId, url)
        : source === 'dataimages'
            ? url
            : null;

    if (dataUrl) {
        return (await dataUrlToBlob(dataUrl)).arrayBuffer();
    }

    const response = await fetch(url);
    if (!response.ok) {
        throw new Error(`Cannot fetch image for ZIP: ${response.status}`);
    }

    return response.arrayBuffer();
}

function getUniqueZipFileName(fileName, usedNames) {
    const baseName = String(fileName ?? '')
        .trim()
        .split(/[\\/]/)
        .pop();
    if (!baseName) throw new Error('The ZIP image file name is invalid');

    const extensionIndex = baseName.lastIndexOf('.');
    const stem = extensionIndex > 0 ? baseName.slice(0, extensionIndex) : baseName;
    const extension = extensionIndex > 0 ? baseName.slice(extensionIndex) : '';

    let number = 1;
    let candidate = baseName;
    while (usedNames.has(candidate)) {
        number += 1;
        candidate = `${stem} (${number})${extension}`;
    }

    usedNames.add(candidate);
    return candidate;
}

async function downloadImageZip(images, options) {
    if (typeof JSZip !== 'function') {
        throw new Error('JSZip is not available in the background context');
    }

    const zip = new JSZip();
    const results = [];
    const usedNames = new Set();

    for (const image of images) {
        try {
            const data = await resolveImageBytes(image);
            const fileName = getUniqueZipFileName(image?.fileName, usedNames);
            zip.file(fileName, data);
            results.push({
                imageId: image?.imageId,
                url: image?.url,
                success: true
            });
        } catch (error) {
            const message = getErrorMessage(error);
            console.warn('Cannot add image to ZIP:', image?.url, error);
            results.push({
                imageId: image?.imageId,
                url: image?.url,
                success: false,
                error: message
            });
        }
    }

    const successfulResults = results.filter((result) => result.success);
    if (successfulResults.length === 0) {
        throw new Error('Cannot create ZIP: no images could be resolved');
    }

    const zipBlob = await zip.generateAsync({
        type: 'blob',
        mimeType: 'application/zip'
    });
    const downloadId = await downloadBlob(zipBlob, options);

    successfulResults.forEach((result) => {
        result.downloadId = downloadId;
    });

    return results;
}

async function downloadImageList(images, zipOptions = null) {
    if (zipOptions) return downloadImageZip(images, zipOptions);

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

    if (message?.action === 'resolveBlobImage') {
        Promise.resolve(resolvePageBlob(message.tabId, message.blobUrl)).then(
            (dataUrl) => sendResponse({success: true, dataUrl}),
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );

        return true;
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

    const zipRequested = message?.zip?.enabled === true;
    if (zipRequested && (!message.zip.options || typeof message.zip.options !== 'object')) {
        sendResponse({success: false, error: 'ZIP download options are invalid'});
        return undefined;
    }

    const zipOptions = zipRequested ? message.zip.options : null;

    downloadImageList(message.images, zipOptions).then(
        (results) => sendResponse({success: true, results}),
        (error) => sendResponse({success: false, error: getErrorMessage(error)})
    );

    return true;
});