import { DueCounts } from './types.js';
import { describeError } from './errors.js';

// The day a completion or a due date belongs to is the one it reads as on the
// wall, so the instant is compared in local time rather than against a UTC day
// boundary.
export function isSameLocalDay(instant: Date, day: Date): boolean {
    return instant.getFullYear() === day.getFullYear()
        && instant.getMonth() === day.getMonth()
        && instant.getDate() === day.getDate();
}

// Written when the day is opened, a midnight snapshot of what it starts out
// carrying. The completed count joins the end of the line when the day is closed.
export function formatDueCountsLine(label: string, counts: DueCounts): string {
    return `${label}: ${counts.overdue} overdue, ${counts.dueToday} due`;
}

// Written in the counts' place rather than left out, so a day that opened
// without them says why instead of reading as a day with nothing due
export function formatDueCountsUnavailable(label: string, error: unknown): string {
    return `${label}: due counts unavailable: ${describeError(error)}`;
}

// Whatever an earlier close appended, so closing the same day twice replaces it
// rather than stacking a second one after it
const CLOSING_PATTERN = /(?:^|, )(?:\d+ completed|completed count unavailable: .*)$/;

// What the day was opened with, from the source's line in the Status section
function openedPart(label: string, line: string | undefined): string {
    const prefix = `${label}: `;
    if (!line?.startsWith(prefix)) return '';
    return line.slice(prefix.length).replace(CLOSING_PATTERN, '');
}

function withClosing(label: string, line: string | undefined, closing: string): string {
    const opened = openedPart(label, line);
    return `${label}: ${opened ? `${opened}, ` : ''}${closing}`;
}

/*
 * The other half of the day: appended to the line already in the file rather
 * than written over it, so the counts the day was opened with survive alongside
 * what came of them.
 */
export function withCompletedCount(label: string, line: string | undefined, count: number): string {
    return withClosing(label, line, `${count} completed`);
}

/*
 * The same half of the day, when the completions could not be read. The due
 * counts the day opened with are kept — and so is a note saying they were
 * never read, which is a different fact about the day than this one.
 */
export function withCompletedUnavailable(label: string, line: string | undefined, error: unknown): string {
    return withClosing(label, line, `completed count unavailable: ${describeError(error)}`);
}
