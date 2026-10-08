/**
 * Renders and sorts the visible media results in the popup list.
 */
export default class MediaList {
    #listElement;

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

    // ✴️ NEW 2026-10-08: Rebuilds the current list while preserving its visible UI state.
    render(images, {getMarkerState = null} = {}) {
        const renderState = this.#captureRenderState();
        let selectedItem = null;
        let selectedItemByURL = null;

        this.#listElement.innerHTML = '';
        images?.forEach((image, imageId) => {
            const item = this.#createItem(image, imageId, {
                markerState: typeof getMarkerState === 'function'
                    ? getMarkerState(imageId, image, renderState.savedImageIds)
                    : 'normal',
                isSaved: renderState.savedImageIds.has(imageId)
            });
            if (imageId === renderState.selectedImageId) selectedItem = item;
            if (!selectedItemByURL && image?.url === renderState.selectedImageURL) {
                selectedItemByURL = item;
            }

            this.#listElement.appendChild(item);
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

        item.title = image.fileName;
        item.dataset.imageId = imageId;
        item.dataset.url = image.url;
        marker.className = 'result-marker';
        marker.dataset.state = markerState;
        marker.setAttribute('aria-hidden', 'true');
        label.className = 'result-label';
        label.textContent = image.fileName;
        item.append(marker, label);
        if (isSaved) item.classList.add('saved');

        return item;
    }
}
