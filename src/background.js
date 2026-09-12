const OFFSCREEN_DOCUMENT_PATH = 'offscreen.html';
const OFFSCREEN_TARGET = 'image-finder-offscreen';
const ISOLATED_DEEP_SCAN_TARGET = 'image-finder-isolated-deepscan';
const HIDDEN_DEEP_SCAN_TARGET = 'image-finder-hidden-deepscan';
const TERMINAL_DOWNLOAD_STATES = new Set(['complete', 'interrupted']);
const PROTECTED_DEEP_SCAN_FRAME_RULE_ID = 10001;
const HIDDEN_DEEP_SCAN_FRAME_RULE_ID = 10002;
const HIDDEN_DEEP_SCAN_HOST_FRAME_ID = 0;
const EMBED_BLOCKED_OR_LOAD_FAILED = 'EMBED_BLOCKED_OR_LOAD_FAILED';
const POPUP_DEEP_SCAN_PORT_NAME = 'image-finder-popup-deepscan';

if (typeof importScripts === 'function') {
    importScripts('isolated-deepscan-host.js');
    if (typeof JSZip === 'undefined') importScripts('../vendor/jszip.min.js');
}

const backgroundObjectUrlsByDownloadId = new Map();
const offscreenTokensByDownloadId = new Map();
let creatingOffscreenDocument = null;
let activeIsolatedDeepScan = null;
let activeHiddenDeepScan = null;
let backgroundDeepScanHost = null;
let protectedDeepScanFrameRuleOwner = null;
let hiddenDeepScanFrameRuleOwner = null;
let protectedDeepScanFrameRuleUpdate = Promise.resolve();
const popupDeepScanPorts = new Map();

function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function getPopupDeepScanClientId(port) {
    const prefix = `${POPUP_DEEP_SCAN_PORT_NAME}:`;
    if (typeof port?.name !== 'string' || !port.name.startsWith(prefix)) return null;

    const clientId = port.name.slice(prefix.length);
    return clientId || null;
}

function getDeepScanCancelSource(endReason) {
    if (endReason === 'user-abort') return 'user';
    if (endReason === 'popup-closed') return 'popup-closed';
    return null;
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

function canUseProtectedDeepScanFrameRule() {
    return typeof chrome.declarativeNetRequest?.updateSessionRules === 'function';
}

function isHiddenDeepScanFrameUnavailableReason(reason) {
    return reason === EMBED_BLOCKED_OR_LOAD_FAILED ||
        (typeof reason === 'string' && /^HIDDEN_FRAME_(?:LOAD|READY)_TIMEOUT:/.test(reason));
}

function isMissingMessageReceiverError(error) {
    return /Receiving end does not exist/i.test(getErrorMessage(error));
}

function queueProtectedDeepScanFrameRuleUpdate(update) {
    const queuedUpdate = protectedDeepScanFrameRuleUpdate
        .catch(() => undefined)
        .then(update);

    protectedDeepScanFrameRuleUpdate = queuedUpdate.catch(() => undefined);
    return queuedUpdate;
}

function createProtectedDeepScanFrameRule(url) {
    const targetURL = new URL(url);
    targetURL.hash = '';

    return {
        id: PROTECTED_DEEP_SCAN_FRAME_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                {header: 'X-Frame-Options', operation: 'remove'},
                {header: 'Content-Security-Policy', operation: 'remove'}
            ]
        },
        condition: {
            urlFilter: `|${targetURL.href}|`,
            isUrlFilterCaseSensitive: true,
            requestMethods: ['get'],
            resourceTypes: ['sub_frame'],
            tabIds: [Number.isInteger(chrome.tabs?.TAB_ID_NONE) ? chrome.tabs.TAB_ID_NONE : -1]
        }
    };
}

async function installProtectedDeepScanFrameRule(job) {
    if (!canUseProtectedDeepScanFrameRule()) {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        throw new Error('Temporary frame rules are unavailable');
    }

    const rule = createProtectedDeepScanFrameRule(job.url);
    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [PROTECTED_DEEP_SCAN_FRAME_RULE_ID],
                addRules: [rule]
            })
        );
        protectedDeepScanFrameRuleOwner = {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        };
    } catch (error) {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: job.scanId,
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        throw error;
    }
}

