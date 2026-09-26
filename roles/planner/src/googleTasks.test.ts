import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countCompletedOn, countDueOn, fetchOpenTasks, fetchTasksCompletedOn, formatGoogleTasksSection, formatGoogleTasksUnavailable, withCompletedCount, withCompletedUnavailable } from './googleTasks.js';
import { parseDayFile, serializeSections } from './lib.js';
import { GoogleTask, Section } from './types.js';

function task(overrides: Partial<GoogleTask> = {}): GoogleTask {
    return {
        id: 'a',
        status: 'needsAction',
        // How Google sends a task due on the day the counts are taken for
        due: '2026-09-04T00:00:00.000Z',
        ...overrides,
    };
}

function note(text: string) {
    return { status: 'note' as const, text, children: [] };
}

describe('formatGoogleTasksSection', () => {
    it('opens the day with the overdue and due counts under its own name', () => {
        assert.deepEqual(formatGoogleTasksSection({ overdue: 1, dueToday: 3 }), {
            name: 'Google Tasks',
            items: [note('1 overdue'), note('3 due today')],
        });
    });

    it('survives a round trip through the day file format', () => {
        const section = formatGoogleTasksSection({ overdue: 1, dueToday: 3 });

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
});

describe('formatGoogleTasksUnavailable', () => {
    it('records the failure where the day\'s counts would have gone', () => {
        assert.deepEqual(formatGoogleTasksUnavailable(new Error('Token request failed (400 invalid_grant)')), {
            name: 'Google Tasks',
            items: [note('Due counts unavailable: Token request failed (400 invalid_grant)')],
        });
    });
});

describe('withCompletedCount', () => {
    const opened: Section = {
        name: 'Google Tasks',
        items: [note('1 overdue'), note('3 due today')],
    };

    it('records the completed count below the counts the day opened with', () => {
        assert.deepEqual(withCompletedCount(opened, 2), {
            name: 'Google Tasks',
            items: [note('1 overdue'), note('3 due today'), note('2 completed')],
        });
    });

    it('replaces a completed count already recorded on the day', () => {
        assert.deepEqual(withCompletedCount(withCompletedCount(opened, 2), 4).items, [
            note('1 overdue'),
            note('3 due today'),
            note('4 completed'),
        ]);
    });
});

describe('withCompletedUnavailable', () => {
    it('records the failure below the counts the day opened with', () => {
        const opened: Section = {
            name: 'Google Tasks',
            items: [note('1 overdue'), note('3 due today')],
        };

        assert.deepEqual(withCompletedUnavailable(opened, new Error('fetch failed')), {
            name: 'Google Tasks',
            items: [note('1 overdue'), note('3 due today'), note('Completed count unavailable: fetch failed')],
        });
    });
});

describe('countDueOn', () => {
    // Tests run under TZ=America/Los_Angeles, so 2026-09-04 is UTC-7
    const day = new Date(2026, 8, 4);

    it('counts what is due on the day the counts are taken for', () => {
        assert.deepEqual(countDueOn([task(), task({ id: 'b' })], day), { overdue: 0, dueToday: 2 });
    });

    /*
     * The midnight UTC Google sends is the evening before here. Read as an
     * instant, every task would land a day early: today's as overdue, and
     * tomorrow's as due today.
     */
    it('reads a due date as the date it names rather than as an instant', () => {
        const tasks = [
            task({ due: '2026-09-04T00:00:00.000Z' }),
            task({ id: 'b', due: '2026-09-05T00:00:00.000Z' }),
        ];

        assert.deepEqual(countDueOn(tasks, day), { overdue: 0, dueToday: 1 });
    });

    it('counts what came due before the day as overdue', () => {
        const tasks = [
            task({ due: '2026-09-03T00:00:00.000Z' }),
            task({ id: 'b', due: '2026-08-01T00:00:00.000Z' }),
        ];

        assert.deepEqual(countDueOn(tasks, day), { overdue: 2, dueToday: 0 });
    });

    it('counts neither for what only comes due later', () => {
        assert.deepEqual(countDueOn([task({ due: '2026-09-05T00:00:00.000Z' })], day), { overdue: 0, dueToday: 0 });
    });

    it('ignores completed tasks', () => {
        assert.deepEqual(countDueOn([task({ status: 'completed', due: '2026-09-03T00:00:00.000Z' })], day), { overdue: 0, dueToday: 0 });
    });

    it('ignores tasks with no or unparseable due date', () => {
        const tasks = [
            task({ due: undefined }),
            task({ id: 'b', due: '' }),
            task({ id: 'c', due: 'not a date' }),
        ];

        assert.deepEqual(countDueOn(tasks, day), { overdue: 0, dueToday: 0 });
    });
});

describe('countCompletedOn', () => {
    // Tests run under TZ=America/Los_Angeles, so 2026-09-04 is UTC-7
    const day = new Date(2026, 8, 4);

    function done(completed: string | undefined): GoogleTask {
        return task({ status: 'completed', completed });
    }

    it('counts the tasks completed on the day', () => {
        assert.equal(countCompletedOn([done('2026-09-04T17:30:00.000Z'), done('2026-09-04T20:00:00.000Z')], day), 2);
    });

    // A completion, unlike a due date, is a real instant
    it('counts a late local evening that is already tomorrow in UTC', () => {
        assert.equal(countCompletedOn([done('2026-09-05T04:30:00.000Z')], day), 1);
    });

    it('does not count an early local morning that is still yesterday in UTC', () => {
        assert.equal(countCompletedOn([done('2026-09-04T04:30:00.000Z')], day), 0);
    });

    it('ignores tasks that are still open', () => {
        assert.equal(countCompletedOn([task({ completed: '2026-09-04T17:30:00.000Z' })], day), 0);
    });

    it('ignores rows with no or unparseable completion time', () => {
        assert.equal(countCompletedOn([done(undefined), done(''), done('not a date')], day), 0);
    });
});

type Handler = (url: URL, init?: RequestInit) => Response;

function stubFetch(handler: Handler) {
    const original = globalThis.fetch;
    const calls: { url: URL; init?: RequestInit }[] = [];
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        calls.push({ url, init });
        return handler(url, init);
    }) as typeof fetch;
    return { calls, restore: () => { globalThis.fetch = original; } };
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status });
}

