// ✴️ NEW 2026-10-13: Prepares received media in parallel while retaining batch commit order.
/**
 * Prepares discovered media batches with a bounded worker cluster and commits them in order.
 */
export default class MediaPipeline {
    #prepareCandidate = null;
    #commitBatch = null;
    #onError = null;
    #preparationConcurrency = 1;
    #preparationQueue = [];
    #activePreparations = 0;
    #batches = [];
    #isCommitting = false;
    #cancelled = false;
    #idleResolvers = [];

    /**
     * @param {Object} handlers - Functions used for media preparation and ordered commits.
     * @param {Function} handlers.prepareCandidate - Prepares one raw media candidate.
     * @param {Function} handlers.commitBatch - Applies one fully prepared batch.
     * @param {Function|null} [handlers.onError=null] - Handles a failed batch.
     * @param {Number} [handlers.preparationConcurrency=1] - Maximum simultaneous preparations.
     */
    constructor({
        prepareCandidate,
        commitBatch,
        onError = null,
        preparationConcurrency = 1
    } = {}) {
        this.#prepareCandidate = typeof prepareCandidate === 'function'
            ? prepareCandidate
            : async (candidate) => candidate;
        this.#commitBatch = typeof commitBatch === 'function'
            ? commitBatch
            : async () => undefined;
        this.#onError = typeof onError === 'function' ? onError : null;
        this.#preparationConcurrency = Number.isInteger(preparationConcurrency) &&
            preparationConcurrency > 0
            ? preparationConcurrency
            : 1;
    }

    /**
     * Starts preparing a received media batch without changing its later commit order.
     * @param {Object} batch - Data needed to prepare and commit the batch.
     * @returns {Promise<unknown>} Resolves after the batch has been committed.
     */
    enqueue(batch) {
        if (this.#cancelled) return Promise.resolve();

        const rawCandidates = Array.isArray(batch?.rawCandidates)
            ? batch.rawCandidates
            : [];
        let resolveBatch = null;
        const completed = new Promise((resolve) => {resolveBatch = resolve;});
        const state = {
            batch,
            completed: resolveBatch,
            pendingPreparations: rawCandidates.length,
            preparedCandidates: new Array(rawCandidates.length),
            preparationStartedAt: null,
            ready: rawCandidates.length === 0
        };

        this.#batches.push(state);
        rawCandidates.forEach((candidate, idx) => {
            this.#preparationQueue.push({state, candidate, idx});
        });
        this.#runPreparations();
        if (state.ready) void this.#drainCommits();

        return completed;
    }

    /**
     * Stops scheduling queued preparations and releases pending completion waits.
     */
    cancel() {
        if (this.#cancelled) return;

        this.#cancelled = true;
        this.#preparationQueue.length = 0;
        this.#batches.splice(0).forEach((state) => state.completed());
        this.#resolveIdle();
    }

    /**
     * Resolves when every accepted batch has either committed or been cancelled.
     * @returns {Promise<void>}
     */
    waitForIdle() {
        if (this.#isIdle()) return Promise.resolve();

        return new Promise((resolve) => this.#idleResolvers.push(resolve));
    }

    #isIdle() {
        return this.#cancelled || (this.#batches.length === 0 &&
            this.#preparationQueue.length === 0 &&
            this.#activePreparations === 0 &&
            this.#isCommitting === false);
    }

    #runPreparations() {
        while (!this.#cancelled &&
            this.#activePreparations < this.#preparationConcurrency &&
            this.#preparationQueue.length > 0) {
            const task = this.#preparationQueue.shift();
            this.#activePreparations += 1;
            task.state.preparationStartedAt ??= performance.now();
            // ✴️ NEW 2026-10-13: Keeps transport diagnostics on the same wall-clock time base.
            task.state.batch.popupProcessingStartedAt ??= Date.now();
            task.state.batch.preparationStartedAt ??= task.state.preparationStartedAt;

            void this.#prepareCandidate(task.candidate, task.state.batch)
                .then((candidate) => {
                    task.state.preparedCandidates[task.idx] = candidate ?? null;
                })
                .catch((error) => this.#fail(error))
                .finally(() => {
                    this.#activePreparations -= 1;
                    task.state.pendingPreparations -= 1;
                    if (task.state.pendingPreparations === 0 && !this.#cancelled) {
                        task.state.batch.candidatePreparationMs = Math.max(
                            0,
                            performance.now() - task.state.preparationStartedAt
                        );
                        task.state.ready = true;
                        void this.#drainCommits();
                    }
                    this.#runPreparations();
                    this.#resolveIdle();
                });
        }
    }

    async #drainCommits() {
        if (this.#isCommitting || this.#cancelled) return;

        this.#isCommitting = true;
        try {
            while (!this.#cancelled && this.#batches[0]?.ready) {
                const state = this.#batches[0];
                await this.#commitBatch(
                    state.batch,
                    state.preparedCandidates
                );
                this.#batches.shift();
                state.completed();
            }
        } catch (error) {
            this.#fail(error);
        } finally {
            this.#isCommitting = false;
            if (!this.#cancelled && this.#batches[0]?.ready) {
                void this.#drainCommits();
            }
            this.#resolveIdle();
        }
    }

    #fail(error) {
        if (this.#cancelled) return;

        this.cancel();
        try {
            this.#onError?.(error);
        } catch (onError) {
            console.error('Cannot handle media pipeline error:', onError);
        }
    }

    #resolveIdle() {
        if (!this.#isIdle()) return;

        this.#idleResolvers.splice(0).forEach((resolve) => resolve());
    }
}
