
import { ImageFinder } from './classes/ImageFinder.js';
import { loadSettingsForm, SettingsForm } from './classes/SettingsForm.js';

const imageFinder = new ImageFinder();

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
