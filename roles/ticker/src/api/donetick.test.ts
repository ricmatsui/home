import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeChore, getChore, getChores, REQUEST_TIMEOUT_MS } from './donetick';
import { ApiError, ChoreChangedError, NetworkError, SessionExpiredError } from '../lib/errors';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

// A fetch that never answers, but does honour the abort signal the way the
// real one does.
function hangingFetch() {
    return vi.fn(
        (_url: string, init: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                    reject(new DOMException('The operation was aborted.', 'AbortError'));
                });
            }),
    );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('getChores', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The trailing slash is load-bearing. Donetick registers this route as
    // /chores/ and answers /chores with a 301 to it, which redirect:'manual'
    // reports as an opaque redirect — indistinguishable from forward-auth
    // bouncing us, so the app would claim the session had expired.
    it('requests the chores endpoint with a trailing slash and manual redirects', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: [] }));

        await getChores();

        expect(fetch).toHaveBeenCalledWith(
            '/api/v1/chores/',
            expect.objectContaining({ redirect: 'manual' }),
        );
    });

    it('unwraps the res envelope', async () => {
        const chore = { id: 7, name: 'Trash', nextDueDate: null, isActive: true, priority: 0 };
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: [chore] }));

        await expect(getChores()).resolves.toEqual([chore]);
    });

    it('returns an empty list when res is missing', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({}));

        await expect(getChores()).resolves.toEqual([]);
    });

    it('throws SessionExpiredError on an opaque redirect', async () => {
        vi.mocked(fetch).mockResolvedValue({
            type: 'opaqueredirect',
            status: 0,
            ok: false,
        } as Response);

        await expect(getChores()).rejects.toBeInstanceOf(SessionExpiredError);
    });

    it('throws NetworkError when fetch itself rejects', async () => {
        vi.mocked(fetch).mockRejectedValue(new TypeError('Failed to fetch'));

        await expect(getChores()).rejects.toBeInstanceOf(NetworkError);
    });

    it('throws ApiError carrying the status and the API message', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ error: 'Authentication failed' }, 401));

        expect.assertions(3);
        try {
            await getChores();
        } catch (caught) {
            expect(caught).toBeInstanceOf(ApiError);
            expect((caught as ApiError).status).toBe(401);
            expect((caught as ApiError).message).toBe('Authentication failed');
        }
    });

    it('falls back to a generic message when the error body has none', async () => {
        vi.mocked(fetch).mockResolvedValue(new Response('gateway blew up', { status: 502 }));

        await expect(getChores()).rejects.toMatchObject({ status: 502 });
    });
});

describe('getChore', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    // The exact inverse of the list route, and confirmed against the running
    // server rather than the swagger page: /chores/{id} answers 200 and
    // /chores/{id}/ answers a 301 back to it. Under redirect:'manual' that
    // redirect is an opaque response, which this client reads as an expired
    // session — so a trailing slash here would make every completion claim
    // the session had lapsed.
    it('requests a single chore without a trailing slash', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: { id: 42 } }));

        await getChore(42);

        expect(fetch).toHaveBeenCalledWith(
            '/api/v1/chores/42',
            expect.objectContaining({ redirect: 'manual' }),
        );
    });

    it('unwraps the res envelope into a single chore', async () => {
        const chore = { id: 42, name: 'Trash', nextDueDate: '2026-08-15T12:00:00Z' };
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: chore }));

        await expect(getChore(42)).resolves.toEqual(chore);
    });
});

