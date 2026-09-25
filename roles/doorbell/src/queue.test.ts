import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from './queue.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('processes items in order', async () => {
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        worker: async (item) => { processed.push(item); },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.deepEqual(processed, [1, 2, 3]);
});

test('never runs two workers at once', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const queue = new SerialQueue<number>({
        worker: async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await tick();
            inFlight -= 1;
        },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.equal(maxInFlight, 1);
});

test('a worker error does not stop the queue', async () => {
    const errors: string[] = [];
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        onError: (error) => errors.push(String(error)),
        worker: async (item) => {
            if (item === 2) throw new Error('boom');
            processed.push(item);
        },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    await queue.drain();

    assert.deepEqual(processed, [1, 3]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /boom/);
});

test('size reports items still waiting, not the one in flight', async () => {
    const queue = new SerialQueue<number>({ worker: async () => { await tick(); } });

    queue.push(1);
    queue.push(2);
    queue.push(3);

    // push() starts the pump synchronously, so item 1 has already been shifted
    // out and is in flight; 2 and 3 are waiting.
    assert.equal(queue.size, 2);
    await queue.drain();
    assert.equal(queue.size, 0);
});

test('drain resolves on an idle queue without waiting for a push', async () => {
    const queue = new SerialQueue<number>({ worker: async () => {} });

    await queue.drain();

    queue.push(1);
    await queue.drain();
    await queue.drain();
});

test('a second drain of the same run resolves too', async () => {
    const queue = new SerialQueue<number>({ worker: async () => { await tick(); } });

    queue.push(1);
    queue.push(2);

    await Promise.all([queue.drain(), queue.drain()]);

    assert.equal(queue.size, 0);
});

test('nothing is dropped however deep the backlog gets', async () => {
    const processed: number[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        worker: async (item) => {
            processed.push(item);
            if (item === 1) await blocked;
        },
    });

    for (let item = 1; item <= 20; item += 1) queue.push(item);
    release();
    await queue.drain();

    assert.equal(processed.length, 20);
    assert.deepEqual(processed.slice(0, 3), [1, 2, 3]);
});

test('reports a backlog once it crosses the threshold', async () => {
    const backlogs: number[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        warnDepth: 3,
        onBacklog: (depth) => backlogs.push(depth),
        worker: async () => { await blocked; },
    });

    // The first push goes straight into the worker, so depth counts from the second.
    for (let item = 1; item <= 4; item += 1) queue.push(item);

    assert.deepEqual(backlogs, [3]);

    release();
    await queue.drain();
});

test('a backlog that stays deep is reported once, not on every push', async () => {
    const backlogs: number[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        warnDepth: 2,
        onBacklog: (depth) => backlogs.push(depth),
        worker: async () => { await blocked; },
    });

    for (let item = 1; item <= 10; item += 1) queue.push(item);

    assert.deepEqual(backlogs, [2]);

    release();
    await queue.drain();
});

test('a backlog that clears and returns is reported again', async () => {
    const backlogs: number[] = [];
    let release = () => {};
    let blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        warnDepth: 2,
        onBacklog: (depth) => backlogs.push(depth),
        worker: async () => { await blocked; },
    });

    queue.push(1);
    queue.push(2);
    queue.push(3);
    assert.deepEqual(backlogs, [2]);

    release();
    await queue.drain();

    blocked = new Promise<void>((resolve) => { release = resolve; });
    queue.push(4);
    queue.push(5);
    queue.push(6);
    assert.deepEqual(backlogs, [2, 2]);

    release();
    await queue.drain();
});
