type PublicFilterButtonProps = {
    publicOnly: boolean;
    onToggle: () => void;
};

/*
 * The label does not change with the state. A button that flips between
 * "Public" and "All" leaves the reader to work out which of the two words is
 * the current state and which is the offer; a fixed label that fills in when
 * it is on has only one thing to read. aria-pressed says the same thing to a
 * screen reader, which cannot see it fill.
 */
export function PublicFilterButton({ publicOnly, onToggle }: PublicFilterButtonProps) {
    return (
        <button
            type="button"
            className="control"
            aria-pressed={publicOnly}
            aria-label="Show only public tasks"
            onClick={onToggle}
        >
            Public
        </button>
    );
}
