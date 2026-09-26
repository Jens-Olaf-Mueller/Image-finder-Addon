
import { ImageFinder } from './classes/ImageFinder.js';
import { loadSettingsForm, SettingsForm } from './classes/SettingsForm.js';

const imageFinder = new ImageFinder();
const POPUP_DEEP_SCAN_PORT_NAME = 'image-finder-popup-deepscan';
let popupDeepScanClientId = null;
let popupDeepScanPort = null;

try {
    popupDeepScanClientId = crypto.randomUUID();
    popupDeepScanPort = window.chrome.runtime.connect({
        name: `${POPUP_DEEP_SCAN_PORT_NAME}:${popupDeepScanClientId}`
    });
    imageFinder.setDeepScanClientId(popupDeepScanClientId);
} catch {
    // pagehide still uses the central scan cancellation path when a lifecycle port is unavailable.
}

window.addEventListener('pagehide', () => {
    if (!imageFinder.isScanRunning) return;

    console.info('[Scan LIFECYCLE]', {
        event: 'popup-disconnected',
        scanRunning: imageFinder.isScanRunning,
        deepScanRunning: imageFinder.isDeepScanRunning,
        abortRequested: true
    });
    void imageFinder.stopScan({endReason: 'popup-closed'});
}, {once: true});

runPopup();

async function runPopup() {
    let form = null;

    try {
        form = await loadSettingsForm('divSettingsContentPopup');
    } catch (error) {
        console.warn('Cannot load settings form:', error);
    }

    await imageFinder.run(async () => {
        if (!form) return;

        const settingsForm = new SettingsForm(imageFinder.settings, form, {
            onSettingsChanged: () => imageFinder.updateDownloadTitles()
        });
        imageFinder.setSettingsForm(settingsForm);
        await settingsForm.run({loadSettings: false});
    });
}
