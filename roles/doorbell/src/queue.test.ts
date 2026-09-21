import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SerialQueue } from './queue.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

test('processes items in order', async () => {
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        max: 10,
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
        max: 10,
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

test('evicts the oldest item when full', async () => {
    const evicted: number[] = [];
    const processed: number[] = [];
    let release = () => {};
    const blocked = new Promise<void>((resolve) => { release = resolve; });

    const queue = new SerialQueue<number>({
        max: 2,
        onEvict: (item) => evicted.push(item),
        worker: async (item) => {
            processed.push(item);
            if (item === 1) await blocked;
        },
    });

    queue.push(1);
    await tick();
    queue.push(2);
    queue.push(3);
    queue.push(4);

    assert.deepEqual(evicted, [2]);

    release();
    await queue.drain();

    assert.deepEqual(processed, [1, 3, 4]);
});

test('a worker error does not stop the queue', async () => {
    const errors: string[] = [];
    const processed: number[] = [];
    const queue = new SerialQueue<number>({
        max: 10,
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
    const queue = new SerialQueue<number>({ max: 10, worker: async () => { await tick(); } });

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
    const queue = new SerialQueue<number>({ max: 10, worker: async () => {} });

    await queue.drain();

    queue.push(1);
    await queue.drain();
    await queue.drain();
});

test('a second drain of the same run resolves too', async () => {
    const queue = new SerialQueue<number>({ max: 10, worker: async () => { await tick(); } });

    queue.push(1);
    queue.push(2);

    await Promise.all([queue.drain(), queue.drain()]);

    assert.equal(queue.size, 0);
});
