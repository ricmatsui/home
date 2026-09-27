import type { Chore } from '../types';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const WINDOW = DAY;

function dueTime(chore: Chore): number {
    if (!chore.nextDueDate) {
        return Number.NaN;
    }
    return new Date(chore.nextDueDate).getTime();
}

/*
 * Donetick rejects a completion made before nextDueDate minus completionWindow
 * hours with a 400, so such a chore is on the board offering a Done button
 * that can only fail. Most chores have no window and are always completable.
 *
 * The comparison is >= because Donetick rejects only a completion strictly
 * before the window opens. Note completionWindow may be 0, which is a real
 * window — completable from the due time onward — so this tests for null
 * rather than for truthiness.
 */
export function isCompletable(chore: Chore, now: Date): boolean {
    if (chore.completionWindow == null) {
        return true;
    }
    return now.getTime() >= dueTime(chore) - chore.completionWindow * HOUR;
}

export function filterDue(chores: Chore[], now: Date): Chore[] {
    const horizon = now.getTime() + WINDOW;
    return chores.filter((chore) => {
        if (!chore.isActive) {
            return false;
        }
        const due = dueTime(chore);
        if (!Number.isFinite(due) || due >= horizon) {
            return false;
        }
        // Checked after the due date, so a chore with no parseable due date
        // is already gone and this never compares against NaN.
        return isCompletable(chore, now);
    });
}

export function filterPublic(chores: Chore[]): Chore[] {
    return chores.filter((chore) => !chore.isPrivate);
}

// Donetick uses 1 (highest) through 4 (lowest); 0 means no priority set,
// which belongs at the bottom of the list rather than the top.
function priorityRank(priority: number): number {
    return priority === 0 ? Number.MAX_SAFE_INTEGER : priority;
}

export function sortChores(chores: Chore[]): Chore[] {
    return [...chores].sort((a, b) => {
        const byPriority = priorityRank(a.priority) - priorityRank(b.priority);
        if (byPriority !== 0) {
            return byPriority;
        }
        return dueTime(a) - dueTime(b);
    });
}

function plural(count: number, unit: string): string {
    return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/*
 * The same units either side of the due time. The board alone never needed
 * more than hours counting forward — nothing on it is due further out than a
 * day — but search lists every chore, and a quarterly one would otherwise
 * read "in 2000 hours".
 */
function span(ms: number): string {
    if (ms < HOUR) {
        return plural(Math.max(1, Math.floor(ms / MINUTE)), 'minute');
    }
    if (ms < DAY) {
        return plural(Math.floor(ms / HOUR), 'hour');
    }
    if (ms < 60 * DAY) {
        return plural(Math.floor(ms / DAY), 'day');
    }
    return plural(Math.floor(ms / (30 * DAY)), 'month');
}

export function formatDue(nextDueDate: string, now: Date): string {
    const elapsed = now.getTime() - new Date(nextDueDate).getTime();
    return elapsed < 0 ? `in ${span(-elapsed)}` : `${span(elapsed)} ago`;
}

/*
 * When a chore's completion window opens, for a chore whose window is still
 * shut. The board never lists one of those; search does, and a disabled Done
 * button has to say when it stops being disabled.
 */
export function opensAt(chore: Chore): string | null {
    if (chore.completionWindow == null || !chore.nextDueDate) {
        return null;
    }
    return new Date(dueTime(chore) - chore.completionWindow * HOUR).toISOString();
}

/*
 * Everything on the board is overdue or due inside 24 hours, so "in 20 hours"
 * is the one reading a glance cannot resolve: whether it lands tonight or
 * tomorrow depends on the time of day, which is exactly what the reader does
 * not want to work out. Local calendar dates decide it, not elapsed time —
 * 11pm and 1am are four hours and one date apart.
 *
 * Stepping the day rather than adding 24 hours of milliseconds is load-bearing:
 * the days either side of a DST change are 23 and 25 hours long, and Date
 * normalises day 32 into the next month for free.
 */
export function isDueTomorrow(nextDueDate: string, now: Date): boolean {
    const due = new Date(nextDueDate);
    if (Number.isNaN(due.getTime())) {
        return false;
    }
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    return (
        due.getFullYear() === tomorrow.getFullYear() &&
        due.getMonth() === tomorrow.getMonth() &&
        due.getDate() === tomorrow.getDate()
    );
}

export function selectDue(chores: Chore[], now: Date): Chore[] {
    return sortChores(filterDue(chores, now));
}

/*
 * Every active chore whose name contains the query, due or not. Names that
 * start with it come first — typing the first few letters of a chore is how
 * it gets looked up — and each group runs soonest-due first, with undated
 * chores at the end. Case-insensitive; an empty query finds nothing rather
 * than everything, so the search opens blank.
 */
export function searchChores(chores: Chore[], query: string): Chore[] {
    const needle = query.trim().toLowerCase();
    if (!needle) {
        return [];
    }
    const starting: Chore[] = [];
    const containing: Chore[] = [];
    for (const chore of chores) {
        if (!chore.isActive) {
            continue;
        }
        const at = chore.name.toLowerCase().indexOf(needle);
        if (at === 0) {
            starting.push(chore);
        } else if (at > 0) {
            containing.push(chore);
        }
    }
    return [...sortByDue(starting), ...sortByDue(containing)];
}

function sortByDue(chores: Chore[]): Chore[] {
    const undatedLast = (chore: Chore) => {
        const due = dueTime(chore);
        return Number.isFinite(due) ? due : Number.MAX_SAFE_INTEGER;
    };
    return [...chores].sort((a, b) => undatedLast(a) - undatedLast(b));
}

/*
 * The due date a reschedule moves a chore to: `days` after whichever is later,
 * its due date or today, at the time of day it was already due. Counting from
 * an overdue date would leave "+1" on a chore three days late still two days
 * late — pushed back, and still on the board.
 *
 * Local calendar days, stepped rather than added as milliseconds, for the
 * same DST reason as isDueTomorrow: a 9am chore stays a 9am chore.
 */
export function postpone(nextDueDate: string, days: number, now: Date): string {
    const due = new Date(nextDueDate);
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const base =
        new Date(due.getFullYear(), due.getMonth(), due.getDate()) < today ? today : due;
    return new Date(
        base.getFullYear(),
        base.getMonth(),
        base.getDate() + days,
        due.getHours(),
        due.getMinutes(),
        due.getSeconds(),
        due.getMilliseconds(),
    ).toISOString();
}
