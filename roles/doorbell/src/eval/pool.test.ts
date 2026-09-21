import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapWithConcurrency } from './pool.js';

/** Resolves when `release()` is called, so a test can choose the completion order. */
function deferred<T>(): { promise: Promise<T>; release: (value: T) => void } {
    let release!: (value: T) => void;
    const promise = new Promise<T>((resolve) => {
        release = resolve;
    });
    return { promise, release };
}

test('returns results in input order, not completion order', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>()];
    const running = mapWithConcurrency([0, 1, 2], 3, async (index) => gates[index]!.promise);

    gates[2]!.release('third');
    gates[0]!.release('first');
    gates[1]!.release('second');

    assert.deepEqual(await running, ['first', 'second', 'third']);
});

test('never runs more than the limit at once', async () => {
    let inFlight = 0;
    let peak = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6, 7], 3, async (value) => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return value;
    });

    assert.equal(peak, 3);
});

test('a limit of one is exactly sequential', async () => {
    const order: number[] = [];

    await mapWithConcurrency([1, 2, 3], 1, async (value) => {
        order.push(value);
        await new Promise((resolve) => setTimeout(resolve, value === 1 ? 10 : 0));
        return value;
    });

    assert.deepEqual(order, [1, 2, 3]);
});

test('passes the index of each item', async () => {
    const seen = await mapWithConcurrency(['a', 'b', 'c'], 2, async (value, index) => `${index}${value}`);

    assert.deepEqual(seen, ['0a', '1b', '2c']);
});

test('a limit larger than the list is harmless', async () => {
    assert.deepEqual(await mapWithConcurrency([1, 2], 10, async (value) => value * 2), [2, 4]);
});

test('an empty list resolves to an empty list', async () => {
    assert.deepEqual(await mapWithConcurrency([], 4, async () => 'never'), []);
});

test('a rejected worker rejects the whole map', async () => {
    await assert.rejects(
        mapWithConcurrency([1, 2, 3], 2, async (value) => {
            if (value === 2) throw new Error('boom');
            return value;
        }),
        /boom/,
    );
});
