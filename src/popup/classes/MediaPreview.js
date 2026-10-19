import { MediaType } from '../../shared/classes/MediaType.js';
import { getAddonVersionName } from '../../shared/addon-info.js';

const PREVIEW_MODES = new Set(['idle', 'image', 'video', 'audio']);
const IDLE_MEDIA_ICONS = Object.freeze({
    image: 'Image',
    video: 'Video',
    audio: 'Audio'
});

/**
 * Displays the selected media result and its associated metadata in the popup.
 */
export default class MediaPreview {
    #currentBlobPreview = null;
    #image = null;
    #idleIcon = null;
    #idleIconUse = null;
    #statusbar = null;

    #info = null;
    /**
     * Gives or changes the text shown by the preview heading.
     * @type {String}
     */
    get info() { return this.#info.textContent; }
    set info(newInfo) {
        if (typeof newInfo === 'string') this.#info.textContent = newInfo;
    }

    #panel = null;
    /**
     * Gives or replaces the preview container and its contained preview elements.
     * @type {HTMLDivElement}
     */
    get panel() { return this.#panel; }
    set panel(newPanel) {
        if (!(newPanel instanceof HTMLDivElement)) {
            throw new TypeError('MediaPreview requires a preview panel div');
        }

        const image = newPanel.querySelector('#imgPreview');
        const info = newPanel.querySelector('#h2_Preview');
        const idleIcon = newPanel.querySelector('#svgPreviewModeIcon');
        const idleIconUse = newPanel.querySelector('#usePreviewMedia');
        if (!(image instanceof HTMLImageElement) || !(info instanceof HTMLHeadingElement) ||
            !(idleIcon instanceof SVGSVGElement) || !(idleIconUse instanceof SVGUseElement)) {
            throw new TypeError('The preview panel is incomplete');
        }

        this.#panel = newPanel;
        this.#image = image;
        this.#info = info;
        this.#idleIcon = idleIcon;
        this.#idleIconUse = idleIconUse;
        this.#image.dataset.mode = 'image';
        this.#setMediaElementVisibility();
    }

    #mode = 'idle';
    /**
     * Gives or selects the active preview media type.
     * @type {'idle'|'image'|'video'|'audio'}
     */
    get mode() { return this.#mode; }
    set mode(newMode) {
        if (!PREVIEW_MODES.has(newMode)) {
            throw new RangeError(`Unsupported preview mode: ${String(newMode)}`);
        }

        this.#mode = newMode;
        this.#panel.dataset.mode = newMode;
        this.#setMediaElementVisibility();
    }

    /**
     * @param {HTMLDivElement} panel Preview container.
     * @param {HTMLSpanElement} statusbar Popup status bar.
     */
    constructor(panel, statusbar) {
        if (!(statusbar instanceof HTMLSpanElement)) {
            throw new TypeError('MediaPreview requires a preview status bar');
        }

        this.#statusbar = statusbar;
        this.panel = panel;
        this.mode = 'idle';
        this.showPlaceholder();
    }

    /**
     * Chooses the icon shown while no media result or transient status is displayed.
     * @param {'image'|'video'|'audio'} mediaType Active addon media mode.
     */
    setIdleMediaType(mediaType) {
        const iconName = IDLE_MEDIA_ICONS[mediaType];
        if (!iconName) return;

        this.#idleIconUse.setAttribute(
            'href',
            `../assets/icons/button-icons.svg#svgMedia${iconName}`
        );
        this.#idleIcon.setAttribute('aria-label', `${mediaType} mode`);
    }

    /**
     * Shows an image preview and enriches it with file metadata.
     *
     * @param {Object} image Selected image result.
     * @param {Object} options Preview dependencies.
     * @param {Function} [options.isCurrent] Validates the current selection.
     * @param {Function|null} [options.getFileInfo] Resolves file metadata by URL.
     * @returns {Promise<Boolean>} Whether the image is still the active preview.
     */
    async showImage(image, {isCurrent = () => true, getFileInfo = null} = {}) {
        if (!image?.id || typeof image.url !== 'string' || !image.url) return false;

        let previewSource = image.url;
        if (image.source === 'blobimages') {
            const cachedPreview = this.#currentBlobPreview?.imageId === image.id
                ? this.#currentBlobPreview.dataUrl
                : null;

            if (cachedPreview) {
                previewSource = cachedPreview;
            } else {
                this.#currentBlobPreview = null;
                this.#image.removeAttribute('src');

                const response = await window.chrome.runtime.sendMessage({
                    action: 'resolveBlobImage',
                    tabId: image.tabId,
                    blobUrl: image.url
                });

                if (!isCurrent()) return false;
                if (response?.success !== true || typeof response.dataUrl !== 'string') {
                    throw new Error(response?.error || 'Cannot resolve Blob image for preview');
                }

                this.#currentBlobPreview = {imageId: image.id, dataUrl: response.dataUrl};
                previewSource = response.dataUrl;
            }
        } else {
            this.#currentBlobPreview = null;
        }

        if (!isCurrent()) return false;

        this.mode = 'image';
        this.#image.src = previewSource;
        this.#idleIcon.style.display = 'none';
        this.#info.style.display = 'none';
        this.#statusbar.style.display = 'none';

        if (image.fileSize === null &&
            image.source !== 'dataimages' &&
            image.source !== 'blobimages' &&
            typeof getFileInfo === 'function') {
            const fileInfo = await getFileInfo(image.url);

            if (!isCurrent()) return false;
            image.fileSize = fileInfo?.size ?? null;
        }

        if (!isCurrent()) return false;

        this.#showImageMetadata(image);
        return true;
    }

    /**
     * Shows the default empty preview state.
     */
    showPlaceholder() {
        this.#currentBlobPreview = null;
        this.#image.removeAttribute('src');
        this.mode = 'idle';
        this.#idleIcon.style.display = 'block';
        this.#info.style.display = 'none';
    }

    /**
     * Replaces the idle icon with a transient operation or result message.
     * @param {String} text Status text for the preview area.
     */
    showStatus(text) {
        if (typeof text !== 'string' || !text.trim()) return;

        this.#currentBlobPreview = null;
        this.#image.removeAttribute('src');
        this.mode = 'idle';
        this.#idleIcon.style.display = 'none';
        this.#info.style.display = 'block';
        this.info = text;
    }

    /**
     * Shows the addon version when no media item is selected.
     */
    showAddonVersion() {
        this.#statusbar.textContent = `Image Finder – ${getAddonVersionName()}`;
        this.#statusbar.style.display = 'flex';
    }

    // Shows only the media element mapped to the active preview mode.
    #setMediaElementVisibility() {
        if (!this.#panel) return;

        this.#panel.querySelectorAll('[data-mode]').forEach((elmt) => {
            elmt.hidden = elmt.dataset.mode !== this.#mode;
        });
    }

    // Renders the current image metadata in the popup status bar.
    #showImageMetadata(image) {
        const size = image.fileSize >= 1048576
            ? `${parseInt(image.fileSize / 1024 / 1024)} MB`
            : image.fileSize ? `${parseInt(image.fileSize / 1024)} KB` : '??? KB';
        const exactSize = Number.isFinite(image.fileSize) && image.fileSize > 0
            ? ` (${image.fileSize.toLocaleString()} bytes)`
            : '';
        const mediaType = MediaType.getType(image.imageType);
        const icon = mediaType?.icon ?? '../assets/icons/icon512.png';
        const mediaTypeName = mediaType?.type ?? image.mediaType ?? 'image';
        const dimensions = `${image.width} × ${image.height} px`;
        const imageType = String(image.imageType ?? '').toUpperCase();

        this.#statusbar.innerHTML = `
            <img id="imgTypeInfoIcon" src="${icon}" alt="${image.imageType}" style="height: 1.25rem;" title="${imageType} ${mediaTypeName}, Resolution: ${dimensions}, Size: ${size}${exactSize}">
               ${dimensions} [${size}]`;
        this.#statusbar.style.display = 'flex';
    }
}
