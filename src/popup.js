
import { ImageFinder } from './ImageFinder.js';

const imageFinder = new ImageFinder();

imageFinder.run();

// const divToolbar = document.getElementById('divToolbar');
// const btnSave = document.getElementById('btnSave');
// const btnSaveAll = document.getElementById('btnSaveAll');
// const btnDelete = document.getElementById('btnDelete');
// const btnClear = document.getElementById('btnClear');
// const lstImages = document.getElementById('lstImages');
// const imgPreview = document.getElementById('imgPreview');
// const h2_Preview = document.getElementById('h2_Preview');

// const images = new Map();

// runAddOn();

// function runAddOn() {
//     setEventListeners();
// }

// function setEventListeners() {
//     divToolbar.addEventListener('click', onButtonClick);
//     lstImages.addEventListener('click', onListItemClick);
// }

// function onListItemClick(e) {
//     const li = e.target.closest('li');
//     if (!li) return;

//     lstImages.querySelector('.selected')?.classList.remove('selected');
//     li.classList.add('selected');
//     imgPreview.src = li.dataset.url;
//     h2_Preview.style.display = 'none';

//     btnSave.disabled = false;
//     btnDelete.disabled = false;
// }

// async function onButtonClick(e) {
//     const btn = e.target.closest('button');
//     if (!btn) return;

//     const btnName = btn.id.slice(3).toLowerCase() || '';
//     switch (btnName) {
//         case 'settings':
//             window.chrome.runtime.openOptionsPage();
//             break;

//         case 'search':
//             await findImages();
//             break;

//         case 'save':
//             await saveImage();
//             break;

//         case 'saveall':
//             await saveAllImages();
//             break;

//         case 'delete':
//             deleteImage();
//             break;

//         case 'clear':
//             clear();
//             break;

//         case 'restart':
//             // TODO restart AddOn
//             break;

//         default:
//             console.log(`Unhandled button: [${btnName}]`)
//             break;
//     }
// }

// function clear() {
//     images.clear();
//     lstImages.innerHTML = '';
//     imgPreview.src = '';
//     h2_Preview.style.display = 'block';
//     btnSave.disabled = true;
//     btnSaveAll.disabled = true;
//     btnDelete.disabled = true;
//     btnClear.disabled = true;
// }

// async function findImages() {
//     const [tab] = await window.chrome.tabs.query({
//         active: true,
//         currentWindow: true
//     });

//     const result = await window.chrome.scripting.executeScript({
//         target: {
//             tabId: tab.id
//         },
//         files: [
//             '/src/content.js'
//         ]
//     });

//     clear();
//     const foundImages = result[0]?.result ?? [];

//     foundImages.forEach((image) => {
//         const url = new URL(image.url);
//         const fileName = decodeURIComponent(
//             url.pathname.split('/').pop()
//         );

//         images.set(image.url, {
//             fileName: fileName,
//             width: image.width,
//             height: image.height
//         });
//     });

//     images.forEach((image, url) => {
//         const li = document.createElement('li');
//         li.textContent = image.fileName;
//         li.title = image.fileName;
//         li.dataset.url = url;
//         lstImages.appendChild(li);
//     });

//     btnSaveAll.disabled = (images.size == 0);
//     btnClear.disabled = (images.size == 0);

//     console.table([...images.entries()]);
// }

// async function saveAllImages() {
//     for (const [url, image] of images) {
//         await window.chrome.downloads.download({
//             url: url,
//             filename: image.fileName,
//             saveAs: false
//         });
//     }

//     lstImages.querySelectorAll('li').forEach((li) => {
//         li.classList.add('saved');
//     });
// }

// async function saveImage() {
//     const li = lstImages.querySelector('.selected');
//     if (!li) return;

//     await window.chrome.downloads.download({
//         url: li.dataset.url,
//         filename: li.textContent,
//         saveAs: false // true → shows the browser's save dialog!
//     });

//     li.classList.add('saved');
// }

// function deleteImage() {
//     const li = lstImages.querySelector('.selected');
//     if (!li) return;

//     images.delete(li.dataset.url);
//     li.remove();

//     imgPreview.removeAttribute('src');

//     btnSave.disabled = true;
//     btnDelete.disabled = true;
// }