// A token, two lists, and the second list's tasks split over two pages
function google(tasksByList: Record<string, GoogleTask[][]>): Handler {
    return (url) => {
        if (url.hostname === 'oauth2.googleapis.com') {
            return jsonResponse({ access_token: 'access' });
        }
        if (url.pathname === '/tasks/v1/users/@me/lists') {
            return jsonResponse({ items: Object.keys(tasksByList).map(id => ({ id })) });
        }

        const listId = decodeURIComponent(url.pathname.split('/')[4]);
        const pages = tasksByList[listId];
        const page = Number(url.searchParams.get('pageToken') ?? 0);

        return jsonResponse({
            ...(pages[page].length ? { items: pages[page] } : {}),
            ...(page + 1 < pages.length ? { nextPageToken: String(page + 1) } : {}),
        });
    };
}

describe('fetchOpenTasks', () => {
    beforeEach(() => {
        process.env.GOOGLE_TASKS_CLIENT_ID = 'client';
        process.env.GOOGLE_TASKS_CLIENT_SECRET = 'secret';
        process.env.GOOGLE_TASKS_REFRESH_TOKEN = 'refresh';
    });

    afterEach(() => {
        delete process.env.GOOGLE_TASKS_CLIENT_ID;
        delete process.env.GOOGLE_TASKS_CLIENT_SECRET;
        delete process.env.GOOGLE_TASKS_REFRESH_TOKEN;
    });

    it('exchanges the refresh token for an access token', async () => {
        const stub = stubFetch(google({}));

        try {
            await fetchOpenTasks();
        } finally {
            stub.restore();
        }

        const body = new URLSearchParams(String(stub.calls[0].init?.body));
        assert.equal(stub.calls[0].init?.method, 'POST');
        assert.equal(body.get('grant_type'), 'refresh_token');
        assert.equal(body.get('refresh_token'), 'refresh');
        assert.equal(body.get('client_id'), 'client');
        assert.equal(body.get('client_secret'), 'secret');
    });

    it('collects every page of every list', async () => {
        const stub = stubFetch(google({
            inbox: [[task({ id: 'a' })]],
            'work/list': [[task({ id: 'b' })], [task({ id: 'c' })], []],
        }));

        try {
            assert.deepEqual((await fetchOpenTasks()).map(t => t.id), ['a', 'b', 'c']);
        } finally {
            stub.restore();
        }
    });

    it('asks each list for its open tasks with the access token', async () => {
        const stub = stubFetch(google({ inbox: [[]] }));

        try {
            await fetchOpenTasks();
        } finally {
            stub.restore();
        }

        const tasksCall = stub.calls.find(call => call.url.pathname === '/tasks/v1/lists/inbox/tasks')!;
        assert.equal(tasksCall.url.searchParams.get('showCompleted'), 'false');
        assert.deepEqual(tasksCall.init?.headers, { authorization: 'Bearer access' });
    });

    // The one failure that means the consent script has to be run again
    it('names why the refresh token was refused', async () => {
        const stub = stubFetch(() => jsonResponse({ error: 'invalid_grant' }, 400));

        try {
            await assert.rejects(fetchOpenTasks(), /400 invalid_grant/);
        } finally {
            stub.restore();
        }
    });

    it('throws on a non-ok list response', async () => {
        const stub = stubFetch(url => url.hostname === 'oauth2.googleapis.com'
            ? jsonResponse({ access_token: 'access' })
            : jsonResponse({}, 403));

        try {
            await assert.rejects(fetchOpenTasks(), /Task list request failed \(403\)/);
        } finally {
            stub.restore();
        }
    });

    it('throws when Google Tasks is not configured', async () => {
        delete process.env.GOOGLE_TASKS_REFRESH_TOKEN;

        await assert.rejects(fetchOpenTasks(), /GOOGLE_TASKS_REFRESH_TOKEN/);
    });
});

describe('fetchTasksCompletedOn', () => {
    beforeEach(() => {
        process.env.GOOGLE_TASKS_CLIENT_ID = 'client';
        process.env.GOOGLE_TASKS_CLIENT_SECRET = 'secret';
        process.env.GOOGLE_TASKS_REFRESH_TOKEN = 'refresh';
    });

    afterEach(() => {
        delete process.env.GOOGLE_TASKS_CLIENT_ID;
        delete process.env.GOOGLE_TASKS_CLIENT_SECRET;
        delete process.env.GOOGLE_TASKS_REFRESH_TOKEN;
    });

    // Tests run under TZ=America/Los_Angeles, so 2026-09-04 is UTC-7
    it('asks for the completions, cleared ones included, within the local day', async () => {
        const stub = stubFetch(google({ inbox: [[]] }));

        try {
            await fetchTasksCompletedOn(new Date(2026, 8, 4));
        } finally {
            stub.restore();
        }

        const params = stub.calls.find(call => call.url.pathname === '/tasks/v1/lists/inbox/tasks')!.url.searchParams;
        assert.equal(params.get('showCompleted'), 'true');
        assert.equal(params.get('showHidden'), 'true');
        assert.equal(params.get('completedMin'), '2026-09-04T07:00:00.000Z');
        assert.equal(params.get('completedMax'), '2026-09-05T07:00:00.000Z');
    });
});
