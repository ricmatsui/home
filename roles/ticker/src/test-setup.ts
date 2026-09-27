import '@testing-library/jest-dom/vitest';

/*
 * jsdom has HTMLDialogElement but not its modal methods. Enough of them to
 * open and close one: the open attribute, and the close event a real dialog
 * fires, which is what the app listens to.
 */
if (!HTMLDialogElement.prototype.showModal) {
    HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
        this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
        if (!this.hasAttribute('open')) {
            return;
        }
        this.removeAttribute('open');
        this.dispatchEvent(new Event('close'));
    };
}
