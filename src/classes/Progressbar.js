export default class Progressbar {
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
    }

    constructor(element) {
        this.bar = element;
        this.value = 0;
        this.max = 0;
    }

    show(max = 0) {
        this.max = max;
        this.reset();
        this.bar.style.display = 'block';
    }

    hide() {
        this.bar.style.display = 'none';
    }

    reset() {
        this.value = 0;
        this.#render();
    }

    update(step = 1) {
        this.value += step;
        if (this.value > this.max) this.value = this.max;
        this.#render();
    }

    #render() {
        const percent = this.max > 0 ? Math.round(this.value / this.max * 100) : 0;
        this.bar.style.width = `${percent}%`;
        this.bar.textContent = `${percent}%`;
    }
}