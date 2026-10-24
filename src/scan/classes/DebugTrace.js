function getRect(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect) return null;

    return {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
    };
}

function getElementInfo(element) {
    if (!(element instanceof Element)) return null;

    const image = element.matches('img') ? element : element.querySelector?.('img');
    const className = typeof element.className === 'string'
        ? element.className.trim().slice(0, 240)
        : '';

    return {
        tag: element.tagName.toLowerCase(),
        id: element.id || null,
        className: className || null,
        rect: getRect(element),
        image: image ? {
            currentSrc: image.currentSrc || image.src || null,
            naturalWidth: image.naturalWidth || 0,
            naturalHeight: image.naturalHeight || 0
        } : null,
        swiper: Boolean(element.closest('.swiper, [class*="swiper"]')),
        photoSwipe: Boolean(element.closest('.pswp'))
    };
}

function isVisibleElement(element) {
    if (!(element instanceof Element)) return false;

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 &&
        rect.right > 0 && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.top < window.innerHeight;
}

/**
 * Records a small, user-driven DOM trace in the visible top-level tab.
 */
export default class DebugTrace {
    #log = () => undefined;
    #onClick = event => this.#handleClick(event);
    #onImageLoad = event => this.#handleImageLoad(event);
    #onMarkClick = event => this.#handleMarkClick(event);
    #onMarkSelected = () => undefined;
    #selectModeActive = false;
    #snapshotTimer = null;

    constructor({log = null, onMarkSelected = null} = {}) {
        if (typeof log === 'function') this.#log = log;
        if (typeof onMarkSelected === 'function') this.#onMarkSelected = onMarkSelected;
    }

    start() {
        document.addEventListener('click', this.#onClick, true);
        document.addEventListener('load', this.#onImageLoad, true);
        this.#log('[Manual Debug] recording started', this.#getPhotoSwipeSnapshot());
    }

    stop() {
        this.#log('[Manual Debug] recording stopped', this.#getPhotoSwipeSnapshot());
        document.removeEventListener('click', this.#onClick, true);
        document.removeEventListener('load', this.#onImageLoad, true);
        clearTimeout(this.#snapshotTimer);
        this.#snapshotTimer = null;
        this.#stopSelectMode();
    }

    // ✏️ EDIT 2026-10-24: Arms the next real media click without altering the page visually.
    mark() {
        if (this.#selectModeActive) return {selecting: true};

        this.#selectModeActive = true;
        document.addEventListener('click', this.#onMarkClick, true);
        const result = {selecting: true};
        this.#log('[Manual Debug] select mode started', result);
        return result;
    }

    #stopSelectMode() {
        if (!this.#selectModeActive) return;

        this.#selectModeActive = false;
        document.removeEventListener('click', this.#onMarkClick, true);
    }

    #findMarkTarget(element) {
        if (!(element instanceof Element)) return null;

        // ✏️ EDIT 2026-10-24: A selected Swiper is the shared carousel root for
        // video and photo slides; it must take precedence over the current slide.
        const carousel = element.closest('.swiper');
        if (isVisibleElement(carousel)) return carousel;

        const mediaTarget = element.closest(
            '[at-attr="media_locator"], .b-post__media__item-inner'
        );
        return isVisibleElement(mediaTarget) ? mediaTarget : null;
    }

    #handleMarkClick(event) {
        const element = this.#findMarkTarget(event.target);
        if (!element) return;

        this.#stopSelectMode();

        const result = {selected: true, target: getElementInfo(element)};
        this.#log('[Manual Debug] media target selected', result);
        try {
            this.#onMarkSelected(result);
        } catch {
            // Selection reporting must never interfere with the user's original click.
        }
    }

    #handleClick(event) {
        const element = event.target instanceof Element ? event.target : null;
        if (!element) return;

        this.#log('[Manual Debug] click', {
            trusted: event.isTrusted === true,
            target: getElementInfo(element)
        });
        this.#queueSnapshot('after-click');
    }

    #handleImageLoad(event) {
        const image = event.target;
        if (!(image instanceof HTMLImageElement)) return;

        this.#log('[Manual Debug] image loaded', getElementInfo(image));
    }

    #queueSnapshot(reason) {
        if (this.#snapshotTimer !== null) clearTimeout(this.#snapshotTimer);
        this.#snapshotTimer = setTimeout(() => {
            this.#snapshotTimer = null;
            this.#log('[Manual Debug] snapshot', {
                reason,
                photoSwipe: this.#getPhotoSwipeSnapshot()
            });
        }, 150);
    }

    #getPhotoSwipeSnapshot() {
        const root = document.querySelector('.pswp--open, .pswp');
        if (!(root instanceof Element)) return {open: false};

        const activeImage = root.querySelector('.pswp__item--current img, img.pswp__img');
        return {
            open: root.classList.contains('pswp--open'),
            root: getElementInfo(root),
            activeImage: getElementInfo(activeImage)
        };
    }
}
