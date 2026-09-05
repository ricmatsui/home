import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { completeChore, getChores, REQUEST_TIMEOUT_MS } from './donetick';
import { ApiError, NetworkError, SessionExpiredError } from '../lib/errors';

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

describe('completeChore', () => {
    beforeEach(() => {
        vi.stubGlobal('fetch', vi.fn());
    });

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('posts to the do endpoint with an empty JSON body', async () => {
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: {} }));

        await completeChore({ id: 42 });

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
        vi.mocked(fetch).mockResolvedValue(jsonResponse({ res: {} }));

        await completeChore({ id: 42, completedBy: 3 });

        expect(fetch).toHaveBeenCalledWith(
            '/api/v1/chores/42/do',
            expect.objectContaining({ body: '{"completedBy":3}' }),
        );
    });

    it('surfaces the completion-window rejection as an ApiError', async () => {
        vi.mocked(fetch).mockResolvedValue(
            jsonResponse({ error: 'Chore is out of completion window' }, 400),
        );

        await expect(completeChore({ id: 42 })).rejects.toMatchObject({
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

        await expect(completeChore({ id: 42 })).rejects.toBeInstanceOf(SessionExpiredError);
    });

    it('sends one completion at a time', async () => {
        const first = deferred<Response>();
        vi.mocked(fetch)
            .mockReturnValueOnce(first.promise)
            .mockResolvedValue(jsonResponse({ res: {} }));

        const firstCall = completeChore({ id: 1 });
        const secondCall = completeChore({ id: 2 });

        await settle();
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe('/api/v1/chores/1/do');

        first.resolve(jsonResponse({ res: {} }));
        await Promise.all([firstCall, secondCall]);

        expect(fetch).toHaveBeenCalledTimes(2);
        expect(vi.mocked(fetch).mock.calls[1][0]).toBe('/api/v1/chores/2/do');
    });

    it('sends the next completion even when the one before it failed', async () => {
        vi.mocked(fetch)
            .mockResolvedValueOnce(jsonResponse({ error: 'Chore is out of completion window' }, 400))
            .mockResolvedValue(jsonResponse({ res: {} }));

        const failing = completeChore({ id: 1 });
        const following = completeChore({ id: 2 });

        await expect(failing).rejects.toBeInstanceOf(ApiError);
        await expect(following).resolves.toBeUndefined();
        expect(fetch).toHaveBeenCalledTimes(2);
    });

    // The clock starts when the request goes out, not when the tap arrives —
    // otherwise a slow completion would time out everything queued behind it
    // before those requests had been sent at all.
    it('does not start a queued request timing out while it waits its turn', async () => {
        vi.useFakeTimers();
        vi.stubGlobal('fetch', hangingFetch());

        const firstCall = completeChore({ id: 1 });
        const secondCall = completeChore({ id: 2 });
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
