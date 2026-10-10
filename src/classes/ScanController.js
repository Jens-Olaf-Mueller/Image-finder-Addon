/**
 * Coordinates normal scans, DeepScan sessions, cancellation, and scan lifecycle state.
 */
export default class ScanController {
    // ✴️ NEW 2026-10-10: Owns scan lifecycle state independently of Popup and result rendering.
    #activityCounts = {
        scanner: 0,
        duplicateFinder: 0,
        blurScanner: 0,
        deepScan: 0
    };
    #scanner = null;
    #onActivityChange = null;
    #onScanRunningChange = null;
    #onScanStopped = null;
    #scanGeneration = 0;
    #abortController = null;

    /**
     * The current scan generation. Callbacks of older generations must no longer update state.
     * @type {Number}
     */
    get scanGeneration() { return this.#scanGeneration; }

    /**
     * Indicates whether an ImageScanner DeepScan session is currently active.
     * @type {Boolean}
     */
    get isDeepScanRunning() { return this.#scanner?.isDeepScanRunning === true; }

    /**
     * Indicates whether a normal scan, analysis task, or DeepScan session is currently active.
     * @type {Boolean}
     */
    get isScanRunning() {
        return this.#abortController !== null || this.isDeepScanRunning ||
            Object.values(this.#activityCounts).some((count) => count > 0);
    }

    /**
     * The activity which currently has the highest visual priority.
     * @type {String}
     */
    get activity() {
        if (this.#activityCounts.deepScan > 0) return 'deepScan';
        if (this.#activityCounts.blurScanner > 0) return 'blurScanner';
        if (this.#activityCounts.duplicateFinder > 0) return 'duplicateFinder';
        if (this.#activityCounts.scanner > 0) return 'scanner';
        return 'none';
    }

    /**
     * @param {ImageScanner} scanner - Scanner which performs normal and DeepScan discovery.
     * @param {Object} [options={}] - Lifecycle notifications owned by the calling controller.
     * @param {Function|null} [options.onActivityChange=null] - Called after the visible activity changes.
     * @param {Function|null} [options.onScanRunningChange=null] - Called when the scan state changes.
     * @param {Function|null} [options.onScanStopped=null] - Cleans up caller-owned UI after an explicit abort.
     */
    constructor(scanner, {
        onActivityChange = null,
        onScanRunningChange = null,
        onScanStopped = null
    } = {}) {
        this.#scanner = scanner;
        this.#onActivityChange = onActivityChange;
        this.#onScanRunningChange = onScanRunningChange;
        this.#onScanStopped = onScanStopped;
    }

    /**
     * Starts a new scan generation and delegates result-specific work to the caller.
     *
     * @param {Object} options - Scan lifecycle callbacks.
     * @param {ScanContext} options.scanContext - Context for a possible DeepScan.
     * @param {Function|null} [options.onPrepare=null] - Resets caller-owned result and UI state.
     * @param {Function|null} [options.onNormalScanStart=null] - Receives the normal scan candidate count.
     * @param {Function|null} [options.onNormalScanProgress=null] - Receives normal scan progress updates.
     * @param {Function|null} [options.onNormalScanResults=null] - Stores and filters normal scan results.
     * @param {Function|null} [options.shouldStartDeepScan=null] - Decides whether a DeepScan may start.
     * @param {Function|null} [options.onDeepScanStart=null] - Prepares caller-owned DeepScan UI state.
     * @param {Function|null} [options.onDeepScanCandidates=null] - Stores and filters a DeepScan batch.
     * @param {Function|null} [options.onDeepScanFinished=null] - Finalizes caller-owned DeepScan state.
     * @param {Function|null} [options.onScanCompleted=null] - Updates caller-owned completed scan state.
     * @param {Function|null} [options.onScanError=null] - Receives an unexpected normal scan error.
     * @param {Function|null} [options.onFinalize=null] - Final cleanup while the generation is current.
     */
    async scan({
        scanContext,
        onPrepare = null,
        onNormalScanStart = null,
        onNormalScanProgress = null,
        onNormalScanResults = null,
        shouldStartDeepScan = null,
        onDeepScanStart = null,
        onDeepScanCandidates = null,
        onDeepScanFinished = null,
        onScanCompleted = null,
        onScanError = null,
        onFinalize = null
    } = {}) {
        void this.#scanner.cancelDeepScan();
        this.#abortController?.abort();

        const abortController = new AbortController();
        const scanGeneration = this.#scanGeneration + 1;
        const scan = this.#createScanContext(scanGeneration, abortController.signal);
        let scanCompleted = false;
        let scannerActivityActive = false;
        let deepScanActivityActive = false;
        let deepScanStarted = false;
        let deepScanFailed = false;
        let deepScanCandidateCount = 0;
        let deepScanCompletion = null;

        this.#scanGeneration = scanGeneration;
        this.#abortController = abortController;
        this.#setScanRunning(true);
        this.#resetActivities();
        this.startActivity('scanner', scanGeneration);
        scannerActivityActive = true;

        try {
            await onPrepare?.(scan);

            const scanResults = await this.#scanner.scan({
                onStart: (count) => onNormalScanStart?.(count, scan),
                onProgress: () => onNormalScanProgress?.(scan),
                signal: abortController.signal
            });
            if (!scan.isCurrent()) return;

            scanContext.tab = this.#scanner.currentTab;
            const visibleResultsUpdated = await onNormalScanResults?.(scanResults, scan);
            if (visibleResultsUpdated !== true || !scan.isCurrent()) return;

            scanCompleted = true;
            if (await shouldStartDeepScan?.(scan) !== true || !scan.isCurrent()) return;

            deepScanStarted = true;
            this.stopActivity('scanner', scanGeneration);
            scannerActivityActive = false;
            await onDeepScanStart?.(scan);
            if (!scan.isCurrent()) return;

            this.startActivity('deepScan', scanGeneration);
            deepScanActivityActive = true;

            try {
                const deepScanCandidates = await this.#scanner.scanDeepImages(
                    scanContext,
                    (rawCandidates, signal, diagnostic = null) =>
                        onDeepScanCandidates?.(rawCandidates, signal, diagnostic, scan)
                );
                deepScanCandidateCount = deepScanCandidates.length;
            } catch (error) {
                if (scan.isCurrent()) {
                    console.warn('Cannot deep scan this page:', error);
                }
                deepScanFailed = true;
            } finally {
                if (scan.isCurrent()) {
                    deepScanCompletion = await onDeepScanFinished?.({
                        scan,
                        failed: deepScanFailed,
                        candidateCount: deepScanCandidateCount
                    });
                }
                this.stopActivity('deepScan', scanGeneration);
                deepScanActivityActive = false;
            }
        } catch (error) {
            if (scan.isCurrent()) {
                await onScanError?.(error, scan);
            }
        } finally {
            if (scannerActivityActive) this.stopActivity('scanner', scanGeneration);
            if (deepScanActivityActive) this.stopActivity('deepScan', scanGeneration);

            if (scanCompleted && scan.isCurrent()) {
                await onScanCompleted?.({
                    scan,
                    deepScanStarted,
                    deepScanFailed,
                    deepScanCandidateCount,
                    deepScanCompletion
                });
            }
            if (scan.isCurrent()) {
                await onFinalize?.(scan);
                if (this.#abortController === abortController) {
                    this.#abortController = null;
                }
                this.#setScanRunning(false);
            }
        }
    }

    /**
     * Stops the active scan generation and waits until the DeepScan context is released.
     *
     * @param {Object} [options={}] - Stop options.
     * @param {String} [options.endReason='user-abort'] - Reason forwarded to the DeepScan scanner.
     * @returns {Promise<Boolean>} Whether an active scan was stopped.
     */
    async stop({endReason = 'user-abort'} = {}) {
        if (!this.isScanRunning) return false;

        this.#scanGeneration += 1;
        this.#abortController?.abort();
        this.#abortController = null;
        this.#resetActivities();
        this.#setScanRunning(false);
        this.#onScanStopped?.();
        await this.cancelDeepScan({endReason});
        return true;
    }

    /**
     * Invalidates an active scan without waiting for its DeepScan cleanup.
     *
     * @param {Object} [options={}] - Invalidation options.
     * @param {String} [options.endReason='cancelled'] - Reason forwarded to the DeepScan scanner.
     */
    invalidate({endReason = 'cancelled'} = {}) {
        void this.#scanner.cancelDeepScan({endReason});
        this.#scanGeneration += 1;
        this.#abortController?.abort();
        this.#abortController = null;
        this.#resetActivities();
        this.#setScanRunning(false);
        this.#onScanStopped?.();
    }

    /**
     * Stops the active DeepScan context.
     *
     * @param {Object} [options={}] - Cancellation options.
     * @param {String} [options.endReason='cancelled'] - Reason forwarded to the DeepScan scanner.
     * @returns {Promise<Boolean>} Whether a DeepScan session was cancelled.
     */
    async cancelDeepScan({endReason = 'cancelled'} = {}) {
        return this.#scanner.cancelDeepScan({endReason});
    }

    /**
     * Assigns the offscreen DeepScan client which owns the hidden scan context.
     *
     * @param {String|null} clientId - Offscreen client identifier.
     */
    setDeepScanClientId(clientId) {
        this.#scanner.setDeepScanClientId(clientId);
    }

    /**
     * Indicates whether a scan generation may still update caller-owned state.
     *
     * @param {Number} scanGeneration - Generation captured by an asynchronous task.
     * @returns {Boolean} Whether the generation is current.
     */
    isCurrent(scanGeneration) {
        return scanGeneration === this.#scanGeneration;
    }

    /**
     * Indicates whether an activity is currently active.
     *
     * @param {String} type - Activity type.
     * @returns {Boolean} Whether the activity count is greater than zero.
     */
    isActivityRunning(type) {
        return this.#activityCounts[type] > 0;
    }

    /**
     * Starts a named scan or analyzer activity for the current generation.
     *
     * @param {String} type - Activity type.
     * @param {Number|null} [scanGeneration=null] - Optional generation guard.
     */
    startActivity(type, scanGeneration = null) {
        if (!Object.prototype.hasOwnProperty.call(this.#activityCounts, type)) return;
        if (scanGeneration !== null && !this.isCurrent(scanGeneration)) return;

        this.#activityCounts[type] += 1;
        this.#onActivityChange?.(this.activity);
    }

    /**
     * Stops a named scan or analyzer activity for the current generation.
     *
     * @param {String} type - Activity type.
     * @param {Number|null} [scanGeneration=null] - Optional generation guard.
     */
    stopActivity(type, scanGeneration = null) {
        if (!Object.prototype.hasOwnProperty.call(this.#activityCounts, type)) return;
        if (scanGeneration !== null && !this.isCurrent(scanGeneration)) return;

        this.#activityCounts[type] = Math.max(0, this.#activityCounts[type] - 1);
        this.#onActivityChange?.(this.activity);
    }

    // Creates the immutable state passed to scan lifecycle callbacks.
    #createScanContext(scanGeneration, signal) {
        return Object.freeze({
            generation: scanGeneration,
            signal,
            isCurrent: () => this.isCurrent(scanGeneration)
        });
    }

    // Clears all visible scan and analyzer activities.
    #resetActivities() {
        Object.keys(this.#activityCounts).forEach((type) => {
            this.#activityCounts[type] = 0;
        });
        this.#onActivityChange?.(this.activity);
    }

    // Notifies the caller about scan lifecycle changes.
    #setScanRunning(state) {
        this.#onScanRunningChange?.(state);
    }
}
