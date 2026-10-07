/**
 * @file Progressbar.js
 * @module Progressbar
 * @version 0.1.12
 * @date 2026-10-05
 * @author Jens-Olaf-Mueller
 *
 * Progressbar - Controls the popup progress indicator.
 * ===============================================================
 *
 * Connects a progress-bar element to a compact public API for displaying,
 * hiding, resetting, and incrementing bounded progress. Its color is
 * CSS-variable-aware and its render cache avoids redundant DOM updates.
 * - Key Features:
 * - Theme-aware color:   Uses CSS variables with explicit fallback colors.
 * - Efficient rendering: Updates the DOM only when the visible percentage changes.
 * - Bounded progress:    Clamps values safely between zero and the configured maximum.
 * - DOM binding:         Accepts a progress-bar element or its element ID.
 *
 * ---------------------------------------------------------------
 * I. Public Methods
 * ---------------------------------------------------------------
 * - {@link show}     - Sets the maximum, resets, and displays the progress bar.
 * - {@link hide}     - Hides the progress bar.
 * - {@link reset}    - Resets the current progress value to zero.
 * - {@link update}   - Increments the current progress value by a step.
 * - {@link setValue} - Sets the current progress value within its allowed range.
 *
 * ---------------------------------------------------------------
 * II. Private Methods
 * ---------------------------------------------------------------
 * - {@link #renderBackgroundColor} - Applies the configured color to the bound element.
 * - {@link #render}                - Renders the percentage, width, and progress text.
 */
export default class Progressbar {
    #lastPercent = null;

    #bar = null;
    get bar() { return this.#bar; }
    set bar(newBar) {
        if (newBar instanceof HTMLDivElement) {
            this.#bar = newBar;
        } else if (typeof newBar === 'string') {
            this.#bar = document.getElementById(newBar);
        } else {
            this.#bar = null;
        }

        this.#renderBackgroundColor();
    }

    #backgroundColor = 'var(--adn-progressbar-bg-scan, #32CD32)';
    get backgroundColor() { return this.#backgroundColor; }
    set backgroundColor(value) {
        if (typeof value !== 'string' || !value.trim()) return;

        this.#backgroundColor = value;
        this.#renderBackgroundColor();
    }

    constructor(element) {
        this.bar = element;
        this.value = 0;
        this.max = 0;
    }

    show(max = 0) {
        this.max = Math.max(0, Number(max) || 0);
        this.reset();
        this.bar.style.display = 'block';
    }

    hide() {
        this.bar.style.display = 'none';
    }

    reset() {
        this.value = 0;
        this.#render(true);
    }

    update(step = 1) {
        this.setValue(this.value + step);
    }

    setValue(value) {
        this.value = Math.min(this.max, Math.max(0, Number(value) || 0));
        this.#render();
    }

    #renderBackgroundColor() {
        if (this.bar) this.bar.style.backgroundColor = this.#backgroundColor;
    }

    #render(force = false) {
        if (!this.bar) return;

        const percent = this.max > 0 ? Math.round(this.value / this.max * 100) : 0;
        if (!force && percent === this.#lastPercent) return;

        this.#lastPercent = percent;
        this.bar.style.width = `${percent}%`;
        this.bar.textContent = `${percent}%`;
    }
}