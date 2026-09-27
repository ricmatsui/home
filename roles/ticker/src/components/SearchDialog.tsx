import { useEffect, useRef, type ReactNode } from 'react';

type SearchDialogProps = {
    query: string;
    onQueryChange: (query: string) => void;
    onClose: () => void;
    // The results. Rendered by the caller, which already holds everything a
    // row needs; the dialog is only the frame and the input.
    children: ReactNode;
};

// Drawn to the row's close glyph, at the header's stroke.
function CloseIcon() {
    return (
        <svg
            className="control__icon"
            data-icon="close"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square">
                <path d="M6 6 L18 18" />
                <path d="M18 6 L6 18" />
            </g>
        </svg>
    );
}

/*
 * A native modal dialog, mounted only while open. showModal() brings the
 * focus trap, Escape, and the inert board underneath for nothing, and being
 * mounted per opening means the focus below runs every time it opens.
 */
export function SearchDialog({ query, onQueryChange, onClose, children }: SearchDialogProps) {
    const dialogRef = useRef<HTMLDialogElement>(null);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => {
        const dialog = dialogRef.current;
        // Guarded because StrictMode runs this twice, and older engines throw
        // on showModal() for a dialog that is already open.
        if (dialog && !dialog.open) {
            dialog.showModal();
        }
        // After showModal, which runs its own focusing steps and would take
        // focus from anything focused before it — React's autoFocus included.
        inputRef.current?.focus();
    }, []);

    return (
        <dialog
            ref={dialogRef}
            className="search"
            aria-label="Search tasks"
            // Escape closes the dialog natively; this hands that back to the
            // caller so the open state follows.
            onClose={onClose}
            // The dialog has no padding of its own, so a click whose target is
            // the dialog itself landed on the backdrop beside the panel.
            onClick={(event) => {
                if (event.target === event.currentTarget) {
                    onClose();
                }
            }}
        >
            <div className="search__panel">
                <div className="search__bar">
                    <input
                        ref={inputRef}
                        className="search__input"
                        type="search"
                        aria-label="Task name"
                        placeholder="Task name"
                        autoComplete="off"
                        autoCorrect="off"
                        spellCheck={false}
                        enterKeyHint="search"
                        value={query}
                        onChange={(event) => onQueryChange(event.target.value)}
                    />
                    <button
                        type="button"
                        className="control"
                        aria-label="Close search"
                        title="Close search"
                        onClick={onClose}
                    >
                        <CloseIcon />
                    </button>
                </div>
                <div className="search__results">{children}</div>
            </div>
        </dialog>
    );
}
