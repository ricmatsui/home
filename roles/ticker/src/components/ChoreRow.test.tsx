import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ChoreRow } from './ChoreRow';
import type { Chore } from '../types';

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

function renderRow(overrides: Partial<Chore> = {}) {
    return render(
        <ul>
            <ChoreRow chore={chore(overrides)} status="idle" now={NOW} onComplete={() => {}} />
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
});
