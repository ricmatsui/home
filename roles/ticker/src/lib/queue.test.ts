import { describe, expect, it, vi } from 'vitest';
import { createQueue } from './queue';

function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

// Lets every already-scheduled microtask run, so "has the queue started the
// next task yet?" is a question about the queue and not about timing.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createQueue', () => {
    it('starts a task immediately when nothing is in flight', async () => {
        const run = createQueue();
        const task = vi.fn().mockResolvedValue('done');

        const result = run(task);

        await settle();
        expect(task).toHaveBeenCalled();
        await expect(result).resolves.toBe('done');
    });

    it('holds a task back until the one in flight settles', async () => {
        const run = createQueue();
        const first = deferred<string>();
        const second = vi.fn().mockResolvedValue('second');

        const firstResult = run(() => first.promise);
        const secondResult = run(second);

        await settle();
        expect(second).not.toHaveBeenCalled();

        first.resolve('first');
        await expect(firstResult).resolves.toBe('first');
        await expect(secondResult).resolves.toBe('second');
        expect(second).toHaveBeenCalled();
    });

    it('runs queued tasks in the order they arrived', async () => {
        const run = createQueue();
        const gate = deferred<void>();
        const order: string[] = [];

        const track = (name: string) => async () => {
            order.push(name);
        };

        const first = run(async () => {
            order.push('a');
            await gate.promise;
        });
        const rest = [run(track('b')), run(track('c')), run(track('d'))];

        gate.resolve();
        await Promise.all([first, ...rest]);

        expect(order).toEqual(['a', 'b', 'c', 'd']);
    });

    it('keeps draining after a task rejects', async () => {
        const run = createQueue();
        const failing = run(() => Promise.reject(new Error('boom')));
        const after = vi.fn().mockResolvedValue('ran anyway');
        const afterResult = run(after);

        await expect(failing).rejects.toThrow('boom');
        await expect(afterResult).resolves.toBe('ran anyway');
        expect(after).toHaveBeenCalled();
    });

    it('gives a rejection only to the caller whose task failed', async () => {
        const run = createQueue();

        const failing = run(() => Promise.reject(new Error('boom')));
        const healthy = run(() => Promise.resolve('fine'));

        await expect(failing).rejects.toThrow('boom');
        await expect(healthy).resolves.toBe('fine');
    });

    it('keeps separate queues independent', async () => {
        const runA = createQueue();
        const runB = createQueue();
        const blocked = deferred<void>();
        const taskB = vi.fn().mockResolvedValue('b');

        runA(() => blocked.promise);
        const resultB = runB(taskB);

        await expect(resultB).resolves.toBe('b');
        blocked.resolve();
    });
});
