
import { MediaController } from './classes/MediaController.js';
import { SettingsPanel } from './classes/SettingsPanel.js';
import './debug-logger.js';

const popupDebugLogger = globalThis.ImageFinderDebugLogger?.createLogger({
    source: 'popup',
    sendRecords: (records) => {
        try {
            return window.chrome.runtime.sendMessage({
                target: 'image-finder-debug-log',
                action: 'records',
                records
            }).catch(() => undefined);
        } catch {
            return Promise.resolve();
        }
    }
})?.install();
globalThis.imageFinderDebugLogger = popupDebugLogger;
const mediaController = new MediaController();
const POPUP_DEEP_SCAN_PORT_NAME = 'image-finder-popup-deepscan';
let popupDeepScanClientId = null;
let popupDeepScanPort = null;

try {
    popupDeepScanClientId = crypto.randomUUID();
    popupDeepScanPort = window.chrome.runtime.connect({
        name: `${POPUP_DEEP_SCAN_PORT_NAME}:${popupDeepScanClientId}`
    });
    mediaController.setDeepScanClientId(popupDeepScanClientId);
} catch {
    // pagehide still uses the central scan cancellation path when a lifecycle port is unavailable.
}

window.addEventListener('pagehide', () => {
    if (!mediaController.isScanRunning) return;

    console.info('[Scan LIFECYCLE]', {
        event: 'popup-disconnected',
        scanRunning: mediaController.isScanRunning,
        deepScanRunning: mediaController.isDeepScanRunning,
        abortRequested: true
    });
    void mediaController.stopScan({endReason: 'popup-closed'});
}, {once: true});

runPopup();

async function runPopup() {
    let form = null;

    try {
        form = await SettingsPanel.load('divSettingsContentPopup');
    } catch (error) {
        console.warn('Cannot load settings form:', error);
    }

    await mediaController.run(async () => {
        if (!form) return;

        const settingsPanel = new SettingsPanel(mediaController.settings, form, {
            onSettingsChanged: () => mediaController.updateDownloadTitles()
        });
        mediaController.popup.setSettingsPanel(settingsPanel);
        await settingsPanel.run({loadSettings: false});
    });
}
