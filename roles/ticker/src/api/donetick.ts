import { ApiError, NetworkError, SessionExpiredError } from '../lib/errors';
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
 * Completions are serialised.
 */
const completions = createQueue();

export async function completeChore(id: number): Promise<void> {
    await completions(() => request(`/chores/${id}/do`, { method: 'POST', body: '{}' }));
}