async function removeProtectedDeepScanFrameRule(scanId = null) {
    const owner = protectedDeepScanFrameRuleOwner;
    if (scanId && owner && owner.scanId !== scanId) return false;
    if (!canUseProtectedDeepScanFrameRule()) return false;

    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [PROTECTED_DEEP_SCAN_FRAME_RULE_ID]
            })
        );
        if (!scanId || protectedDeepScanFrameRuleOwner?.scanId === scanId) {
            protectedDeepScanFrameRuleOwner = null;
        }
        return true;
    } catch {
        console.warn('[DeepScan] temporary frame rule failed', {
            scanId: scanId ?? owner?.scanId ?? '',
            ruleId: PROTECTED_DEEP_SCAN_FRAME_RULE_ID
        });
        return false;
    }
}

function createHiddenDeepScanFrameRule(url, tabId) {
    const targetURL = new URL(url);
    targetURL.hash = '';

    return {
        id: HIDDEN_DEEP_SCAN_FRAME_RULE_ID,
        priority: 1,
        action: {
            type: 'modifyHeaders',
            responseHeaders: [
                {header: 'X-Frame-Options', operation: 'remove'},
                {header: 'Content-Security-Policy', operation: 'remove'}
            ]
        },
        condition: {
            urlFilter: `|${targetURL.href}|`,
            isUrlFilterCaseSensitive: true,
            requestMethods: ['get'],
            resourceTypes: ['sub_frame'],
            tabIds: [tabId]
        }
    };
}

async function installHiddenDeepScanFrameRule(job) {
    if (!canUseProtectedDeepScanFrameRule()) {
        throw new Error('Temporary frame rules are unavailable');
    }

    const rule = createHiddenDeepScanFrameRule(job.url, job.tabId);
    await queueProtectedDeepScanFrameRuleUpdate(() =>
        chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [HIDDEN_DEEP_SCAN_FRAME_RULE_ID],
            addRules: [rule]
        })
    );
    hiddenDeepScanFrameRuleOwner = {
        scanId: job.scanId,
        ruleId: HIDDEN_DEEP_SCAN_FRAME_RULE_ID
    };
}

async function removeHiddenDeepScanFrameRule(scanId = null) {
    const owner = hiddenDeepScanFrameRuleOwner;
    if (scanId && owner && owner.scanId !== scanId) return false;
    if (!canUseProtectedDeepScanFrameRule()) return false;

    try {
        await queueProtectedDeepScanFrameRuleUpdate(() =>
            chrome.declarativeNetRequest.updateSessionRules({
                removeRuleIds: [HIDDEN_DEEP_SCAN_FRAME_RULE_ID]
            })
        );
        if (!scanId || hiddenDeepScanFrameRuleOwner?.scanId === scanId) {
            hiddenDeepScanFrameRuleOwner = null;
        }
        return true;
    } catch {
        return false;
    }
}

// Session rules outlive a suspended service worker, so discard an unowned stale rule on startup.
void removeProtectedDeepScanFrameRule();
void removeHiddenDeepScanFrameRule();

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
        reasons: ['BLOBS', 'IFRAME_SCRIPTING', 'DOM_SCRAPING'],
        justification: 'Create durable Blob URLs and host an isolated iframe for background image discovery.'
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

async function sendDeepScanClientMessage(message) {
    try {
        await chrome.runtime.sendMessage({
            target: ISOLATED_DEEP_SCAN_TARGET,
            source: 'background',
            ...message
        });
    } catch {
        // The popup may already be closed; the isolated job is intentionally not persistent.
    }
}

function queueDeepScanClientMessage(job, message) {
    if (!job || job.cancelled) return Promise.resolve();

    job.clientEventQueue = (job.clientEventQueue ?? Promise.resolve())
        .then(() => job.cancelled ? undefined : sendDeepScanClientMessage(message))
        .catch(() => undefined);
    return job.clientEventQueue;
}

function createHiddenDeepScanHostMessage(job, action) {
    return {
        target: HIDDEN_DEEP_SCAN_TARGET,
        source: 'background',
        action,
        scanId: job.scanId,
        token: job.token,
        ...(action === 'start' ? {
            url: job.url,
            ignoreHiddenImages: job.ignoreHiddenImages === true
        } : {})
    };
}

