import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { countCompletedOn, countDueOn, fetchChoreHistory, fetchChores, formatDonetickSection, formatDonetickUnavailable, withCompletedCount, withCompletedUnavailable } from './donetick.js';
import { parseDayFile, serializeSections } from './lib.js';
import { Chore, ChoreHistory, Section } from './types.js';

function chore(overrides: Partial<Chore> = {}): Chore {
    return {
        id: 1,
        isActive: true,
        assignedTo: 3,
        // 10:30 on the morning of the day the counts are taken for
        nextDueDate: '2026-09-04T17:30:00Z',
        ...overrides,
    };
}

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
    it('opens the day with the overdue and due counts as note items', () => {
        assert.deepEqual(formatDonetickSection({ overdue: 3, dueToday: 5 }), {
            name: 'Donetick',
            items: [
                { status: 'note', text: '3 overdue', children: [] },
                { status: 'note', text: '5 due today', children: [] },
            ],
        });
    });

    it('still opens a day with nothing overdue or due', () => {
        assert.deepEqual(
            formatDonetickSection({ overdue: 0, dueToday: 0 }).items.map(item => item.text),
            ['0 overdue', '0 due today'],
        );
    });

    it('survives a round trip through the day file format', () => {
        const section = formatDonetickSection({ overdue: 3, dueToday: 5 });

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
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

function note(text: string) {
    return { status: 'note' as const, text, children: [] };
}

describe('withCompletedCount', () => {
    // The day was opened with these the midnight before, and closing it must
    // not throw away what it was planned to hold
    const opened: Section = {
        name: 'Donetick',
        items: [note('3 overdue'), note('5 due today')],
    };

    it('records the completed count below the counts the day opened with', () => {
        assert.deepEqual(withCompletedCount(opened, 7), {
            name: 'Donetick',
            items: [note('3 overdue'), note('5 due today'), note('7 completed')],
        });
    });

    it('still records a day nothing was completed on', () => {
        assert.equal(withCompletedCount(opened, 0).items[2].text, '0 completed');
    });

    // Closing the same day twice must not leave two completed counts behind
    it('replaces a completed count already recorded on the day', () => {
        const closed = withCompletedCount(opened, 7);

        assert.deepEqual(withCompletedCount(closed, 9), {
            name: 'Donetick',
            items: [note('3 overdue'), note('5 due today'), note('9 completed')],
        });
    });

    // A rerun after a failed close leaves the count, not both
    it('replaces a failure an earlier close recorded in the count\'s place', () => {
        const failed = withCompletedUnavailable(opened, new Error('fetch failed'));

        assert.deepEqual(withCompletedCount(failed, 9).items, [
            note('3 overdue'),
            note('5 due today'),
            note('9 completed'),
        ]);
    });

    it('keeps the note left by a day that never read its due counts', () => {
        const neverOpened = formatDonetickUnavailable(new Error('Chore list request failed (500)'));

        assert.deepEqual(withCompletedCount(neverOpened, 9).items, [
            note('Due counts unavailable: Chore list request failed (500)'),
            note('9 completed'),
        ]);
    });

    it('records the count on a day that was never opened with a section', () => {
        assert.deepEqual(withCompletedCount(undefined, 7), {
            name: 'Donetick',
            items: [note('7 completed')],
        });
    });

    it('leaves the day it was given untouched', () => {
        withCompletedCount(opened, 7);

        assert.deepEqual(opened.items, [note('3 overdue'), note('5 due today')]);
    });

    it('survives a round trip through the day file format', () => {
        const section = withCompletedCount(opened, 7);

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
});

describe('formatDonetickUnavailable', () => {
    it('records the failure where the day\'s counts would have gone', () => {
        assert.deepEqual(formatDonetickUnavailable(new Error('Chore list request failed (500)')), {
            name: 'Donetick',
            items: [note('Due counts unavailable: Chore list request failed (500)')],
        });
    });

    it('survives a round trip through the day file format', () => {
        const section = formatDonetickUnavailable(new Error('Chore list request failed (500)'));

        assert.deepEqual(parseDayFile(serializeSections([section])), [section]);
    });
});

describe('withCompletedUnavailable', () => {
    const opened: Section = {
        name: 'Donetick',
        items: [note('3 overdue'), note('5 due today')],
    };

    it('records the failure below the counts the day opened with', () => {
        assert.deepEqual(withCompletedUnavailable(opened, new Error('Chore history request failed (500)')), {
            name: 'Donetick',
            items: [
                note('3 overdue'),
                note('5 due today'),
                note('Completed count unavailable: Chore history request failed (500)'),
            ],
        });
    });

    // A day whose due counts were never read still says so after it closes:
    // the two failures are separate facts about the same day
    it('keeps the note left by a day that never read its due counts', () => {
        const neverOpened = formatDonetickUnavailable(new Error('Chore list request failed (500)'));

        assert.deepEqual(withCompletedUnavailable(neverOpened, new Error('Chore history request failed (500)')).items, [
            note('Due counts unavailable: Chore list request failed (500)'),
            note('Completed count unavailable: Chore history request failed (500)'),
        ]);
    });

    it('replaces a failure an earlier close already recorded', () => {
        const closed = withCompletedUnavailable(opened, new Error('Chore history request failed (500)'));

        assert.deepEqual(withCompletedUnavailable(closed, new Error('fetch failed')).items, [
            note('3 overdue'),
            note('5 due today'),
            note('Completed count unavailable: fetch failed'),
        ]);
    });

    it('replaces a completed count an earlier close already recorded', () => {
        const closed = withCompletedCount(opened, 7);

        assert.deepEqual(withCompletedUnavailable(closed, new Error('fetch failed')).items, [
            note('3 overdue'),
            note('5 due today'),
            note('Completed count unavailable: fetch failed'),
        ]);
    });

    it('records the failure on a day that was never opened with a section', () => {
        assert.deepEqual(withCompletedUnavailable(undefined, new Error('fetch failed')), {
            name: 'Donetick',
            items: [note('Completed count unavailable: fetch failed')],
        });
    });

    it('leaves the day it was given untouched', () => {
        withCompletedUnavailable(opened, new Error('fetch failed'));

        assert.deepEqual(opened.items, [note('3 overdue'), note('5 due today')]);
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

describe('countDueOn', () => {
    // Tests run under TZ=America/Los_Angeles, so 2026-09-04 is UTC-7
    const day = new Date(2026, 8, 4);

    const YESTERDAY = '2026-09-03T17:30:00Z';
    const TOMORROW = '2026-09-05T17:30:00Z';

    beforeEach(() => {
        process.env.DONETICK_USER_ID = '3';
    });

    afterEach(() => {
        delete process.env.DONETICK_USER_ID;
    });

    it('counts what is due on the day the counts are taken for', () => {
        assert.deepEqual(countDueOn([chore(), chore({ id: 2 })], day), { overdue: 0, dueToday: 2 });
    });

    it('counts what came due before the day as overdue', () => {
        const chores = [chore({ nextDueDate: YESTERDAY }), chore({ id: 2, nextDueDate: '2026-08-30T17:30:00Z' })];

        assert.deepEqual(countDueOn(chores, day), { overdue: 2, dueToday: 0 });
    });

    it('counts neither for what only comes due later', () => {
        assert.deepEqual(countDueOn([chore({ nextDueDate: TOMORROW })], day), { overdue: 0, dueToday: 0 });
    });

    /*
     * Due dates come back as instants, so a late local evening reads as the
     * next UTC date. The split has to follow the wall clock the day file is
     * written against, the same way the completed count does.
     */
    it('counts a late local evening that is already tomorrow in UTC as due that day', () => {
        assert.deepEqual(
            countDueOn([chore({ nextDueDate: '2026-09-05T04:30:00Z' })], day),
            { overdue: 0, dueToday: 1 },
        );
    });

    it('counts an early UTC morning that is still the evening before locally as overdue', () => {
        assert.deepEqual(
            countDueOn([chore({ nextDueDate: '2026-09-04T04:30:00Z' })], day),
            { overdue: 1, dueToday: 0 },
        );
    });

    // Nobody has been given it yet, but it is still work the day is carrying
    it('counts chores nobody is assigned to', () => {
        assert.deepEqual(countDueOn([chore({ assignedTo: null })], day), { overdue: 0, dueToday: 1 });
    });

    it('ignores chores assigned to someone else', () => {
        assert.deepEqual(countDueOn([chore(), chore({ id: 2, assignedTo: 4 })], day), { overdue: 0, dueToday: 1 });
    });

    it('ignores chores that are not active', () => {
        assert.deepEqual(countDueOn([chore({ isActive: false, nextDueDate: YESTERDAY })], day), { overdue: 0, dueToday: 0 });
    });

    it('ignores chores with no or unparseable due date', () => {
        const chores = [
            chore({ nextDueDate: null }),
            chore({ id: 2, nextDueDate: '' }),
            chore({ id: 3, nextDueDate: 'not a date' }),
        ];

        assert.deepEqual(countDueOn(chores, day), { overdue: 0, dueToday: 0 });
    });

    it('counts nothing when there are no chores', () => {
        assert.deepEqual(countDueOn([], day), { overdue: 0, dueToday: 0 });
    });

    it('follows the configured user rather than a hardcoded one', () => {
        process.env.DONETICK_USER_ID = '4';

        assert.deepEqual(countDueOn([chore(), chore({ id: 2, assignedTo: 4 })], day), { overdue: 0, dueToday: 1 });
    });

    it('throws when no user is configured', () => {
        delete process.env.DONETICK_USER_ID;

        assert.throws(() => countDueOn([chore()], day), /DONETICK_USER_ID/);
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

describe('fetchChores', () => {
    beforeEach(() => {
        process.env.DONETICK_URL = 'http://donetick_donetick:2021';
        process.env.DONETICK_API_KEY = 'secret';
    });

    afterEach(() => {
        delete process.env.DONETICK_URL;
        delete process.env.DONETICK_API_KEY;
    });

    it('requests the chore list', async () => {
        const stub = stubFetch(() => jsonResponse({ res: [] }));

        try {
            await fetchChores();
        } finally {
            stub.restore();
        }

        const url = new URL(stub.calls[0].url);
        assert.equal(`${url.origin}${url.pathname}`, 'http://donetick_donetick:2021/api/v1/chores/');
    });

    it('authenticates with the secretkey header', async () => {
        const stub = stubFetch(() => jsonResponse({ res: [] }));

        try {
            await fetchChores();
        } finally {
            stub.restore();
        }

        assert.deepEqual(stub.calls[0].init?.headers, { secretkey: 'secret' });
    });

    it('returns the chores', async () => {
        const chores = [chore()];
        const stub = stubFetch(() => jsonResponse({ res: chores }));

        try {
            assert.deepEqual(await fetchChores(), chores);
        } finally {
            stub.restore();
        }
    });

    it('reads an empty list back as no chores', async () => {
        const stub = stubFetch(() => jsonResponse({ res: null }));

        try {
            assert.deepEqual(await fetchChores(), []);
        } finally {
            stub.restore();
        }
    });

    it('throws when Donetick is not configured', async () => {
        delete process.env.DONETICK_API_KEY;

        await assert.rejects(fetchChores(), /DONETICK_API_KEY/);
    });

    it('throws on a non-ok response', async () => {
        const stub = stubFetch(() => jsonResponse({ error: 'Authentication failed' }, 401));

        try {
            await assert.rejects(fetchChores(), /401/);
        } finally {
            stub.restore();
        }
    });
});
