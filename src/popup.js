
import { ImageFinder } from './classes/ImageFinder.js';
import { loadSettingsForm, SettingsView } from './classes/settingsView.js';

const imageFinder = new ImageFinder();

runPopup();

async function runPopup() {
    let settingsForm = null;

    try {
        settingsForm = await loadSettingsForm('divSettingsContentPopup');
    } catch (error) {
        console.warn('Cannot load settings form:', error);
    }

    await imageFinder.run(async () => {
        if (!settingsForm) return;

        const settingsView = new SettingsView(imageFinder.settings, settingsForm, {
            onSettingsChanged: () => imageFinder.updateDownloadTitles()
        });
        imageFinder.setSettingsView(settingsView);
        await settingsView.run({loadSettings: false});
    });
}
