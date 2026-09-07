export default class Progressbar {
    #bar = null;
    #backgroundColor = '#32CD32';
    #lastPercent = null;

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
