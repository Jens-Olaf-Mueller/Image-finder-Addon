/**
 * Performs persistent single, batch, and ZIP downloads in the service worker.
 */
class DownLoader {
    #createZipDownload = null;
    #downloadBlob = null;
    #getErrorMessage = null;
    #onJobUpdate = null;
    #resolvePageBlob = null;
    #jobs = new Map();

    /**
     * @param {Object} dependencies Service-worker download dependencies.
     * @param {Function} dependencies.createZipDownload Creates a ZIP in the offscreen document.
     * @param {Function} dependencies.downloadBlob Creates a browser download from a Blob.
     * @param {Function} dependencies.getErrorMessage Converts errors to messages.
     * @param {Function} dependencies.resolvePageBlob Resolves page-local Blob URLs.
     * @param {Function} [dependencies.onJobUpdate] Receives serializable job updates.
     */
    constructor({
        createZipDownload,
        downloadBlob,
        getErrorMessage,
        resolvePageBlob,
        onJobUpdate = null
    } = {}) {
        this.#createZipDownload = typeof createZipDownload === 'function'
            ? createZipDownload
            : null;
        this.#downloadBlob = typeof downloadBlob === 'function' ? downloadBlob : null;
        this.#getErrorMessage = typeof getErrorMessage === 'function'
            ? getErrorMessage
            : error => error instanceof Error ? error.message : String(error);
        this.#resolvePageBlob = typeof resolvePageBlob === 'function' ? resolvePageBlob : null;
        this.#onJobUpdate = typeof onJobUpdate === 'function' ? onJobUpdate : null;
    }

    /**
     * Starts one direct media download and returns its browser download identifier.
     * @param {Object} media Download descriptor.
     * @returns {Promise<Number>} Browser download identifier.
     */
    async download(media) {
        return this.#startMediaDownload(media);
    }

    /**
     * Starts a persistent batch job without keeping the sender's message request open.
     * @param {Object[]} media Download descriptors.
     * @param {Object|null} [zipOptions=null] ZIP download options or null for separate files.
     * @returns {Object} Initial job state.
     */
    startList(media, zipOptions = null) {
        if (!Array.isArray(media) || media.length === 0) {
            throw new Error('The download list is empty');
        }

        const job = {
            id: crypto.randomUUID(),
            media,
            zipOptions: zipOptions && typeof zipOptions === 'object' ? zipOptions : null,
            state: 'preparing',
            completed: 0,
            failed: 0,
            startedAt: Date.now(),
            results: []
        };
        this.#jobs.set(job.id, job);
        this.#emitJobUpdate('started', job);
        void this.#runListJob(job);

        return this.#getJobState(job);
    }

    /**
     * Returns the current serializable state of a known background download job.
     * @param {String} jobId Background job identifier.
     * @returns {Object|null} Current job state.
     */
    getJob(jobId) {
        const job = typeof jobId === 'string' ? this.#jobs.get(jobId) : null;
        return job ? this.#getJobState(job) : null;
    }

    /**
     * Updates the progress reported by the offscreen ZIP builder.
     * @param {String} jobId Background job identifier.
     * @param {Object} progress ZIP preparation progress.
     * @returns {Boolean} Whether the known job was updated.
     */
    updateJob(jobId, progress = {}) {
        const job = typeof jobId === 'string' ? this.#jobs.get(jobId) : null;
        if (!job) return false;

        const {completed, failed, state} = progress;
        if (Number.isInteger(completed)) {
            job.completed = Math.min(job.media.length, Math.max(0, completed));
        }
        if (Number.isInteger(failed)) {
            job.failed = Math.min(job.media.length, Math.max(0, failed));
        }
        if (state === 'preparing' || state === 'compressing') job.state = state;

        this.#emitJobUpdate('progress', job);
        return true;
    }

