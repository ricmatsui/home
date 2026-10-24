import assert from 'node:assert/strict';
import test from 'node:test';
import { AddressInfo } from 'node:net';
import { createSubmitServer } from './server.js';

async function listen(onBody: (body: unknown) => void | Promise<void>) {
    const server = createSubmitServer({ onBody });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    return {
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
}

test('answers 200 to a submission and hands over the parsed body', async (t) => {
    const bodies: unknown[] = [];
    const server = await listen((body) => { bodies.push(body); });
    t.after(server.close);

    const response = await fetch(`${server.url}/submit`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ timestamp: 'example', readings: { pm1: 2 } }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(bodies, [{ timestamp: 'example', readings: { pm1: 2 } }]);
});

test('answers 200 before the submission has been handled', async (t) => {
    const handled = { done: false };
    const release = Promise.withResolvers<void>();
    const server = await listen(async () => {
        await release.promise;
        handled.done = true;
    });
    t.after(server.close);

    const response = await fetch(`${server.url}/submit`, { method: 'POST', body: '{}' });

    assert.equal(response.status, 200);
    assert.equal(handled.done, false);
    release.resolve();
});

test('answers 200 to a body that is not JSON, and hands nothing over', async (t) => {
    const bodies: unknown[] = [];
    const server = await listen((body) => { bodies.push(body); });
    t.after(server.close);

    const response = await fetch(`${server.url}/submit`, { method: 'POST', body: 'not json' });

    assert.equal(response.status, 200);
    assert.deepEqual(bodies, []);
});

test('answers 404 to anything but a POST to /submit', async (t) => {
    const server = await listen(() => {});
    t.after(server.close);

    assert.equal((await fetch(`${server.url}/submit`)).status, 404);
    assert.equal((await fetch(`${server.url}/other`, { method: 'POST', body: '{}' })).status, 404);
});
