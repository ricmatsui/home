type SearchButtonProps = {
    onOpen: () => void;
};

/*
 * A magnifier, drawn to the same stroke as the globe and the refresh arrow
 * beside it.
 */
function SearchIcon() {
    return (
        <svg
            className="control__icon"
            data-icon="search"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square">
                <circle cx="10.5" cy="10.5" r="6.5" />
                <path d="M15.5 15.5 L20.5 20.5" />
            </g>
        </svg>
    );
}

export function SearchButton({ onOpen }: SearchButtonProps) {
    return (
        <button
            type="button"
            className="control"
            aria-label="Search tasks"
            title="Search tasks"
            aria-haspopup="dialog"
            onClick={onOpen}
        >
            <SearchIcon />
        </button>
    );
}
