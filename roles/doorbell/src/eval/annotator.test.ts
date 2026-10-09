import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createAnnotatorServer } from './annotator.js';
import { Labels, imagesDir, loadLabels, writeLabels } from './corpus.js';

const BOX = { xMin: 120, yMin: 200, xMax: 260, yMax: 330 };

async function serve(labels: Labels, keys = Object.keys(labels)): Promise<{ url: string; dir: string; close: () => void }> {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));
    for (const key of Object.keys(labels)) {
        const file = path.join(imagesDir(dir), key);
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        await fs.promises.writeFile(file, `jpeg:${key}`);
    }
    await writeLabels(dir, labels);

    const server = createAnnotatorServer({ corpusDir: dir, keys });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    return { url: `http://127.0.0.1:${port}/`, dir, close: () => server.close() };
}

function post(url: string, body: unknown): Promise<Response> {
    return fetch(`${url}labels`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
    });
}

test('serves the annotator page for the selected keys', async () => {
    const { url, close } = await serve({ 'a/1.jpg': {}, 'b.jpg': {} }, ['a/1.jpg']);
    try {
        const response = await fetch(url);
        const html = await response.text();

        assert.equal(response.status, 200);
        assert.match(response.headers.get('content-type') ?? '', /text\/html/);
        assert.match(html, /"key":"a\/1\.jpg"/);
        assert.ok(!html.includes('"key":"b.jpg"'));
    } finally {
        close();
    }
});

test('serves a selected image from the corpus', async () => {
    const { url, close } = await serve({ '2026-09-11/160141.raw.jpg': {} });
    try {
        const response = await fetch(`${url}images/2026-09-11/160141.raw.jpg`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'image/jpeg');
        assert.equal(await response.text(), 'jpeg:2026-09-11/160141.raw.jpg');
    } finally {
        close();
    }
});

// Only keys the page was built from are served: nothing else on the mount, and
// nothing outside it, is reachable by editing the URL.
test('refuses an image outside the selection, and one outside the corpus', async () => {
    const { url, close } = await serve({ 'a.jpg': {}, 'b.jpg': {} }, ['a.jpg']);
    try {
        assert.equal((await fetch(`${url}images/b.jpg`)).status, 404);
        assert.equal((await fetch(`${url}images/..%2Flabels.json`)).status, 404);
    } finally {
        close();
    }
});

test('a save merges the boxes into labels.json and leaves other frames alone', async () => {
    const { url, dir, close } = await serve({
        'a.jpg': { cat: true, note: 'dusk' },
        'b.jpg': { cat: false },
        'c.jpg': { cat: true },
    });
    try {
        const response = await post(url, { boxes: { 'a.jpg': BOX, 'b.jpg': null } });

        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { saved: 2 });
        assert.deepEqual(await loadLabels(dir), {
            'a.jpg': { box: BOX, note: 'dusk' },
            'b.jpg': { box: null },
            'c.jpg': { cat: true },
        });
    } finally {
        close();
    }
});

// The file is re-read on every save, so a note added by hand while the page was
// open survives, and a second save builds on the first.
test('each save starts from labels.json as it is on disk', async () => {
    const { url, dir, close } = await serve({ 'a.jpg': {}, 'b.jpg': {} });
    try {
        await post(url, { boxes: { 'a.jpg': BOX } });
        await writeLabels(dir, { ...(await loadLabels(dir)), 'b.jpg': { note: 'by hand' } });
        await post(url, { boxes: { 'b.jpg': null } });

        assert.deepEqual(await loadLabels(dir), { 'a.jpg': { box: BOX }, 'b.jpg': { box: null, note: 'by hand' } });
    } finally {
        close();
    }
});

test('a malformed save is refused and writes nothing', async () => {
    const { url, dir, close } = await serve({ 'a.jpg': { cat: true }, 'b.jpg': { cat: true } });
    try {
        const bad = await post(url, { boxes: { 'a.jpg': BOX, 'b.jpg': { xMin: 5, yMin: 0, xMax: 1, yMax: 9 } } });
        const garbled = await post(url, '{"boxes":');

        assert.equal(bad.status, 400);
        assert.match((await bad.json()).error, /b\.jpg/);
        assert.equal(garbled.status, 400);
        assert.deepEqual(await loadLabels(dir), { 'a.jpg': { cat: true }, 'b.jpg': { cat: true } });
    } finally {
        close();
    }
});

test('a save naming a frame outside the selection is refused', async () => {
    const { url, close } = await serve({ 'a.jpg': {}, 'b.jpg': {} }, ['a.jpg']);
    try {
        const response = await post(url, { boxes: { 'b.jpg': null } });

        assert.equal(response.status, 400);
        assert.match((await response.json()).error, /b\.jpg/);
    } finally {
        close();
    }
});
