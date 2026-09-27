type PublicFilterButtonProps = {
    publicOnly: boolean;
    onToggle: () => void;
};

/*
 * A globe for "public": the stock meaning of the glyph, and one drawn to the
 * same stroke as the row icons so the header does not read as borrowed from
 * a different icon set.
 */
function GlobeIcon() {
    return (
        <svg
            className="control__icon"
            data-icon="globe"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square">
                <circle cx="12" cy="12" r="8.5" />
                <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
                <path d="M3.5 12 H20.5" />
            </g>
        </svg>
    );
}

/*
 * The glyph does not change with the state. One that flips between two
 * pictures leaves the reader to work out which is the current state and which
 * is the offer; a fixed glyph whose button fills in when it is on has only one
 * thing to read. aria-pressed says the same thing to a screen reader, which
 * cannot see it fill.
 */
export function PublicFilterButton({ publicOnly, onToggle }: PublicFilterButtonProps) {
    return (
        <button
            type="button"
            className="control"
            aria-pressed={publicOnly}
            aria-label="Show only public tasks"
            title="Show only public tasks"
            onClick={onToggle}
        >
            <GlobeIcon />
        </button>
    );
}
