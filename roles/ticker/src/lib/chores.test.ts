import { describe, expect, it } from 'vitest';
import { dueChores, filterDue, filterPublic, formatDue, sortChores } from './chores';
import type { Chore } from '../types';

const NOW = new Date('2026-08-15T12:00:00Z');

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 1,
        name: 'Trash',
        nextDueDate: '2026-08-10T12:00:00Z',
        isActive: true,
        priority: 0,
        isPrivate: false,
        ...overrides,
    };
}

describe('filterDue', () => {
    it('keeps a chore whose due date is in the past', () => {
        const chores = [chore({ nextDueDate: '2026-08-14T12:00:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    it('keeps a chore due later the same day', () => {
        const chores = [chore({ nextDueDate: '2026-08-15T18:00:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    it('keeps a chore due just inside the next 24 hours', () => {
        const chores = [chore({ nextDueDate: '2026-08-16T11:59:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    it('excludes a chore due just beyond the next 24 hours', () => {
        const chores = [chore({ nextDueDate: '2026-08-16T12:01:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('excludes a chore with no due date', () => {
        const chores = [chore({ nextDueDate: null })];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('excludes an inactive chore even when overdue', () => {
        const chores = [chore({ isActive: false })];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('excludes an inactive chore that is due soon', () => {
        const chores = [chore({ isActive: false, nextDueDate: '2026-08-15T18:00:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('excludes a chore with an unparseable due date', () => {
        const chores = [chore({ nextDueDate: 'not-a-date' })];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });
});

describe('sortChores', () => {
    it('orders higher priority first, with 1 as the highest', () => {
        const chores = [
            chore({ id: 1, priority: 3 }),
            chore({ id: 2, priority: 1 }),
            chore({ id: 3, priority: 2 }),
        ];
        expect(sortChores(chores).map((c) => c.id)).toEqual([2, 3, 1]);
    });

    it('sorts unset priority (0) last', () => {
        const chores = [
            chore({ id: 1, priority: 0 }),
            chore({ id: 2, priority: 4 }),
            chore({ id: 3, priority: 1 }),
        ];
        expect(sortChores(chores).map((c) => c.id)).toEqual([3, 2, 1]);
    });

    it('puts the most overdue first within the same priority', () => {
        const chores = [
            chore({ id: 1, priority: 2, nextDueDate: '2026-08-14T12:00:00Z' }),
            chore({ id: 2, priority: 2, nextDueDate: '2026-08-01T12:00:00Z' }),
        ];
        expect(sortChores(chores).map((c) => c.id)).toEqual([2, 1]);
    });

    // Due time is only the tie-break, so a not-yet-due chore sinks to the
    // bottom of its own priority band rather than to the bottom of the list.
    it('puts a not-yet-due chore last within the same priority', () => {
        const chores = [
            chore({ id: 1, priority: 2, nextDueDate: '2026-08-15T18:00:00Z' }),
            chore({ id: 2, priority: 2, nextDueDate: '2026-08-14T12:00:00Z' }),
        ];
        expect(sortChores(chores).map((c) => c.id)).toEqual([2, 1]);
    });

    it('does not mutate its input', () => {
        const chores = [chore({ id: 1, priority: 4 }), chore({ id: 2, priority: 1 })];
        sortChores(chores);
        expect(chores.map((c) => c.id)).toEqual([1, 2]);
    });
});

describe('formatDue', () => {
    it('formats hours for same-day lateness', () => {
        expect(formatDue('2026-08-15T09:00:00Z', NOW)).toBe('3 hours ago');
    });

    it('uses a singular unit for one', () => {
        expect(formatDue('2026-08-14T12:00:00Z', NOW)).toBe('1 day ago');
    });

    it('formats days', () => {
        expect(formatDue('2026-08-09T12:00:00Z', NOW)).toBe('6 days ago');
    });

    it('formats months once past 60 days', () => {
        expect(formatDue('2026-05-15T12:00:00Z', NOW)).toBe('3 months ago');
    });

    it('falls back to minutes under an hour', () => {
        expect(formatDue('2026-08-15T11:30:00Z', NOW)).toBe('30 minutes ago');
    });

    it('counts forward in hours for a chore not yet due', () => {
        expect(formatDue('2026-08-15T17:00:00Z', NOW)).toBe('in 5 hours');
    });

    it('counts forward in minutes under an hour', () => {
        expect(formatDue('2026-08-15T12:40:00Z', NOW)).toBe('in 40 minutes');
    });

    it('uses a singular unit counting forward', () => {
        expect(formatDue('2026-08-15T13:00:00Z', NOW)).toBe('in 1 hour');
    });

    // The window caps at 24 hours, so the furthest-out chore still reads in
    // hours rather than rounding to a bare "in 1 day".
    it('keeps hours at the edge of the window', () => {
        expect(formatDue('2026-08-16T11:00:00Z', NOW)).toBe('in 23 hours');
    });
});

describe('dueChores', () => {
    it('filters then sorts', () => {
        const chores = [
            chore({ id: 1, priority: 0, nextDueDate: '2026-08-14T12:00:00Z' }),
            chore({ id: 2, priority: 1, nextDueDate: '2026-08-14T12:00:00Z' }),
            chore({ id: 3, priority: 1, nextDueDate: '2026-08-20T12:00:00Z' }),
            chore({ id: 4, priority: 2, nextDueDate: '2026-08-15T18:00:00Z' }),
        ];
        expect(dueChores(chores, NOW).map((c) => c.id)).toEqual([2, 4, 1]);
    });
});

describe('filterPublic', () => {
    it('keeps a chore the whole circle can see', () => {
        expect(filterPublic([chore({ isPrivate: false })])).toHaveLength(1);
    });

    it('excludes a private chore', () => {
        expect(filterPublic([chore({ isPrivate: true })])).toHaveLength(0);
    });

    it('keeps the order it was given', () => {
        const chores = [
            chore({ id: 1, isPrivate: false }),
            chore({ id: 2, isPrivate: true }),
            chore({ id: 3, isPrivate: false }),
        ];
        expect(filterPublic(chores).map((kept) => kept.id)).toEqual([1, 3]);
    });
});
