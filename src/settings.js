import { Settings } from './classes/Settings.js';
import { SettingsPanel } from './classes/SettingsPanel.js';

runSettings();

async function runSettings() {
    const form = await SettingsPanel.load('divSettingsContent');
    const settings = new Settings();
    await settings.run();
    document.documentElement.dataset.mode = settings.getThemeMode();

    const settingsPanel = new SettingsPanel(settings, form);
    await settingsPanel.run({loadSettings: false});
}
