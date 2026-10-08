/**
 * Renders and sorts the visible media results in the popup list.
 */
export default class MediaList {
    #listElement;
    #itemsByImageId = new Map();

    constructor(listElement) {
        if (!listElement) throw new TypeError('MediaList requires a list element');

        this.#listElement = listElement;
    }

    get selectedItem() {
        return this.#listElement.querySelector('.selected') || null;
    }

    get items() {
        return Array.from(this.#listElement.querySelectorAll('li'));
    }

    get selectedIndex() {
        return this.items.indexOf(this.selectedItem);
    }

    // ✏️ EDIT 2026-10-08: Reconciles only changed result entries instead of rebuilding the list.
    reconcile(images, changes, {getMarkerState = null} = {}) {
        const renderState = this.#captureRenderState();
        let selectedItem = null;
        let selectedItemByURL = null;
        const addedImageIds = changes?.addedImageIds ?? new Set();
        const updatedImageIds = changes?.updatedImageIds ?? new Set();
        const removedImageIds = changes?.removedImageIds ?? new Set();

        removedImageIds.forEach((imageId) => this.remove(imageId));
        images?.forEach((image, imageId) => {
            const markerState = typeof getMarkerState === 'function'
                ? getMarkerState(imageId, image, renderState.savedImageIds)
                : 'normal';
            const isSaved = renderState.savedImageIds.has(imageId);
            let item = this.#itemsByImageId.get(imageId);

            if (!item) {
                item = this.#createItem(image, imageId, {markerState, isSaved});
                this.#itemsByImageId.set(imageId, item);
                this.#listElement.appendChild(item);
            } else if (addedImageIds.has(imageId) || updatedImageIds.has(imageId)) {
                this.#updateItem(item, image, {markerState, isSaved});
            }
            if (imageId === renderState.selectedImageId) selectedItem = item;
            if (!selectedItemByURL && image?.url === renderState.selectedImageURL) {
                selectedItemByURL = item;
            }
        });

        selectedItem ??= selectedItemByURL;
        if (selectedItem) selectedItem.classList.add('selected');

        return {
            selectedItem,
            previousSelectedImageId: renderState.selectedImageId,
            selectionRemoved: Boolean(renderState.selectedImageId && !selectedItem)
        };
    }

    clear() {
        this.#listElement.innerHTML = '';
        this.#itemsByImageId.clear();
    }

    remove(imageId) {
        const item = this.#itemsByImageId.get(imageId);
        if (!item) return false;

        item.remove();
        this.#itemsByImageId.delete(imageId);
        return true;
    }

    // ✴️ NEW 2026-10-08: Captures selection and completed-download styling before a full render.
    #captureRenderState() {
        const selectedItem = this.selectedItem;

        return {
            selectedImageId: selectedItem?.dataset.imageId ?? null,
            selectedImageURL: selectedItem?.dataset.url ?? null,
            savedImageIds: new Set(
                this.items
                    .filter((item) => item.classList.contains('saved'))
                    .map((item) => item.dataset.imageId)
            )
        };
    }

    // ✴️ NEW 2026-10-08: Creates one list entry with its marker and file label.
    #createItem(image, imageId, {markerState, isSaved}) {
        const item = document.createElement('li');
        const marker = document.createElement('span');
        const label = document.createElement('span');

        marker.className = 'result-marker';
        marker.setAttribute('aria-hidden', 'true');
        label.className = 'result-label';
        item.append(marker, label);
        this.#updateItem(item, image, {imageId, markerState, isSaved});

        return item;
    }

    // ✴️ NEW 2026-10-08: Changes DOM attributes only when their rendered value changed.
    #updateItem(item, image, {imageId = null, markerState, isSaved}) {
        const marker = item.querySelector('.result-marker');
        const label = item.querySelector('.result-label');

        if (imageId !== null) item.dataset.imageId = imageId;
        if (item.title !== image.fileName) item.title = image.fileName;
        if (item.dataset.url !== image.url) item.dataset.url = image.url;
        if (marker && marker.dataset.state !== markerState) marker.dataset.state = markerState;
        if (label && label.textContent !== image.fileName) label.textContent = image.fileName;
        item.classList.toggle('saved', isSaved);
    }
}
