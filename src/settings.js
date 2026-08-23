import { Settings } from './classes/Settings_class.js';
import { loadSettingsForm, SettingsView } from './classes/settingsView.js';

runSettings();

async function runSettings() {
    const form = await loadSettingsForm('divSettingsContent');
    const settings = new Settings(form);
    const settingsView = new SettingsView(settings, form);

    await settingsView.run();
}
