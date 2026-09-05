import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ChoreRow } from './ChoreRow';
import type { Chore, RowStatus, User } from '../types';

/*
 * TZ is pinned to America/Los_Angeles by the test script, matching the
 * container. The tomorrow badge turns on a local calendar date, so its
 * fixtures are built from local parts rather than UTC ones.
 */
function local(year: number, month: number, day: number, hour = 0): Date {
    return new Date(year, month - 1, day, hour);
}

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 1,
        name: 'Trash',
        nextDueDate: local(2026, 8, 10, 12).toISOString(),
        isActive: true,
        priority: 0,
        isPrivate: false,
        description: '',
        ...overrides,
    };
}

const NOW = local(2026, 8, 15, 5);

const JANE: User = { name: 'Jane', id: 1 };
const JOHN: User = { name: 'John', id: 2 };

type RowOptions = {
    status?: RowStatus;
    users?: User[];
    asksWhoDidIt?: boolean;
    completedBy?: User;
    onBeginComplete?: (id: number) => void;
    onCancelComplete?: (id: number) => void;
    onComplete?: (id: number, user?: User) => void;
};

function renderRow(overrides: Partial<Chore> = {}, options: RowOptions = {}) {
    const {
        status = 'idle',
        users = [],
        asksWhoDidIt = false,
        completedBy,
        onBeginComplete = () => {},
        onCancelComplete = () => {},
        onComplete = () => {},
    } = options;

    return render(
        <ul>
            <ChoreRow
                chore={chore(overrides)}
                status={status}
                users={users}
                asksWhoDidIt={asksWhoDidIt}
                completedBy={completedBy}
                now={NOW}
                onBeginComplete={onBeginComplete}
                onCancelComplete={onCancelComplete}
                onComplete={onComplete}
            />
        </ul>,
    );
}

describe('ChoreRow', () => {
    it('marks a chore due tomorrow', () => {
        renderRow({ nextDueDate: local(2026, 8, 16, 17).toISOString() });
        expect(screen.getByText('Tomorrow')).toBeInTheDocument();
    });

    it('does not mark a chore due later today', () => {
        renderRow({ nextDueDate: local(2026, 8, 15, 22).toISOString() });
        expect(screen.queryByText('Tomorrow')).not.toBeInTheDocument();
    });

    it('does not mark an overdue chore', () => {
        renderRow({ nextDueDate: local(2026, 8, 14, 12).toISOString() });
        expect(screen.queryByText('Tomorrow')).not.toBeInTheDocument();
    });

    /*
     * The badge sits inside the due line rather than beside it, which is what
     * hands it the row-state tint: the pending/done/error rules colour
     * .row__due, and the badge is drawn in currentColor.
     */
    it('puts the badge inside the due line, ahead of the relative time', () => {
        renderRow({ nextDueDate: local(2026, 8, 16, 17).toISOString() });

        const badge = screen.getByText('Tomorrow');
        expect(badge.parentElement).toHaveClass('row__due');
        expect(badge.parentElement).toHaveTextContent(/^Tomorrow in \d+ hours$/);
    });

    describe('crediting a person', () => {
        it('asks who did it instead of completing, when it is told to', async () => {
            const onBeginComplete = vi.fn();
            const onComplete = vi.fn();
            renderRow(
                {},
                { users: [JANE, JOHN], asksWhoDidIt: true, onBeginComplete, onComplete },
            );

            await userEvent.click(screen.getByRole('button', { name: 'Mark Trash done' }));

            expect(onBeginComplete).toHaveBeenCalledWith(1);
            expect(onComplete).not.toHaveBeenCalled();
        });

        it('offers a button for each person, named after the chore', () => {
            renderRow({}, { status: 'picking', users: [JANE, JOHN] });

            expect(
                screen.getByRole('button', { name: 'Mark Trash done as Jane' }),
            ).toBeInTheDocument();
            expect(
                screen.getByRole('button', { name: 'Mark Trash done as John' }),
            ).toBeInTheDocument();
        });

        it('keeps the people in the order they were configured', () => {
            const { container } = renderRow({}, { status: 'picking', users: [JANE, JOHN] });

            expect(
                [...container.querySelectorAll('.row__person')].map((button) => button.textContent),
            ).toEqual(['Jane', 'John']);
        });

        /*
         * The whole point of the cancel button, and the reason it is last: it
         * occupies the same 3rem square the Done button just did, so a second
         * tap at the position of the first backs out instead of landing on
         * whichever person's button happens to have opened underneath it.
         */
        it('ends the picker with the cancel button, where Done was', () => {
            const { container } = renderRow({}, { status: 'picking', users: [JANE, JOHN] });

            const picker = container.querySelector('.row__picker');
            const buttons = [...picker!.querySelectorAll('button')];

            expect(buttons.at(-1)).toHaveClass('row__cancel');
            expect(buttons.at(-1)).toHaveAccessibleName('Cancel marking Trash done');
        });

        it('backs out of the choice when cancel is tapped', async () => {
            const onCancelComplete = vi.fn();
            const onComplete = vi.fn();
            renderRow({}, { status: 'picking', users: [JANE, JOHN], onCancelComplete, onComplete });

            await userEvent.click(
                screen.getByRole('button', { name: 'Cancel marking Trash done' }),
            );

            expect(onCancelComplete).toHaveBeenCalledWith(1);
            expect(onComplete).not.toHaveBeenCalled();
        });

        /*
         * The height of an ordinary row comes from its name and due line,
         * which are taller than the 3rem Done button beside them. Take them
         * out of the layout to make room for the picker and the row loses
         * those few pixels — every row below it hops up while a thumb is on
         * its way to the second tap. So the text stays exactly where it was
         * and merely stops being visible.
         */
        it('keeps its text in the layout, hidden, so the row does not resize', () => {
            const { container } = renderRow({}, { status: 'picking', users: [JANE, JOHN] });

            const text = container.querySelector('.row__text');
            expect(text).toBeInTheDocument();
            expect(text).toHaveAttribute('aria-hidden', 'true');
        });

        it('completes as the person tapped', async () => {
            const onComplete = vi.fn();
            renderRow({}, { status: 'picking', users: [JANE, JOHN], onComplete });

            await userEvent.click(screen.getByRole('button', { name: 'Mark Trash done as John' }));

            expect(onComplete).toHaveBeenCalledWith(1, JOHN);
        });

        /*
         * Whether to ask is not the row's decision — it depends on the roster
         * and on the public filter, neither of which the row can see. Told not
         * to ask, it completes on the first tap and the completion goes out
         * unattributed, exactly as it did before any of this existed.
         */
        it('completes on the first tap when it is told not to ask', async () => {
            const onBeginComplete = vi.fn();
            const onComplete = vi.fn();
            renderRow(
                {},
                { users: [JANE, JOHN], asksWhoDidIt: false, onBeginComplete, onComplete },
            );

            await userEvent.click(screen.getByRole('button', { name: 'Mark Trash done' }));

            expect(onComplete).toHaveBeenCalledWith(1);
            expect(onBeginComplete).not.toHaveBeenCalled();
        });

        // There is no undo, so the finished row is the only confirmation that
        // the tap credited the person it was meant to.
        it('says who a finished row was credited to', () => {
            renderRow({}, { status: 'done', users: [JANE, JOHN], completedBy: JOHN });

            expect(screen.getByText('Done · John')).toBeInTheDocument();
        });

        it('leaves the due line alone on a row completed by nobody in particular', () => {
            renderRow({}, { status: 'done', users: [] });

            expect(screen.queryByText(/^Done ·/)).not.toBeInTheDocument();
        });
    });
});