async function probeHiddenDeepScanHost(job) {
    const response = await chrome.tabs.sendMessage(
        job.tabId,
        createHiddenDeepScanHostMessage(job, 'probe'),
        {frameId: job.hostFrameId}
    );
    if (response?.success !== true) {
        throw new Error('HIDDEN_HOST_LISTENER_NOT_READY');
    }
}

async function injectHiddenDeepScanHost(job) {
    await chrome.scripting.executeScript({
        target: {tabId: job.tabId, frameIds: [job.hostFrameId]},
        files: ['src/deepscan-frame.js'],
        injectImmediately: true
    });
}

async function ensureHiddenDeepScanHost(job) {
    try {
        await probeHiddenDeepScanHost(job);
        return;
    } catch (error) {
        if (!isMissingMessageReceiverError(error)) throw error;
    }

    try {
        await injectHiddenDeepScanHost(job);
        await probeHiddenDeepScanHost(job);
    } catch (error) {
        throw error;
    }
}

async function sendHiddenDeepScanHostMessage(job, action) {
    if (action === 'start') {
        await ensureHiddenDeepScanHost(job);
    }

    const response = await chrome.tabs.sendMessage(
        job.tabId,
        createHiddenDeepScanHostMessage(job, action),
        {frameId: job.hostFrameId}
    );
    if (response?.success !== true) {
        throw new Error('The hidden DeepScan host is unavailable');
    }
}

async function finishHiddenDeepScan(job) {
    if (!job || activeHiddenDeepScan !== job) return;

    activeHiddenDeepScan = null;
    try {
        await sendHiddenDeepScanHostMessage(job, 'cancel');
    } catch {
        // The content-script host may have already removed the hidden iframe.
    } finally {
        await removeHiddenDeepScanFrameRule(job.scanId);
    }
}

async function completeHiddenDeepScanJob(job, status, reason = null) {
    await finishHiddenDeepScan(job);

    const isolatedJob = activeIsolatedDeepScan;
    if (isolatedJob?.scanId === job.scanId) {
        await finishIsolatedDeepScan(isolatedJob, status, reason);
    }
}

async function startHiddenDeepScanHost(job) {
    await sendHiddenDeepScanHostMessage(job, 'start');
}

async function retryHiddenDeepScanWithProtectedFrameRule(job) {
    try {
        await installHiddenDeepScanFrameRule(job);
        if (job.cancelled || activeHiddenDeepScan !== job) {
            await removeHiddenDeepScanFrameRule(job.scanId);
            return;
        }
        await startHiddenDeepScanHost(job);
    } catch (error) {
        if (job.cancelled || activeHiddenDeepScan !== job) return;
        await completeHiddenDeepScanJob(job, 'unavailable', getErrorMessage(error));
    }
}

async function startHiddenDeepScan(request) {
    await finishHiddenDeepScan(activeHiddenDeepScan);
    await removeHiddenDeepScanFrameRule();

    const job = {
        scanId: request.scanId,
        token: crypto.randomUUID(),
        tabId: request.tabId,
        hostFrameId: HIDDEN_DEEP_SCAN_HOST_FRAME_ID,
        url: request.url,
        ignoreHiddenImages: request.ignoreHiddenImages === true,
        allowProtectedDeepScan: request.allowProtectedDeepScan === true,
        protectedFrameRuleAttempted: false,
        cancelled: false
    };
    activeHiddenDeepScan = job;

    try {
        await startHiddenDeepScanHost(job);
    } catch (error) {
        await finishHiddenDeepScan(job);
        throw error;
    }
}

