import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventUrl, createFrigateEvents } from './frigate.js';

interface Call {
    url: string;
    method: string;
    body: unknown;
}

/**
 * A fetch stand-in that records what was asked of it. `respond` returns either a
 * Response or a promise of one, which is how the ordering test holds one create
 * open while the next window's is queued behind it.
 */
function recorder(respond: (call: Call) => Response | Promise<Response>) {
    const calls: Call[] = [];

    const impl = (async (input, init) => {
        const call: Call = {
            url: String(input),
            method: init?.method ?? 'GET',
            body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
        };
        calls.push(call);
        return respond(call);
    }) as typeof fetch;

    return { calls, impl };
}

function created(eventId: string): Response {
    return Response.json({ success: true, message: 'Successfully created event.', event_id: eventId });
}

function events(impl: typeof fetch) {
    return createFrigateEvents({ baseUrl: 'http://frigate:5000', camera: 'example_camera', fetchImpl: impl });
}

test('builds the create url, trimming a trailing slash', () => {
    assert.equal(
        createEventUrl('http://frigate:5000/', 'example_camera', 'cat'),
        'http://frigate:5000/api/events/example_camera/cat/create',
    );
});

test('creates one fixed-length event per window however many cats are seen', async () => {
    const { calls, impl } = recorder(() => created('evt-1'));
    const frigate = events(impl);

    frigate.openWindow();
    frigate.recordCat();
    frigate.recordCat();
    frigate.recordCat();
    await frigate.drain();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'http://frigate:5000/api/events/example_camera/cat/create');
    assert.equal(calls[0].method, 'POST');
    // A duration is what makes Frigate end the event, and its review alert, itself.
    assert.deepEqual(calls[0].body, { duration: 20, include_recording: true });
});

test('closing a window asks frigate for nothing', async () => {
    const { calls, impl } = recorder(() => created('evt-1'));
    const frigate = events(impl);

    frigate.openWindow();
    frigate.recordCat();
    frigate.closeWindow();
    frigate.closeWindow();
    await frigate.drain();

    assert.deepEqual(calls.map((call) => call.method), ['POST']);
});

test('a window that closes mid-create still lets the create finish', async () => {
    let release: (() => void) | null = null;
    const pending = new Promise<void>((resolve) => { release = resolve; });

    const { calls, impl } = recorder(async () => {
        await pending;
        return created('evt-1');
    });
    const frigate = events(impl);

    // Both callbacks are synchronous in index.ts, so this is the real ordering: a
    // window that closes while the create is still on the wire.
    frigate.openWindow();
    frigate.recordCat();
    frigate.closeWindow();

    // The next window cannot overlap it; its create waits its turn in the chain.
    frigate.openWindow();
    frigate.recordCat();

    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1, 'the second create must not overtake the first');

    release!();
    await frigate.drain();

    assert.equal(calls.length, 2);
});

test('a create that fails is only logged', async () => {
    const { calls, impl } = recorder(() => new Response('nope', { status: 500 }));
    const frigate = events(impl);

    frigate.openWindow();
    frigate.recordCat();
    frigate.closeWindow();
    await frigate.drain();

    assert.deepEqual(calls.map((call) => call.method), ['POST']);
});

test('a reply with no event_id is a failed create', async () => {
    const { calls, impl } = recorder(() => Response.json({ success: false, message: 'example_camera is not a valid camera.' }));
    const frigate = events(impl);

    frigate.openWindow();
    frigate.recordCat();
    await frigate.drain();

    assert.deepEqual(calls.map((call) => call.method), ['POST']);
});

test('a later cat retries a create that failed', async () => {
    let attempts = 0;
    const { impl } = recorder(() => {
        attempts += 1;
        return attempts === 1 ? new Response('nope', { status: 500 }) : created('evt-2');
    });
    const frigate = events(impl);

    frigate.openWindow();
    frigate.recordCat();
    await frigate.drain();
    frigate.recordCat();
    await frigate.drain();

    assert.equal(attempts, 2);

    // And the one that worked is not retried again.
    frigate.recordCat();
    await frigate.drain();

    assert.equal(attempts, 2);
});

test('ignores a cat outside the window', async () => {
    const { calls, impl } = recorder(() => created('evt-1'));
    const frigate = events(impl);

    // A frame still in the queue when the window closed must not open an event
    // against a camera that is being switched off.
    frigate.recordCat();
    frigate.openWindow();
    frigate.recordCat();
    frigate.closeWindow();
    frigate.recordCat();
    await frigate.drain();

    assert.deepEqual(calls.map((call) => call.method), ['POST']);
});

test('a window that saw no cat asks frigate for nothing', async () => {
    const { calls, impl } = recorder(() => created('evt-1'));
    const frigate = events(impl);

    frigate.openWindow();
    frigate.closeWindow();
    await frigate.drain();

    assert.deepEqual(calls, []);
});

test('drain settles when nothing has happened at all', async () => {
    const { impl } = recorder(() => created('evt-1'));
    await events(impl).drain();
});
