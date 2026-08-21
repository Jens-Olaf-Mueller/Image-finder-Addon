import { Settings } from './Settings.js';

const settings = new Settings('frmSettings'),
      sldMinimumFileSize = document.getElementById('sldMinimumFileSize'),
      spnMinSize = document.getElementById('spnMinSize'),
      chkIgnoreSizes = document.getElementById('chkIgnoreSizes'),
      inpMinWidth = document.getElementById('inpMinWidth'),
      inpMinHeight = document.getElementById('inpMinHeight'),
      inpExcludeList = document.getElementById('inpExcludeList'),
      chkExcludeList = document.getElementById('chkExcludeList'),
      inpUserFolder = document.getElementById('inpUserFolder'),
      btnDownloadFolder = document.getElementById('btnDownloadFolder'),
      radDownloadFolder = document.getElementsByName('downloadFolder');


runSettings();

async function runSettings() {
    await settings.run();
    await setDefaultDownloadFolder();

    setEventListeners();
    updateUI();
}

// async function setDefaultDownloadFolder() {
//     const defaultFolder = settings.get('downloads', 'defaultFolder', '');

//     if (defaultFolder) return;

//     try {
//         const likelyFolder = await settings.getMostLikelyDownloadFolder();

//         if (!likelyFolder) return;

//         settings.data.downloads.defaultFolder = likelyFolder;

//         if (!settings.get('downloads', 'userFolder', '')) {
//             inpUserFolder.value = likelyFolder;
//         }

//         await settings.save();

//     } catch (error) {
//         console.warn('Could not determine download folder:', error);
//     }
// }

async function setDefaultDownloadFolder() {
    let defaultFolder = settings.get('downloads', 'defaultFolder', '');
    let shouldSave = false;

    if (!defaultFolder) {
        try {
            defaultFolder = await settings.getMostLikelyDownloadFolder();

            if (!defaultFolder) return;

            settings.data.downloads.defaultFolder = defaultFolder;
            shouldSave = true;

        } catch (error) {
            console.warn('Could not determine download folder:', error);
            return;
        }
    }

    if (!settings.get('downloads', 'userFolder', '')) {
        inpUserFolder.value = defaultFolder;
        shouldSave = true;
    }

    if (shouldSave) {
        await settings.save();
    }
}

function setEventListeners() {
    sldMinimumFileSize.addEventListener('input', updateMinimumFileSize);
    chkIgnoreSizes.addEventListener('change', updateImageSizeControls);
    chkExcludeList.addEventListener('change', updateExcludeListControls);
    radDownloadFolder.forEach(rad => {
        rad.addEventListener('change', updateDownloadFolderControls);
    });
}

function updateUI() {
    updateMinimumFileSize();
    updateImageSizeControls();
    updateDownloadFolderControls();
    updateExcludeListControls();
}

function updateMinimumFileSize() {
    spnMinSize.innerText = ` ${sldMinimumFileSize.value} KB`;
}

function updateImageSizeControls() {
    const disabled = !chkIgnoreSizes.checked;

    inpMinWidth.disabled = disabled;
    inpMinHeight.disabled = disabled;
    sldMinimumFileSize.disabled = disabled;
    spnMinSize.toggleAttribute('disabled', disabled);
}

function updateDownloadFolderControls() {
    const selected = [...radDownloadFolder].find(rad => rad.checked);
    const disabled = selected?.value !== 'user';

    inpUserFolder.disabled = disabled;
    btnDownloadFolder.disabled = disabled;
}

function updateExcludeListControls() {
    inpExcludeList.disabled = !chkExcludeList.checked;
}
