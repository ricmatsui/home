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

export function filterDue(chores: Chore[], now: Date): Chore[] {
    const horizon = now.getTime() + WINDOW;
    return chores.filter((chore) => {
        if (!chore.isActive) {
            return false;
        }
        const due = dueTime(chore);
        return Number.isFinite(due) && due < horizon;
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

export function dueChores(chores: Chore[], now: Date): Chore[] {
    return sortChores(filterDue(chores, now));
}
