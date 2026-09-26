import { Section, GoogleTask, DueCounts } from './types.js';
import { requireEnv } from './env.js';
import {
    isSameLocalDay,
    formatDueCountsSection,
    formatDueCountsUnavailable,
    withSectionCompletedCount,
    withSectionCompletedUnavailable,
} from './dueCounts.js';

export const GOOGLE_TASKS_SECTION = 'Google Tasks';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API_URL = 'https://tasks.googleapis.com/tasks/v1';
const REQUEST_TIMEOUT_MS = 15_000;

// The most either route answers with in one page
const LISTS_PAGE_SIZE = 1000;
const TASKS_PAGE_SIZE = 100;

const GOOGLE = {
    get clientId() { return requireEnv('GOOGLE_TASKS_CLIENT_ID'); },
    get clientSecret() { return requireEnv('GOOGLE_TASKS_CLIENT_SECRET'); },
    get refreshToken() { return requireEnv('GOOGLE_TASKS_REFRESH_TOKEN'); },
};

const DUE_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})/;

/*
 * A due date is a calendar date sent as midnight UTC ("2026-09-26T00:00:00.000Z"):
 * Google discards the time when one is set. Read as an instant it lands on the
 * evening before anywhere west of Greenwich, so only its date is taken, as the
 * local day it names.
 */
function parseDueDate(due: string): Date | null {
    const match = DUE_DATE_PATTERN.exec(due);
    if (!match) return null;

    const [, year, month, day] = match.map(Number);
    return new Date(year, month - 1, day);
}

export function countDueOn(tasks: GoogleTask[], day: Date): DueCounts {
    const dayStart = new Date(day.getFullYear(), day.getMonth(), day.getDate());

    const counts = { overdue: 0, dueToday: 0 };

    for (const task of tasks) {
        if (task.status !== 'needsAction' || !task.due) continue;

        const due = parseDueDate(task.due);
        if (!due) continue;

        if (isSameLocalDay(due, day)) {
            counts.dueToday++;
        } else if (due < dayStart) {
            counts.overdue++;
        }
    }

    return counts;
}

// Unlike a due date, a completion is a real instant, so it is bucketed against
// the wall clock the same way a Donetick completion is
export function countCompletedOn(tasks: GoogleTask[], day: Date): number {
    return tasks.filter(task => {
        if (task.status !== 'completed' || !task.completed) return false;

        const completed = new Date(task.completed);
        return !Number.isNaN(completed.getTime()) && isSameLocalDay(completed, day);
    }).length;
}

export function formatGoogleTasksSection(counts: DueCounts): Section {
    return formatDueCountsSection(GOOGLE_TASKS_SECTION, counts);
}

export function formatGoogleTasksUnavailable(error: unknown): Section {
    return formatDueCountsUnavailable(GOOGLE_TASKS_SECTION, error);
}

export function withCompletedCount(section: Section | undefined, count: number): Section {
    return withSectionCompletedCount(GOOGLE_TASKS_SECTION, section, count);
}

export function withCompletedUnavailable(section: Section | undefined, error: unknown): Section {
    return withSectionCompletedUnavailable(GOOGLE_TASKS_SECTION, section, error);
}

/*
 * Google's error body names why a token was refused, and invalid_grant is the
 * one worth being able to read in the day file: the refresh token was revoked
 * or has expired, and the consent script has to be run again.
 */
async function fetchAccessToken(): Promise<string> {
    const response = await fetch(TOKEN_URL, {
        method: 'POST',
        body: new URLSearchParams({
            client_id: GOOGLE.clientId,
            client_secret: GOOGLE.clientSecret,
            refresh_token: GOOGLE.refreshToken,
            grant_type: 'refresh_token',
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
        const body = await response.json().catch(() => ({})) as { error?: string };
        throw new Error(`Token request failed (${response.status}${body.error ? ` ${body.error}` : ''})`);
    }

    const body = await response.json() as { access_token: string };
    return body.access_token;
}

// Both routes answer a page at a time, and an empty page leaves items out
// altogether rather than sending []
async function fetchAllPages<T>(
    path: string,
    params: Record<string, string>,
    token: string,
    label: string,
): Promise<T[]> {
    const items: T[] = [];
    let pageToken: string | undefined;

    do {
        const url = new URL(`${API_URL}${path}`);
        url.search = new URLSearchParams({
            ...params,
            ...(pageToken ? { pageToken } : {}),
        }).toString();

        const response = await fetch(url, {
            headers: { authorization: `Bearer ${token}` },
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });

        if (!response.ok) {
            throw new Error(`${label} request failed (${response.status})`);
        }

        const body = await response.json() as { items?: T[]; nextPageToken?: string };
        items.push(...(body.items ?? []));
        pageToken = body.nextPageToken;
    } while (pageToken);

    return items;
}

// There is no route across every list, so each list is asked in turn
async function fetchTasksFromEveryList(params: Record<string, string>): Promise<GoogleTask[]> {
    const token = await fetchAccessToken();

    const lists = await fetchAllPages<{ id: string }>(
        '/users/@me/lists',
        { maxResults: String(LISTS_PAGE_SIZE) },
        token,
        'Task list',
    );

    const tasks: GoogleTask[] = [];
    for (const list of lists) {
        tasks.push(...await fetchAllPages<GoogleTask>(
            `/lists/${encodeURIComponent(list.id)}/tasks`,
            { ...params, maxResults: String(TASKS_PAGE_SIZE) },
            token,
            'Task',
        ));
    }

    return tasks;
}

// Everything still open, whenever it is due; countDueOn does the bucketing
export async function fetchOpenTasks(): Promise<GoogleTask[]> {
    return fetchTasksFromEveryList({ showCompleted: 'false' });
}

/*
 * Narrowed to the local day's window in the request so a long history is not
 * paged through every night. showHidden is what brings back a completion that
 * has already been cleared from the list, which the apps do on their own.
 */
export async function fetchTasksCompletedOn(day: Date): Promise<GoogleTask[]> {
    const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
    const end = new Date(day.getFullYear(), day.getMonth(), day.getDate() + 1);

    return fetchTasksFromEveryList({
        showCompleted: 'true',
        showHidden: 'true',
        completedMin: start.toISOString(),
        completedMax: end.toISOString(),
    });
}
