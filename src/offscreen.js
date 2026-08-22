const OFFSCREEN_TARGET = 'image-finder-offscreen';

const objectUrlsByToken = new Map();
const tokensByDownloadId = new Map();

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

async function dataUrlToBlob(dataUrl) {
    if (typeof dataUrl !== 'string' || !/^data:image\//i.test(dataUrl)) {
        throw new Error('The data-image download URL is invalid');
    }

    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error('Cannot convert data image to Blob');

    return response.blob();
}

function releaseObjectUrl(token) {
    const objectUrl = objectUrlsByToken.get(token);
    if (!objectUrl) return false;

    objectUrlsByToken.delete(token);
    for (const [downloadId, downloadToken] of tokensByDownloadId) {
        if (downloadToken === token) tokensByDownloadId.delete(downloadId);
    }

    URL.revokeObjectURL(objectUrl);
    return true;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== OFFSCREEN_TARGET) return undefined;

    if (message.action === 'createObjectUrl') {
        dataUrlToBlob(message.dataUrl).then(
            (blob) => {
                const token = crypto.randomUUID();
                const objectUrl = URL.createObjectURL(blob);
                objectUrlsByToken.set(token, objectUrl);
                sendResponse({success: true, token, objectUrl});
            },
            (error) => sendResponse({success: false, error: getErrorMessage(error)})
        );
        return true;
    }

    if (message.action === 'associateDownload') {
        const {downloadId, token} = message;
        if (!Number.isInteger(downloadId) || !objectUrlsByToken.has(token)) {
            sendResponse({success: false, error: 'Cannot associate the download with its Blob URL'});
            return undefined;
        }

        tokensByDownloadId.set(downloadId, token);
        sendResponse({success: true});
        return undefined;
    }

    if (message.action === 'releaseObjectUrl') {
        sendResponse({success: true, released: releaseObjectUrl(message.token)});
        return undefined;
    }

    if (message.action === 'releaseObjectUrlForDownload') {
        const token = tokensByDownloadId.get(message.downloadId);
        sendResponse({success: true, released: token ? releaseObjectUrl(token) : false});
        return undefined;
    }

    sendResponse({success: false, error: `Unknown offscreen action "${message.action}"`});
    return undefined;
});