describe('completeChore', () => {
    const DUE = '2026-08-15T12:00:00Z';

    // Answers the freshness check with the due date given, and anything else
    // with an empty success — the POST's response body is never read.
    function serveChore(nextDueDate: string | null = DUE) {
        vi.mocked(fetch).mockImplementation((url) =>
            Promise.resolve(
                String(url).endsWith('/do')
                    ? jsonResponse({ res: {} })
                    : jsonResponse({ res: { id: 42, nextDueDate } }),
            ),
        );
    }

    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts to the do endpoint with an empty JSON body', async () => {
        serveChore();

        await completeChore({ id: 42, dueDate: DUE });

        expect(fetch).toHaveBeenCalledWith(
            '/api/v1/chores/42/do',
            expect.objectContaining({
                method: 'POST',
                redirect: 'manual',
                body: '{}',
            }),
        );
    });

    /*
     * Donetick credits the completion to the API key's own user unless the
     * body names someone else. The key belongs to a circle admin, which is
     * what makes completedBy allowed at all.
     */
    it('posts the person the completion is credited to', async () => {
        serveChore();

        await completeChore({ id: 42, dueDate: DUE, completedBy: 3 });

        expect(fetch).toHaveBeenCalledWith(
            '/api/v1/chores/42/do',
            expect.objectContaining({ body: '{"completedBy":3}' }),
        );
    });

    it('reads the chore back before posting the completion', async () => {
        serveChore();

        await completeChore({ id: 42, dueDate: DUE });

        expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
            '/api/v1/chores/42',
            '/api/v1/chores/42/do',
        ]);
    });

    /*
     * The board this tap came from may have been rendered hours ago. A due
     * date that has moved since means somebody already completed the chore
     * and Donetick rolled it forward, so completing again would tick off the
     * next cycle rather than the one on screen.
     */
    it('refuses the completion when the due date has moved', async () => {
        serveChore('2026-08-22T12:00:00Z');

        await expect(completeChore({ id: 42, dueDate: DUE })).rejects.toBeInstanceOf(
            ChoreChangedError,
        );
    });

    it('does not post anything once it has refused', async () => {
        serveChore('2026-08-22T12:00:00Z');

        await expect(completeChore({ id: 42, dueDate: DUE })).rejects.toThrow();

        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/v1/chores/42');
    });

    it('refuses the completion when the chore no longer has a due date', async () => {
        serveChore(null);

        await expect(completeChore({ id: 42, dueDate: DUE })).rejects.toBeInstanceOf(
            ChoreChangedError,
        );
    });

    it('refuses the completion when the chore only now has a due date', async () => {
        serveChore(DUE);

        await expect(completeChore({ id: 42, dueDate: null })).rejects.toBeInstanceOf(
            ChoreChangedError,
        );
    });

    // The guard is about the instant, not the spelling of it. Comparing the
    // raw strings would refuse a completion merely because Donetick wrote the
    // very same moment with milliseconds this time.
    it('completes when the same instant is written differently', async () => {
        serveChore('2026-08-15T12:00:00.000Z');

        await expect(completeChore({ id: 42, dueDate: DUE })).resolves.toBeUndefined();
    });

    it('surfaces the completion-window rejection as an ApiError', async () => {
        vi.mocked(fetch).mockImplementation((url) =>
            Promise.resolve(
                String(url).endsWith('/do')
                    ? jsonResponse({ error: 'Chore is out of completion window' }, 400)
                    : jsonResponse({ res: { id: 42, nextDueDate: DUE } }),
            ),
        );

        await expect(completeChore({ id: 42, dueDate: DUE })).rejects.toMatchObject({
            status: 400,
            message: 'Chore is out of completion window',
        });
    });

    it('throws SessionExpiredError on an opaque redirect', async () => {
        vi.mocked(fetch).mockResolvedValue({
            type: 'opaqueredirect',
            status: 0,
            ok: false,
        } as Response);

        await expect(completeChore({ id: 42, dueDate: DUE })).rejects.toBeInstanceOf(
            SessionExpiredError,
        );
    });

    it('sends one completion at a time', async () => {
        const firstCheck = deferred<Response>();
        // A fresh Response per call: a body can only be read once, and each
        // completion now makes two requests.
        vi.mocked(fetch)
            .mockReturnValueOnce(firstCheck.promise)
            .mockImplementation(() => Promise.resolve(jsonResponse({ res: { nextDueDate: DUE } })));

        const firstCall = completeChore({ id: 1, dueDate: DUE });
        const secondCall = completeChore({ id: 2, dueDate: DUE });

        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/v1/chores/1');

        firstCheck.resolve(jsonResponse({ res: { nextDueDate: DUE } }));
        await Promise.all([firstCall, secondCall]);

        // The check and the completion it guards are one slot in the queue,
        // never interleaved with another tap's pair.
        expect(vi.mocked(fetch).mock.calls.map((call) => call[0])).toEqual([
            '/api/v1/chores/1',
            '/api/v1/chores/1/do',
            '/api/v1/chores/2',
            '/api/v1/chores/2/do',
        ]);
    });

    /*
     * The whole reason the check sits inside the queue slot rather than at the
     * call: a tap can wait behind a slow completion for as long as that one
     * takes, and a check made when the tap arrived would have aged by exactly
     * that much before the POST it guards went out.
     */
    it('checks the chore when its turn comes, not when the tap was made', async () => {
        const firstCheck = deferred<Response>();
        let served = DUE;

        vi.mocked(fetch).mockImplementation((url) => {
            if (url === '/api/v1/chores/1') {
                return firstCheck.promise;
            }
            if (url === '/api/v1/chores/2') {
                return Promise.resolve(jsonResponse({ res: { nextDueDate: served } }));
            }
            return Promise.resolve(jsonResponse({ res: {} }));
        });

        const firstCall = completeChore({ id: 1, dueDate: DUE });
        const secondCall = completeChore({ id: 2, dueDate: DUE });

        await settle();
        // Somebody else clears chore 2 while chore 1 is still in flight.
        served = '2026-08-22T12:00:00Z';
        firstCheck.resolve(jsonResponse({ res: { nextDueDate: DUE } }));

        await expect(firstCall).resolves.toBeUndefined();
        await expect(secondCall).rejects.toBeInstanceOf(ChoreChangedError);
    });

    it('sends the next completion even when the one before it failed', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(jsonResponse({ res: { nextDueDate: DUE } }))
            .mockResolvedValueOnce(jsonResponse({ error: 'Chore is out of completion window' }, 400))
            .mockImplementation(() => Promise.resolve(jsonResponse({ res: { nextDueDate: DUE } })));

        const failing = completeChore({ id: 1, dueDate: DUE });
        const following = completeChore({ id: 2, dueDate: DUE });

        await expect(failing).rejects.toBeInstanceOf(ApiError);
        await expect(following).resolves.toBeUndefined();
    });

    // A refused completion is still a finished slot. The queue must not wedge
    // on one, or a single stale row would take the rest of the board with it.
    it('sends the next completion even when the one before it was refused', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(jsonResponse({ res: { nextDueDate: '2026-08-22T12:00:00Z' } }))
            .mockImplementation(() => Promise.resolve(jsonResponse({ res: { nextDueDate: DUE } })));

        const refused = completeChore({ id: 1, dueDate: DUE });
        const following = completeChore({ id: 2, dueDate: DUE });

        await expect(refused).rejects.toBeInstanceOf(ChoreChangedError);
        await expect(following).resolves.toBeUndefined();
    });

    // The clock starts when the request goes out, not when the tap arrives —
    // otherwise a slow completion would time out everything queued behind it
    // before those requests had been sent at all.
    it('does not start a queued request timing out while it waits its turn', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', hangingFetch());

        const firstCall = completeChore({ id: 1, dueDate: DUE });
        const secondCall = completeChore({ id: 2, dueDate: DUE });
        const assertions = Promise.all([
            expect(firstCall).rejects.toBeInstanceOf(NetworkError),
            expect(secondCall).rejects.toBeInstanceOf(NetworkError),
        ]);

        // Enough for the first request to time out and the second, only now
        // being sent, to time out in its own right.
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        expect(fetch).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

        await assertions;
        vi.useRealTimers();
    });
});

describe('request timeout', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.useRealTimers();
    });

    it('gives up on a request that never answers', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', hangingFetch());

        const pending = getChores();
        const assertion = expect(pending).rejects.toBeInstanceOf(NetworkError);

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
        await assertion;
    });

    it('waits the full timeout before giving up', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', hangingFetch());

        const settled = vi.fn();
        void getChores().catch(settled);

        await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS - 1);
        expect(settled).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(settled).toHaveBeenCalled();
    });

    it('cancels the timer once the response lands', async () => {
        vi.useFakeTimers();
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: [] }));

        await getChores();

        // A request that answered must leave nothing armed behind it.
        expect(vi.getTimerCount()).toBe(0);
    });
});
