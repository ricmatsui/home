import { Section, TodoItem, DueCounts } from './types.js';
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
// carrying. The completed count joins it when the day is closed.
export function formatDueCountsSection(name: string, counts: DueCounts): Section {
    return {
        name,
        items: [
            { status: 'note', text: `${counts.overdue} overdue`, children: [] },
            { status: 'note', text: `${counts.dueToday} due today`, children: [] },
        ],
    };
}

// Written in the counts' place rather than left out, so a day that opened
// without them says why instead of reading as a day with nothing due
export function formatDueCountsUnavailable(name: string, error: unknown): Section {
    return {
        name,
        items: [{
            status: 'note',
            text: `Due counts unavailable: ${describeError(error)}`,
            children: [],
        }],
    };
}

const COMPLETED_PATTERN = /^\d+ completed$/;
const COMPLETED_UNAVAILABLE_PREFIX = 'Completed count unavailable: ';

// What the day was opened with: whatever an earlier close left behind is
// dropped, so closing the same day twice replaces that line rather than
// stacking a second one under it
function openedItems(section: Section | undefined): TodoItem[] {
    return (section?.items ?? []).filter(item =>
        !COMPLETED_PATTERN.test(item.text) && !item.text.startsWith(COMPLETED_UNAVAILABLE_PREFIX));
}

/*
 * The other half of the day: recorded onto the section already in the file
 * rather than over it, so the counts the day was opened with survive alongside
 * what came of them. Closing the same day twice replaces the completed count
 * instead of leaving a second one behind.
 */
export function withSectionCompletedCount(name: string, section: Section | undefined, count: number): Section {
    const opened = openedItems(section);

    return {
        name,
        items: [...opened, { status: 'note', text: `${count} completed`, children: [] }],
    };
}

/*
 * The same half of the day, when the completions could not be read. The due
 * counts the day opened with are kept — and so is a note saying they were
 * never read, which is a different fact about the day than this one.
 */
export function withSectionCompletedUnavailable(name: string, section: Section | undefined, error: unknown): Section {
    const opened = openedItems(section);

    return {
        name,
        items: [...opened, {
            status: 'note',
            text: `${COMPLETED_UNAVAILABLE_PREFIX}${describeError(error)}`,
            children: [],
        }],
    };
}
