import { Section, Chore, ChoreHistory, DueCounts } from './types.js';
import { requireEnv } from './env.js';

export const DONETICK_SECTION = 'Donetick';

const BASE_PATH = '/api/v1';
const REQUEST_TIMEOUT_MS = 15_000;

// Donetick's history route filters on updated_at over whole days counted back
// from now, so the window has to reach well past midnight to cover the whole of
// the day being closed. The rows are filtered by performed_at here anyway.
const HISTORY_DAYS = 3;

// model.ChoreHistoryStatus: a skip and a rejection are also history rows
const STATUS_COMPLETED = 1;

const DONETICK = {
    get url() { return requireEnv('DONETICK_URL'); },
    get apiKey() { return requireEnv('DONETICK_API_KEY'); },

    // Integer rather than merely numeric: completedBy and assignedTo are user
    // ids, and a 3.5 or a stray word is a misconfiguration that would quietly
    // count nothing
    get userId() {
        const raw = requireEnv('DONETICK_USER_ID');
        const id = Number(raw);
        if (!Number.isInteger(id)) {
            throw new Error(`DONETICK_USER_ID is not a user id: ${raw}`);
        }
        return id;
    },
};

// The day a completion belongs to is the one it reads as on the wall, so the
// instant is compared in local time rather than against a UTC day boundary.
function isSameLocalDay(instant: Date, day: Date): boolean {
    return instant.getFullYear() === day.getFullYear()
        && instant.getMonth() === day.getMonth()
        && instant.getDate() === day.getDate();
}

/*
 * Credited to DONETICK_USER_ID rather than to whoever the API key belongs to.
 * The ticker completes a chore with `completedBy` set to the person who tapped
 * it, so the key owner is almost never the one a completion is credited to —
 * which is why the filter is applied here instead of through Donetick's own
 * `members=false`, whose only choice of person is the key owner.
 */
export function countCompletedOn(history: ChoreHistory[], day: Date): number {
    const userId = DONETICK.userId;

    return history.filter(entry => {
        if (entry.completedBy !== userId) return false;
        if (entry.status !== STATUS_COMPLETED || !entry.performedAt) return false;

        const performed = new Date(entry.performedAt);
        return !Number.isNaN(performed.getTime()) && isSameLocalDay(performed, day);
    }).length;
}

function startOfLocalDay(day: Date): Date {
    return new Date(day.getFullYear(), day.getMonth(), day.getDate());
}

/*
 * Narrowed the same way a completion is: what the day carries is what is
 * assigned to DONETICK_USER_ID, plus what nobody has been given yet. The chore
 * list answers with the whole circle and offers no member filter, so the
 * narrowing happens here rather than in the request.
 *
 * Due dates come back as instants, so they are bucketed against the wall clock
 * the day file is written for rather than a UTC day boundary. A chore due later
 * than the day counts as neither.
 */
export function countDueOn(chores: Chore[], day: Date): DueCounts {
    const userId = DONETICK.userId;
    const dayStart = startOfLocalDay(day);

    const counts = { overdue: 0, dueToday: 0 };

    for (const chore of chores) {
        if (!chore.isActive) continue;
        if (chore.assignedTo != null && chore.assignedTo !== userId) continue;
        if (!chore.nextDueDate) continue;

        const due = new Date(chore.nextDueDate);
        if (Number.isNaN(due.getTime())) continue;

        if (isSameLocalDay(due, day)) {
            counts.dueToday++;
        } else if (due < dayStart) {
            counts.overdue++;
        }
    }

    return counts;
}

// Written when the day is opened, a midnight snapshot of what it starts out
// carrying. The completed count joins it when the day is closed.
export function formatDonetickSection(counts: DueCounts): Section {
    return {
        name: DONETICK_SECTION,
        items: [
            { status: 'note', text: `${counts.overdue} overdue`, children: [] },
            { status: 'note', text: `${counts.dueToday} due today`, children: [] },
        ],
    };
}

const COMPLETED_PATTERN = /^\d+ completed$/;

/*
 * The other half of the day: recorded onto the section already in the file
 * rather than over it, so the counts the day was opened with survive alongside
 * what came of them. Closing the same day twice replaces the completed count
 * instead of leaving a second one behind.
 */
export function withCompletedCount(section: Section | undefined, count: number): Section {
    const opened = (section?.items ?? []).filter(item => !COMPLETED_PATTERN.test(item.text));

    return {
        name: DONETICK_SECTION,
        items: [...opened, { status: 'note', text: `${count} completed`, children: [] }],
    };
}

/*
 * The whole circle's chores, with archived ones left out by default. The list
 * route offers no member filter, so narrowing to one person is countDueOn's
 * job. The trailing slash is the route as Donetick registers it; without it the
 * request is answered with a redirect.
 */
export async function fetchChores(): Promise<Chore[]> {
    const url = new URL(`${BASE_PATH}/chores/`, DONETICK.url);

    const response = await fetch(url, {
        headers: { secretkey: DONETICK.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Chore list request failed (${response.status})`);
    }

    const body = await response.json() as { res?: Chore[] | null };

    return body.res ?? [];
}

/*
 * The whole circle's history: `members=true` is what makes rows credited to
 * someone other than the API key's own user visible at all. Narrowing to one
 * person is `countCompletedOn`'s job.
 */
export async function fetchChoreHistory(): Promise<ChoreHistory[]> {
    const url = new URL(`${BASE_PATH}/chores/history`, DONETICK.url);
    url.search = new URLSearchParams({
        limit: String(HISTORY_DAYS),
        members: 'true',
    }).toString();

    const response = await fetch(url, {
        headers: { secretkey: DONETICK.apiKey },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        throw new Error(`Chore history request failed (${response.status})`);
    }

    const body = await response.json() as { res?: ChoreHistory[] | null };

    // Donetick answers an empty history with a null res rather than []
    return body.res ?? [];
}
