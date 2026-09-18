import { Section, ChoreHistory } from './types.js';
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

    // Integer rather than merely numeric: completedBy is a user id, and a 3.5
    // or a stray word is a misconfiguration that would quietly count nothing
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

export function formatDonetickSection(count: number): Section {
    return {
        name: DONETICK_SECTION,
        items: [{ status: 'note', text: `${count} completed`, children: [] }],
    };
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
