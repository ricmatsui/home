type RefreshButtonProps = {
    onRefresh: () => void;
    loading: boolean;
};

/*
 * A clockwise arrow closing on its own tail. Still while loading, for the
 * same reason the row's hourglass is: the board has no other moving parts,
 * and the disabled fade already says "not now".
 */
function RefreshIcon() {
    return (
        <svg
            className="control__icon"
            data-icon="refresh"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <path
                d="M19.5 12 A7.5 7.5 0 1 1 15.75 5.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.4"
                strokeLinecap="square"
            />
            <path d="M19.9 7.9 L17.25 2.9 L14.25 8.1 Z" fill="currentColor" />
        </svg>
    );
}

export function RefreshButton({ onRefresh, loading }: RefreshButtonProps) {
    return (
        <button
            type="button"
            className="control"
            aria-label="Refresh"
            title="Refresh"
            // The label no longer changes to "Refreshing…", so the in-flight
            // state has to be stated rather than implied by the fade.
            aria-busy={loading}
            onClick={onRefresh}
            disabled={loading}
        >
            <RefreshIcon />
        </button>
    );
}
