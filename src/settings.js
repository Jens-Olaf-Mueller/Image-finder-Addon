import { Settings } from './classes/Settings.js';
import { loadSettingsForm, SettingsForm } from './classes/SettingsForm.js';

runSettings();

async function runSettings() {
    const form = await loadSettingsForm('divSettingsContent');
    const settings = new Settings();
    const settingsForm = new SettingsForm(settings, form);

    await settingsForm.run();
}
