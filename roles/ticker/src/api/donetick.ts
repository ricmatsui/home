import { ApiError, ChoreChangedError, NetworkError, SessionExpiredError } from '../lib/errors';
import { createQueue } from '../lib/queue';
import type { Chore } from '../types';

const BASE = '/api/v1';

export const REQUEST_TIMEOUT_MS = 60_000;

async function errorMessage(response: Response): Promise<string> {
    try {
        const body: unknown = await response.json();
        if (body && typeof body === 'object') {
            for (const value of Object.values(body as Record<string, unknown>)) {
                if (typeof value === 'string' && value.length > 0) {
                    return value;
                }
            }
        }
    } catch {
        // Body was not JSON. Fall through to the generic message.
    }
    return `Request failed (${response.status})`;
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    // An explicit controller rather than AbortSignal.timeout, so the timer can
    // be cleared the moment the request is done with instead of staying armed.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
        let response: Response;

        try {
            response = await fetch(`${BASE}${path}`, {
                ...init,
                redirect: 'manual',
                signal: controller.signal,
                headers: { 'Content-Type': 'application/json', ...init.headers },
            });
        } catch {
            // fetch only rejects for transport-level failures — and for our own
            // abort, which is the same story from the reader's side: no answer
            // came back.
            throw new NetworkError();
        }

        // With redirect:'manual' the browser stops at a 3xx and hands back an
        // opaque response. Nothing under /api/* redirects except forward-auth,
        // so this unambiguously means the session expired.
        if (response.type === 'opaqueredirect' || response.status === 0) {
            throw new SessionExpiredError();
        }

        if (!response.ok) {
            throw new ApiError(response.status, await errorMessage(response));
        }

        return (await response.json()) as T;
    } finally {
        // Covers reading the body too, not just the headers arriving.
        clearTimeout(timer);
    }
}

// The trailing slash matters: Donetick registers this route as /chores/ and
// answers /chores with a 301. Under redirect:'manual' that 301 arrives as an
// opaque redirect, which this client reads as an expired session — so dropping
// the slash makes every load report a bogus "session expired".
export async function getChores(): Promise<Chore[]> {
    const body = await request<{ res?: Chore[] }>('/chores/');
    return body.res ?? [];
}

/*
 * The single-chore route takes no trailing slash, which is the exact inverse
 * of the list above — /chores/{id}/ answers a 301 back to /chores/{id}, and
 * under redirect:'manual' that arrives as an opaque redirect this client
 * cannot tell from forward-auth bouncing us. Confirmed against the running
 * server, not the swagger page. A missing id comes back 500, not 404.
 */
export async function getChore(id: number): Promise<Chore> {
    const body = await request<{ res: Chore }>(`/chores/${id}`);
    return body.res;
}

/*
 * Completions are serialised.
 */
const completions = createQueue();

/*
 * `completedBy` credits the completion to someone other than the user the API
 * key belongs to. Donetick only honours it when that key's user is an admin or
 * manager of the circle, and only for a user inside the same circle; anything
 * else comes back 403. Omitted, the completion is the key owner's own.
 *
 * `dueDate` is the due date the caller believes the chore has — the one the
 * board it was tapped from is showing. It is required rather than optional on
 * purpose: an omitted one would skip the staleness check silently, and a
 * completion sent without knowing what it is completing is the bug this
 * argument exists to prevent.
 */
export interface CompleteChoreOptions {
    id: number;
    dueDate: string | null;
    completedBy?: number;
}

// Date rather than string equality: Donetick may serialise the same instant
// differently between two reads, and a due date that only looks different is
// not a chore that changed.
function sameInstant(a: string | null, b: string | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    return new Date(a).getTime() === new Date(b).getTime();
}

/*
 * The read and the completion it guards are one slot in the queue, so the
 * chore is checked the instant before the POST goes out rather than when the
 * tap arrived — a tap can wait behind a slow completion for a minute, which is
 * exactly long enough for the answer to stop being true. This is the one read
 * that is queued; `getChores` stays outside it, because a refresh has no
 * reason to sit behind a completion.
 *
 * It narrows the window rather than closing it. Donetick has no conditional
 * completion, so a chore can still change in the gap between this read and the
 * POST. What it removes is the hours-wide one: a wall tablet showing a board
 * nobody has refreshed since morning.
 */
export async function completeChore({
    id,
    dueDate,
    completedBy,
}: CompleteChoreOptions): Promise<void> {
    const body = JSON.stringify(completedBy === undefined ? {} : { completedBy });

    await completions(async () => {
        const current = await getChore(id);
        if (!sameInstant(current.nextDueDate, dueDate)) {
            throw new ChoreChangedError();
        }
        return request(`/chores/${id}/do`, { method: 'POST', body });
    });
}