function handleHiddenDeepScanEvent(event) {
    const job = activeHiddenDeepScan;
    if (!job || job.cancelled || event?.scanId !== job.scanId) return;

    const isolatedJob = activeIsolatedDeepScan;
    if (!isolatedJob || isolatedJob.scanId !== job.scanId) return;
    if (event.action === 'hidden-state' && typeof event.phase === 'string' && event.state) {
        console.info('[DeepScan HIDDEN STATE]', {phase: event.phase, ...event.state});
        return;
    }
    if (event.action === 'hidden-error' && typeof event.kind === 'string') {
        console.error('[DeepScan HIDDEN ERROR]', {
            kind: event.kind,
            message: typeof event.message === 'string' ? event.message : 'UNKNOWN_ERROR'
        });
        return;
    }
    if (event.action === 'batch' && Array.isArray(event.candidates)) {
        if (isolatedJob.cancelled) return;
        void queueDeepScanClientMessage(isolatedJob, {
            action: 'batch',
            scanId: isolatedJob.scanId,
            url: isolatedJob.url,
            candidates: event.candidates,
            ...(event.diagnostic ? {diagnostic: event.diagnostic} : {})
        });
        return;
    }
    if (event.action !== 'complete') return;

    if (event.status === 'unavailable' && isHiddenDeepScanFrameUnavailableReason(event.reason) &&
        job.allowProtectedDeepScan && !job.protectedFrameRuleAttempted) {
        job.protectedFrameRuleAttempted = true;
        void retryHiddenDeepScanWithProtectedFrameRule(job);
        return;
    }
    const status = ['completed', 'cancelled', 'unavailable', 'failed'].includes(event.status)
        ? event.status
        : 'failed';
    void completeHiddenDeepScanJob(job, status, event.reason);
}

function logIsolatedDeepScanFailure(job, status, reason = null) {
    if (!job || job.errorLogged) return;
    job.errorLogged = true;

    if (status === 'unavailable') {
        console.error('[DeepScan] Isolated context unavailable:', {
            url: job.url,
            reason: reason || 'UNKNOWN'
        });
        return;
    }
    console.error('[DeepScan] Isolated scan failed:', job.url, reason || 'UNKNOWN_ERROR');
}

async function finishIsolatedDeepScan(job, status, reason = null) {
    if (!job || activeIsolatedDeepScan !== job) return;

    if (activeHiddenDeepScan?.scanId === job.scanId) {
        await finishHiddenDeepScan(activeHiddenDeepScan);
    }
    activeIsolatedDeepScan = null;
    await removeProtectedDeepScanFrameRule(job.scanId);
    if (!['completed', 'cancelled'].includes(status)) {
        logIsolatedDeepScanFailure(job, status, reason);
    }
    await job.clientEventQueue?.catch(() => undefined);
    await sendDeepScanClientMessage({
        action: 'complete',
        scanId: job.scanId,
        url: job.url,
        status,
        ...(typeof reason === 'string' ? {reason} : {})
    });
}

async function startIsolatedDeepScanHost(job) {
    if (canUseOffscreenDocument()) {
        await ensureOffscreenDocument();
        await sendOffscreenMessage('startDeepScan', {job});
        return;
    }

    await getBackgroundDeepScanHost().start(job);
}

async function retryProtectedDeepScan(job) {
    try {
        await installProtectedDeepScanFrameRule(job);
        if (job.cancelled || activeIsolatedDeepScan !== job) {
            await removeProtectedDeepScanFrameRule(job.scanId);
            return;
        }

        await startIsolatedDeepScanHost(job);
    } catch (error) {
        if (job.cancelled || activeIsolatedDeepScan !== job) return;
        await finishIsolatedDeepScan(job, 'unavailable', getErrorMessage(error));
    }
}

function handleIsolatedDeepScanHostEvent(event) {
    const job = activeIsolatedDeepScan;
    const isActiveJobEvent = Boolean(job && !job.cancelled && event?.scanId === job.scanId &&
        event.url === job.url);

    if (!isActiveJobEvent) return;
    if (event.action === 'batch' && Array.isArray(event.candidates)) {
        void sendDeepScanClientMessage({
            action: 'batch',
            scanId: job.scanId,
            url: job.url,
            candidates: event.candidates
        });
        return;
    }
    if (event.action !== 'complete') return;

    const status = ['completed', 'cancelled', 'unavailable', 'failed'].includes(event.status)
        ? event.status
        : 'failed';
    if (job.allowProtectedDeepScan && !job.protectedFrameRuleAttempted &&
        status === 'unavailable' && event.reason === EMBED_BLOCKED_OR_LOAD_FAILED) {
        job.protectedFrameRuleAttempted = true;
        void retryProtectedDeepScan(job);
        return;
    }

    void finishIsolatedDeepScan(job, status, event.reason);
}

