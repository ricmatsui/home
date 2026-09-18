import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countCompletedOn, fetchChoreHistory, formatDonetickSection } from './donetick.js';
import { parseDayFile, serializeSections } from './lib.js';
import { ChoreHistory } from './types.js';

function entry(overrides: Partial<ChoreHistory> = {}): ChoreHistory {
    return {
        choreId: 1,
        status: 1,
        completedBy: 3,
        performedAt: '2026-09-04T17:30:00Z',
        ...overrides,
    };
}

describe('formatDonetickSection', () => {
    it('renders the count as a single note item', () => {
        assert.deepEqual(formatDonetickSection(7), {
            name: 'Donetick',
            items: [{ status: 'note', text: '7 completed', children: [] }],
        });
    });

    it('still records a day nothing was completed on', () => {
        assert.equal(formatDonetickSection(0).items[0].text, '0 completed');
    });

    it('survives a round trip through the day file format', () => {
        const section = formatDonetickSection(7);

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
});

describe('countCompletedOn', () => {
    // Tests run under TZ=America/Los_Angeles, so 2026-09-04 is UTC-7
    const day = new Date(2026, 8, 4);

    beforeEach(() => {
        process.env.DONETICK_USER_ID = '3';
    });

    afterEach(() => {
        delete process.env.DONETICK_USER_ID;
    });

    it('counts the completions performed on the day', () => {
        assert.equal(countCompletedOn([entry(), entry({ choreId: 2 })], day), 2);
    });

    it('ignores anything that is not a completion', () => {
        const history = [
            entry(),
            entry({ status: 0 }), // started
            entry({ status: 2 }), // skipped
            entry({ status: 3 }), // pending approval
            entry({ status: 4 }), // rejected
            entry({ status: 5 }), // missed
        ];

        assert.equal(countCompletedOn(history, day), 1);
    });

    it('ignores completions performed on another day', () => {
        const history = [
            entry(),
            entry({ performedAt: '2026-09-03T17:30:00Z' }),
            entry({ performedAt: '2026-09-05T17:30:00Z' }),
        ];

        assert.equal(countCompletedOn(history, day), 1);
    });

    /*
     * The window Donetick answers with is measured in UTC days, so a late
     * evening locally lands on the next UTC date. The count has to follow the
     * wall clock the day file is written against, not that boundary.
     */
    it('counts a late local evening that is already tomorrow in UTC', () => {
        assert.equal(countCompletedOn([entry({ performedAt: '2026-09-05T04:30:00Z' })], day), 1);
    });

    it('does not count an early local morning that is still yesterday in UTC', () => {
        assert.equal(countCompletedOn([entry({ performedAt: '2026-09-04T04:30:00Z' })], day), 0);
    });

    it('ignores rows with no or unparseable performed time', () => {
        const history = [
            entry({ performedAt: null }),
            entry({ performedAt: '' }),
            entry({ performedAt: 'not a date' }),
        ];

        assert.equal(countCompletedOn(history, day), 0);
    });

    it('counts nothing when the history is empty', () => {
        assert.equal(countCompletedOn([], day), 0);
    });

    /*
     * The ticker credits each completion to the person who tapped it, so the
     * circle's history is mostly other people's rows
     */
    it('ignores completions credited to someone else', () => {
        const history = [entry(), entry({ choreId: 2, completedBy: 4 })];

        assert.equal(countCompletedOn(history, day), 1);
    });

    it('follows the configured user rather than a hardcoded one', () => {
        process.env.DONETICK_USER_ID = '4';

        assert.equal(countCompletedOn([entry(), entry({ completedBy: 4 })], day), 1);
    });

    it('throws when no user is configured', () => {
        delete process.env.DONETICK_USER_ID;

        assert.throws(() => countCompletedOn([entry()], day), /DONETICK_USER_ID/);
    });

    it('throws when the configured user is not a user id', () => {
        for (const raw of ['3.5', 'ricardo', '3 ricardo']) {
            process.env.DONETICK_USER_ID = raw;
            assert.throws(() => countCompletedOn([entry()], day), /DONETICK_USER_ID/, raw);
        }
    });
});

describe('fetchChoreHistory', () => {
    beforeEach(() => {
        process.env.DONETICK_URL = 'http://donetick_donetick:2021';
        process.env.DONETICK_API_KEY = 'secret';
    });

    afterEach(() => {
        delete process.env.DONETICK_URL;
        delete process.env.DONETICK_API_KEY;
    });

    function stubFetch(handler: () => Response) {
        const original = globalThis.fetch;
        const calls: { url: string; init?: RequestInit }[] = [];
        globalThis.fetch = (async (input: string, init?: RequestInit) => {
            calls.push({ url: String(input), init });
            return handler();
        }) as typeof fetch;
        return { calls, restore: () => { globalThis.fetch = original; } };
    }

    function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status });
    }

    it('requests a window wide enough to cover the whole day being closed', async () => {
        const stub = stubFetch(() => jsonResponse({ res: [] }));

        try {
            await fetchChoreHistory();
        } finally {
            stub.restore();
        }

        const url = new URL(stub.calls[0].url);
        assert.equal(`${url.origin}${url.pathname}`, 'http://donetick_donetick:2021/api/v1/chores/history');
        assert.ok(Number(url.searchParams.get('limit')) >= 2);
    });

    // Without this, rows the ticker credited to another person never arrive
    it('asks for the whole circle, not just the API key owner', async () => {
        const stub = stubFetch(() => jsonResponse({ res: [] }));

        try {
            await fetchChoreHistory();
        } finally {
            stub.restore();
        }

        assert.equal(new URL(stub.calls[0].url).searchParams.get('members'), 'true');
    });

    it('authenticates with the secretkey header', async () => {
        const stub = stubFetch(() => jsonResponse({ res: [] }));

        try {
            await fetchChoreHistory();
        } finally {
            stub.restore();
        }

        assert.deepEqual(stub.calls[0].init?.headers, { secretkey: 'secret' });
    });

    it('returns the history entries', async () => {
        const history = [entry()];
        const stub = stubFetch(() => jsonResponse({ res: history }));

        try {
            assert.deepEqual(await fetchChoreHistory(), history);
        } finally {
            stub.restore();
        }
    });

    it('reads an empty history back as no entries', async () => {
        const stub = stubFetch(() => jsonResponse({ res: null }));

        try {
            assert.deepEqual(await fetchChoreHistory(), []);
        } finally {
            stub.restore();
        }
    });

    it('throws when Donetick is not configured', async () => {
        delete process.env.DONETICK_API_KEY;

        await assert.rejects(fetchChoreHistory(), /DONETICK_API_KEY/);
    });

    it('throws on a non-ok response', async () => {
        const stub = stubFetch(() => jsonResponse({ error: 'Authentication failed' }, 401));

        try {
            await assert.rejects(fetchChoreHistory(), /401/);
        } finally {
            stub.restore();
        }
    });
});