    // ✴️ NEW 2026-10-15: Keeps list preparation independent from a closing popup.
    async #runListJob(job) {
        try {
            job.results = job.zipOptions
                ? await this.#downloadMediaZip(job)
                : await this.#downloadMediaList(job);
            job.state = 'started';
            job.finishedAt = Date.now();
            this.#emitJobUpdate('completed', job);
        } catch (error) {
            job.state = 'failed';
            job.error = this.#getErrorMessage(error);
            job.finishedAt = Date.now();
            this.#emitJobUpdate('failed', job);
        }
    }

    // ✴️ NEW 2026-10-15: Starts the individual browser downloads of one non-ZIP list.
    async #downloadMediaList(job) {
        const results = [];

        for (const item of job.media) {
            try {
                const downloadId = await this.#startMediaDownload(item);
                results.push({
                    imageId: item?.imageId,
                    url: item?.url,
                    success: true,
                    downloadId
                });
            } catch (error) {
                const message = this.#getErrorMessage(error);
                console.warn('Cannot download image from list:', item?.url, error);
                results.push({
                    imageId: item?.imageId,
                    url: item?.url,
                    success: false,
                    error: message
                });
                job.failed += 1;
            }

            job.completed += 1;
            this.#emitJobUpdate('progress', job);
        }

        return results;
    }

    // ✏️ EDIT 2026-10-15: Delegates ZIP construction to the offscreen document to avoid message-size limits.
    async #downloadMediaZip(job) {
        if (!this.#createZipDownload) {
            throw new Error('The offscreen ZIP service is unavailable');
        }

        const results = await this.#createZipDownload(job.media, job.zipOptions, job.id);
        job.completed = job.media.length;
        job.failed = results.filter(item => item.success !== true).length;
        job.state = 'downloading';
        this.#emitJobUpdate('progress', job);
        return results;
    }

    // ✴️ NEW 2026-10-15: Hands regular and page-local media to the browser download manager.
    async #startMediaDownload(media) {
        const {url, source, tabId, options} = this.#getDownloadRequest(media);

        if (source === 'dataimages') {
            return this.#downloadBlob(await this.#dataUrlToBlob(url), options);
        }

        if (source === 'blobimages') {
            const dataUrl = await this.#resolvePageBlob(tabId, url);
            return this.#downloadBlob(await this.#dataUrlToBlob(dataUrl), options);
        }

        return chrome.downloads.download({url, ...options});
    }

    // ✴️ NEW 2026-10-15: Validates one media descriptor before it reaches browser APIs.
    #getDownloadRequest(media) {
        if (!media || typeof media.url !== 'string' || !media.url.trim()) {
            throw new Error('The media download URL is invalid');
        }
        if (!this.#downloadBlob || !this.#resolvePageBlob) {
            throw new Error('The background download service is unavailable');
        }

        return {
            url: media.url.trim(),
            source: media.source,
            tabId: media.tabId,
            options: media.options && typeof media.options === 'object'
                ? media.options
                : {}
        };
    }

    // ✴️ NEW 2026-10-15: Converts data URLs to Blobs without imposing an image-only MIME restriction.
    async #dataUrlToBlob(dataUrl) {
        if (typeof dataUrl !== 'string' || !/^data:/i.test(dataUrl)) {
            throw new Error('The media data URL is invalid');
        }

        const response = await fetch(dataUrl);
        if (!response.ok) throw new Error('Cannot convert media data to Blob');

        return response.blob();
    }

    // ✴️ NEW 2026-10-15: Sends a compact job snapshot to popup clients without exposing media bytes.
    #emitJobUpdate(action, job) {
        if (!this.#onJobUpdate) return;

        this.#onJobUpdate({
            action,
            job: this.#getJobState(job),
            ...(action === 'completed' || action === 'failed' ? {results: job.results} : {})
        });
    }

    // ✴️ NEW 2026-10-15: Creates the message-safe representation of one background job.
    #getJobState(job) {
        return {
            id: job.id,
            type: job.zipOptions ? 'zip' : 'list',
            state: job.state,
            completed: job.completed,
            total: job.media.length,
            failed: job.failed,
            startedAt: job.startedAt,
            finishedAt: job.finishedAt ?? null,
            error: job.error ?? null
        };
    }
}

// ✏️ EDIT 2026-10-15: Exposes the classic-worker class to background.js via importScripts().
globalThis.DownLoader = DownLoader;
