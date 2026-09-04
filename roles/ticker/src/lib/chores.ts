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

export function formatDue(nextDueDate: string, now: Date): string {
    const elapsed = now.getTime() - new Date(nextDueDate).getTime();

    // Not due yet. The window caps at a day, so this never needs a unit
    // larger than hours.
    if (elapsed < 0) {
        const remaining = -elapsed;
        if (remaining < HOUR) {
            return `in ${plural(Math.max(1, Math.floor(remaining / MINUTE)), 'minute')}`;
        }
        return `in ${plural(Math.floor(remaining / HOUR), 'hour')}`;
    }

    if (elapsed < HOUR) {
        return `${plural(Math.max(1, Math.floor(elapsed / MINUTE)), 'minute')} ago`;
    }
    if (elapsed < DAY) {
        return `${plural(Math.floor(elapsed / HOUR), 'hour')} ago`;
    }
    if (elapsed < 60 * DAY) {
        return `${plural(Math.floor(elapsed / DAY), 'day')} ago`;
    }
    return `${plural(Math.floor(elapsed / (30 * DAY)), 'month')} ago`;
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

export function dueChores(chores: Chore[], now: Date): Chore[] {
    return sortChores(filterDue(chores, now));
}
