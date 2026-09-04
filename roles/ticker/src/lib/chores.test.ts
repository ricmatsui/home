import { describe, expect, it } from 'vitest';
import {
    dueChores,
    filterDue,
    filterPublic,
    formatDue,
    isDueTomorrow,
    sortChores,
} from './chores';
import type { Chore } from '../types';

const NOW = new Date('2026-08-15T12:00:00Z');

/*
 * The test script pins TZ to America/Los_Angeles — the same zone the container
 * runs in — so a local wall time is a fixed instant here. isDueTomorrow is
 * about local calendar dates rather than UTC ones, so building its fixtures
 * from local parts is what makes these cases readable.
 */
function local(year: number, month: number, day: number, hour = 0): Date {
    return new Date(year, month - 1, day, hour);
}

function localIso(year: number, month: number, day: number, hour = 0): string {
    return local(year, month, day, hour).toISOString();
}

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 1,
        name: 'Trash',
        nextDueDate: '2026-08-10T12:00:00Z',
        isActive: true,
        priority: 0,
        isPrivate: false,
        description: '',
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

    /*
     * Donetick refuses a completion made before nextDueDate minus
     * completionWindow hours, so a chore inside the 24-hour window can still
     * be untappable. Showing it offers a Done button that only returns an
     * error.
     */
    it('excludes a chore whose completion window has not opened yet', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-16T06:00:00Z', completionWindow: 6 }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('keeps a chore whose completion window has already opened', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-16T06:00:00Z', completionWindow: 24 }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    // Donetick rejects only a completion strictly before the window opens, so
    // the instant it opens the chore is completable.
    it('keeps a chore at the exact instant its completion window opens', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-16T06:00:00Z', completionWindow: 18 }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    // 0 is falsy but meaningful: completable from the due time onward, never
    // before. A truthiness guard would read it as "no window" and let the
    // not-yet-due case through.
    it('excludes a not-yet-due chore whose completion window is zero', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-15T18:00:00Z', completionWindow: 0 }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(0);
    });

    it('keeps an overdue chore whose completion window is zero', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-14T12:00:00Z', completionWindow: 0 }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    // Donetick omits the field entirely on most chores and sends null on some.
    it('keeps a chore with no completion window', () => {
        const chores = [chore({ nextDueDate: '2026-08-16T06:00:00Z' })];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    it('treats a null completion window as no window', () => {
        const chores = [
            chore({ nextDueDate: '2026-08-16T06:00:00Z', completionWindow: null }),
        ];
        expect(filterDue(chores, NOW)).toHaveLength(1);
    });

    it('excludes a chore with a completion window but no due date', () => {
        const chores = [chore({ nextDueDate: null, completionWindow: 6 })];
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

describe('isDueTomorrow', () => {
    const now = local(2026, 8, 15, 5);

    it('is true for a chore due tomorrow', () => {
        expect(isDueTomorrow(localIso(2026, 8, 16, 17), now)).toBe(true);
    });

    it('is true for a chore due just after midnight tomorrow', () => {
        expect(isDueTomorrow(localIso(2026, 8, 16, 0), now)).toBe(true);
    });

    it('is false for a chore due later today', () => {
        expect(isDueTomorrow(localIso(2026, 8, 15, 22), now)).toBe(false);
    });

    it('is false for a chore that is already overdue', () => {
        expect(isDueTomorrow(localIso(2026, 8, 14, 12), now)).toBe(false);
    });

    it('is false for a chore due the day after tomorrow', () => {
        expect(isDueTomorrow(localIso(2026, 8, 17, 12), now)).toBe(false);
    });

    /*
     * The trap this function exists for. 2026-08-15 22:00 local is
     * 2026-08-16 in UTC, so anything comparing UTC calendar dates calls a
     * chore due tonight "tomorrow".
     */
    it('is false for tonight even though the due date is tomorrow in UTC', () => {
        const tonight = '2026-08-16T05:00:00Z';
        expect(new Date(tonight).getUTCDate()).toBe(16);
        expect(isDueTomorrow(tonight, now)).toBe(false);
    });

    it('crosses a month boundary', () => {
        expect(isDueTomorrow(localIso(2026, 9, 1, 12), local(2026, 8, 31, 5))).toBe(true);
    });

    it('crosses a year boundary', () => {
        expect(isDueTomorrow(localIso(2027, 1, 1, 12), local(2026, 12, 31, 5))).toBe(true);
    });

    /*
     * 2026-03-08 is 23 hours long in this zone. Adding 24 hours to 23:00 the
     * night before overshoots into the 9th, so "tomorrow" has to be found by
     * incrementing the calendar day rather than by adding a day of milliseconds.
     */
    it('is true across the short spring-forward day', () => {
        expect(isDueTomorrow(localIso(2026, 3, 8, 12), local(2026, 3, 7, 23))).toBe(true);
    });

    // 2026-11-01 is 25 hours long, the mirror of the case above.
    it('is true across the long autumn day', () => {
        expect(isDueTomorrow(localIso(2026, 11, 1, 23), local(2026, 10, 31, 1))).toBe(true);
    });

    it('is false for an unparseable due date', () => {
        expect(isDueTomorrow('not-a-date', now)).toBe(false);
    });
});
