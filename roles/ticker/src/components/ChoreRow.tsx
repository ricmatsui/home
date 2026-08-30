import { formatDue } from '../lib/chores';
import type { Chore, RowStatus } from '../types';

type ChoreRowProps = {
    chore: Chore;
    status: RowStatus;
    error?: string;
    now: Date;
    onComplete: (id: number) => void;
};

/*
 * Drawn rather than typed. A text glyph would inherit the body font's metrics
 * and sit off-centre in a square button; a stroked path centres exactly and
 * scales with the border weight around it.
 */
function CheckIcon() {
    return (
        <svg
            className="row__icon"
            data-icon="check"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <path
                d="M4.5 12.5 L9.5 17.5 L19.5 6.5"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="square"
            />
        </svg>
    );
}

/*
 * Deliberately not a spinner. The board has no other moving parts, and a
 * still glyph behaves the same whether or not the reader has asked for
 * reduced motion — the colour change is doing the work of saying "now".
 */
function HourglassIcon() {
    return (
        <svg
            className="row__icon"
            data-icon="hourglass"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <g fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="square">
                <path d="M6 3.5 H18" />
                <path d="M6 20.5 H18" />
                <path d="M7 3.5 V7 L12 12 L7 17 V20.5" />
                <path d="M17 3.5 V7 L12 12 L17 17 V20.5" />
            </g>
            {/* The sand, pooled in the lower bulb. */}
            <path d="M9 19 H15 L12 15.5 Z" fill="currentColor" />
        </svg>
    );
}

export function ChoreRow({ chore, status, error, now, onComplete }: ChoreRowProps) {
    const done = status === 'done';
    const pending = status === 'pending';

    return (
        <li className="row" data-status={status} data-priority={chore.priority}>
            <div className="row__text">
                <span className="row__name">{chore.name}</span>
                <span className="row__due">
                    {chore.nextDueDate ? formatDue(chore.nextDueDate, now) : ''}
                </span>
                {error ? <span className="row__error">{error}</span> : null}
            </div>
            {/*
              * The button carries no text, so the chore name has to live in
              * the accessible name — otherwise every row offers an
              * identically-labelled "Done".
              */}
            <button
                type="button"
                className="row__action"
                aria-label={`Mark ${chore.name} done`}
                aria-pressed={done}
                // The glyph change is invisible to a screen reader, so the
                // in-flight state has to be stated rather than drawn.
                aria-busy={pending}
                disabled={pending || done}
                onClick={() => onComplete(chore.id)}
            >
                {pending ? <HourglassIcon /> : <CheckIcon />}
            </button>
        </li>
    );
}