function getBackgroundDeepScanHost() {
    if (backgroundDeepScanHost) return backgroundDeepScanHost;
    if (typeof document === 'undefined' || typeof globalThis.createIsolatedDeepScanHost !== 'function') {
        throw new Error('This browser has no isolated DeepScan document context');
    }

    backgroundDeepScanHost = globalThis.createIsolatedDeepScanHost({
        emit: handleIsolatedDeepScanHostEvent
    });
    return backgroundDeepScanHost;
}

async function cancelIsolatedDeepScan(scanId = null, endReason = 'cancelled') {
    const job = activeIsolatedDeepScan;
    const normalizedEndReason = ['user-abort', 'popup-closed'].includes(endReason)
        ? endReason
        : 'cancelled';
    const hiddenDeepScanJob = activeHiddenDeepScan;
    const hasMatchingHiddenJob = Boolean(hiddenDeepScanJob &&
        (!scanId || hiddenDeepScanJob.scanId === scanId));
    const hasMatchingJob = Boolean(job && (!scanId || job.scanId === scanId));
    const cancellationSource = getDeepScanCancelSource(normalizedEndReason);
    if (!hasMatchingHiddenJob && !hasMatchingJob) return false;
    if (cancellationSource) console.info(`[DeepScan CANCEL] source=${cancellationSource}`);

    if (hasMatchingHiddenJob) {
        hiddenDeepScanJob.cancelled = true;
        await finishHiddenDeepScan(hiddenDeepScanJob);
    }
    if (!hasMatchingJob) {
        if (cancellationSource) console.info('[DeepScan CANCEL COMPLETE]');
        return true;
    }

    job.cancelled = true;
    if (normalizedEndReason === 'user-abort') {
        console.info('[DeepScan] stopped by user', {scanId: job.scanId});
    }
    activeIsolatedDeepScan = null;
    try {
        if (canUseOffscreenDocument()) {
            if (await isOffscreenDocumentOpen()) {
                await sendOffscreenMessage('cancelDeepScan', {scanId: job.scanId});
            }
        } else if (backgroundDeepScanHost) {
            await backgroundDeepScanHost.cancel(job.scanId);
        }
    } catch {
        // Cancelling a discarded host must still finish the popup-side DeepScan cleanly.
    } finally {
        await removeProtectedDeepScanFrameRule(job.scanId);
    }

    await job.clientEventQueue?.catch(() => undefined);
    await sendDeepScanClientMessage({
        action: 'complete',
        scanId: job.scanId,
        url: job.url,
        status: 'cancelled',
        endReason: normalizedEndReason
    });
    if (cancellationSource) console.info('[DeepScan CANCEL COMPLETE]');
    return true;
}

async function startIsolatedDeepScan(request) {
    if (typeof request?.scanId !== 'string' || !request.scanId ||
        typeof request?.url !== 'string' || !request.url || !Number.isInteger(request.tabId)) {
        throw new Error('The isolated DeepScan request is invalid');
    }
    if (typeof request.popupClientId === 'string' && request.popupClientId &&
        !popupDeepScanPorts.has(request.popupClientId)) {
        return {scanId: request.scanId};
    }

    await cancelIsolatedDeepScan();
    await removeProtectedDeepScanFrameRule();
    const job = {
        scanId: request.scanId,
        token: crypto.randomUUID(),
        url: request.url,
        tabId: request.tabId,
        ignoreHiddenImages: request.ignoreHiddenImages === true,
        allowProtectedDeepScan: request.allowProtectedDeepScan === true,
        popupClientId: typeof request.popupClientId === 'string' && request.popupClientId
            ? request.popupClientId
            : null,
        protectedFrameRuleAttempted: false,
        cancelled: false,
        errorLogged: false,
        clientEventQueue: Promise.resolve()
    };
    activeIsolatedDeepScan = job;

    try {
        const tab = await chrome.tabs.get(job.tabId);
        if (tab?.url !== job.url) {
            await cancelIsolatedDeepScan(job.scanId);
            return {scanId: job.scanId};
        }

        await startHiddenDeepScan({
            scanId: job.scanId,
            tabId: job.tabId,
            url: job.url,
            ignoreHiddenImages: job.ignoreHiddenImages,
            allowProtectedDeepScan: job.allowProtectedDeepScan
        });
    } catch (error) {
        await finishIsolatedDeepScan(job, 'unavailable', getErrorMessage(error));
    }

    return {scanId: job.scanId};
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

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    const job = activeIsolatedDeepScan;
    const hiddenDeepScan = activeHiddenDeepScan;
    if (hiddenDeepScan && tabId === hiddenDeepScan.tabId && typeof changeInfo.url === 'string' &&
        changeInfo.url !== hiddenDeepScan.url) {
        void completeHiddenDeepScanJob(hiddenDeepScan, 'cancelled');
    }
    if (!job || tabId !== job.tabId || typeof changeInfo.url !== 'string' || changeInfo.url === job.url) {
        return;
    }

    void cancelIsolatedDeepScan(job.scanId);
});

