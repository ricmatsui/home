import { useMemo } from 'react';
import { formatDue, isDueTomorrow } from '../lib/chores';
import { sanitizeDescription } from '../lib/description';
import type { Chore, RowStatus, User } from '../types';

type ChoreRowProps = {
    chore: Chore;
    status: RowStatus;
    // Who a completion can be credited to, once the row is open for a choice.
    users: User[];
    // Whether tapping Done opens that choice at all. Not the row's decision:
    // it turns on the roster and on the public filter, and the row can see
    // neither. False means one tap, sent unattributed.
    asksWhoDidIt: boolean;
    completedBy?: User;
    error?: string;
    now: Date;
    onBeginComplete: (id: number) => void;
    onCancelComplete: (id: number) => void;
    onComplete: (id: number, user?: User) => void;
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

/*
 * Drawn for the same reason the tick is, and to the same measurements: it
 * sits in a button the exact size and place of the Done button, so the two
 * glyphs have to be the same weight or the swap reads as a size change.
 */
function CloseIcon() {
    return (
        <svg
            className="row__icon"
            data-icon="close"
            viewBox="0 0 24 24"
            aria-hidden="true"
            focusable="false"
        >
            <g fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="square">
                <path d="M6 6 L18 18" />
                <path d="M18 6 L6 18" />
            </g>
        </svg>
    );
}

export function ChoreRow({
    chore,
    status,
    users,
    asksWhoDidIt,
    completedBy,
    error,
    now,
    onBeginComplete,
    onCancelComplete,
    onComplete,
}: ChoreRowProps) {
    const done = status === 'done';
    const pending = status === 'pending';
    const picking = status === 'picking';

    const description = useMemo(
        () => sanitizeDescription(chore.description),
        [chore.description],
    );

    return (
        <li className="row" data-status={status} data-priority={chore.priority}>
            {/*
              * The text stays in the grid while the picker is open and merely
              * stops being visible. It is what gives an ordinary row its
              * height — the name and due line together stand taller than the
              * 3rem button beside them — so removing it would shrink the row
              * by those few pixels and hop the whole list up while a thumb is
              * on its way to the second tap.
              */}
            <div className="row__text" aria-hidden={picking || undefined}>
                <span className="row__name">{chore.name}</span>
                <span className="row__due">
                    {done && completedBy ? (
                        // The due time is spent once the chore is done; who it
                        // was credited to is the fact worth having in its place,
                        // and there is no undo to correct a wrong one.
                        `Done · ${completedBy.name}`
                    ) : chore.nextDueDate ? (
                        <>
                            {isDueTomorrow(chore.nextDueDate, now) ? (
                                <>
                                    <span className="row__badge">Tomorrow</span>{' '}
                                </>
                            ) : null}
                            {formatDue(chore.nextDueDate, now)}
                        </>
                    ) : null}
                </span>
                {error ? <span className="row__error">{error}</span> : null}
            </div>
            {/*
              * Laid over the whole first grid line — the text column as well
              * as the button's. The people spread across the text column;
              * cancel keeps the button column, standing where Done stood. Two
              * people crammed into the 3rem the Done button occupies would be
              * a pair of targets too small to hit at arm's length, which is
              * the only distance this board is read from.
              */}
            {picking ? (
                <div className="row__picker">
                    {users.map((user) => (
                        <button
                            key={user.id}
                            type="button"
                            className="row__person"
                            // The visible label is the bare name — the chore's
                            // own name is hidden while the picker is open, so
                            // a screen reader needs it said here.
                            aria-label={`Mark ${chore.name} done as ${user.name}`}
                            onClick={() => onComplete(chore.id, user)}
                        >
                            {user.name}
                        </button>
                    ))}
                    {/*
                      * Last, and sized to land exactly on the Done button it
                      * replaced: the picker spans the whole grid line, so a
                      * 3rem square at its end sits in the same place as the
                      * 3rem square in the action column. A second tap where
                      * the first one landed backs out rather than crediting
                      * whoever's name opened under the thumb.
                      */}
                    <button
                        type="button"
                        className="row__cancel"
                        aria-label={`Cancel marking ${chore.name} done`}
                        onClick={() => onCancelComplete(chore.id)}
                    >
                        <CloseIcon />
                    </button>
                </div>
            ) : (
                /*
                 * The button carries no text, so the chore name has to live in
                 * the accessible name — otherwise every row offers an
                 * identically-labelled "Done".
                 */
                <button
                    type="button"
                    className="row__action"
                    aria-label={`Mark ${chore.name} done`}
                    aria-pressed={done}
                    // The glyph change is invisible to a screen reader, so the
                    // in-flight state has to be stated rather than drawn.
                    aria-busy={pending}
                    disabled={pending || done}
                    onClick={() =>
                        asksWhoDidIt ? onBeginComplete(chore.id) : onComplete(chore.id)
                    }
                >
                    {pending ? <HourglassIcon /> : <CheckIcon />}
                </button>
            )}
            {description ? (
                <div
                    className="row__description"
                    dangerouslySetInnerHTML={{ __html: description }}
                />
            ) : null}
        </li>
    );
}