chrome.tabs.onRemoved.addListener((tabId) => {
    if (activeHiddenDeepScan?.tabId === tabId) {
        void completeHiddenDeepScanJob(activeHiddenDeepScan, 'cancelled');
    }
    if (activeIsolatedDeepScan?.tabId === tabId) {
        void cancelIsolatedDeepScan(activeIsolatedDeepScan.scanId);
    }
});

chrome.runtime.onConnect.addListener((port) => {
    const clientId = getPopupDeepScanClientId(port);
    if (!clientId) return;

    popupDeepScanPorts.set(clientId, port);
    port.onDisconnect.addListener(() => {
        if (popupDeepScanPorts.get(clientId) !== port) return;

        popupDeepScanPorts.delete(clientId);
        const job = activeIsolatedDeepScan;
        if (job?.popupClientId !== clientId) return;

        void cancelIsolatedDeepScan(job.scanId, 'popup-closed');
    });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target === OFFSCREEN_TARGET) {
        return undefined;
    }

    if (message?.target === HIDDEN_DEEP_SCAN_TARGET) {
        if (message.source === 'hidden-deepscan-host') {
            handleHiddenDeepScanEvent(message);
        }
        return undefined;
    }

    if (message?.target === ISOLATED_DEEP_SCAN_TARGET) {
        if (message.source === 'isolated-host') {
            handleIsolatedDeepScanHostEvent(message);
            return undefined;
        }
        if (message.source === 'background') return undefined;

        if (message.action === 'diagnostic-result' && message.diagnostic && message.result) {
            const diagnostic = message.diagnostic;
            const result = message.result;
            console.info(
                '[DeepScan PIPELINE]',
                `phase=${diagnostic.phase}`,
                `batch=${diagnostic.id}`,
                `rawCandidates=${diagnostic.rawCandidates}`,
                `scannerNewURLs=${result.scannerNewURLs}`,
                `imageFinderNewURLs=${result.imageFinderNewURLs}`,
                `acceptedCandidates=${result.acceptedCandidates}`,
                `existingUpgrades=${result.existingUpgrades}`,
                `visibleImageDelta=${result.visibleImageDelta}`,
                `visibleNewURLs=${result.visibleNewURLs}`,
                `visibleWinnersFromBatch=${result.visibleWinnersFromBatch}`,
                `notVisibleAfterFiltering=${result.notVisibleAfterFiltering}`,
                `visibleImages=${result.visibleImages}`,
                `newBases=${diagnostic.newBases}`,
                `queryVariants=${diagnostic.queryVariants}`,
                `resolutionUpgrades=${diagnostic.resolutionUpgrades}`,
                `dataURLs=${diagnostic.dataURLs}`,
                `blobURLs=${diagnostic.blobURLs}`,
                `zeroDimensions=${diagnostic.zeroDimensions}`,
                `smallDimensions=${diagnostic.smallDimensions}`,
                `photoSwipe=${diagnostic.photoSwipe}`
            );
            return undefined;
        }

        if (message.action === 'start') {
            Promise.resolve(startIsolatedDeepScan(message)).then(
                (result) => sendResponse({success: true, ...result}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }
        if (message.action === 'cancel') {
            Promise.resolve(cancelIsolatedDeepScan(message.scanId, message.endReason)).then(
                (cancelled) => sendResponse({success: true, cancelled}),
                (error) => sendResponse({success: false, error: getErrorMessage(error)})
            );
            return true;
        }

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
