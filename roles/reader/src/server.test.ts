import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from './server.js';

async function withServer(
    files: Record<string, string>,
    run: (base: string, dir: string) => Promise<void>,
): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-'));

    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content);
    }

    const server = createServer({ wikiPath: dir });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run(`http://127.0.0.1:${port}`, dir);
    } finally {
        await new Promise<void>(resolve => {
            server.close(() => resolve());
        });
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const INDEX = '---\ntitle: Index\n---\n\n[A note](220306-0621)\n';
const NOTE = '---\ntitle: A note\n---\n\n- [ ] 2027-01-23\n';

test('serves index.md at the root', async () => {
    await withServer({ 'index.md': INDEX, '220306-0621.md': NOTE }, async base => {
        const response = await fetch(`${base}/`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.match(await response.text(), /<h1>Index<\/h1>/);
    });
});

test('serves a note by id', async () => {
    await withServer({ 'index.md': INDEX, '220306-0621.md': NOTE }, async base => {
        const response = await fetch(`${base}/220306-0621`);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /<h1>A note<\/h1>/);
    });
});

test('sends no-cache, an etag and a last-modified header', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`);
        await response.text();

        assert.equal(response.headers.get('cache-control'), 'no-cache');
        assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
        assert.notEqual(response.headers.get('last-modified'), null);
    });
});

test('answers a matching if-none-match with an empty 304', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        const second = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });

        assert.equal(second.status, 304);
        assert.equal(second.headers.get('etag'), etag);
        assert.equal(second.headers.get('cache-control'), 'no-cache');
        assert.equal(await second.text(), '');
    });
});

test('handles a weak validator and a list of etags', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        const weak = await fetch(`${base}/`, {
            headers: { 'if-none-match': `W/${etag}` },
        });
        await weak.text();
        assert.equal(weak.status, 304);

        const list = await fetch(`${base}/`, {
            headers: { 'if-none-match': `"other", ${etag}` },
        });
        await list.text();
        assert.equal(list.status, 304);
    });
});

test('serves 200 again once the file changes on disk', async () => {
    await withServer({ 'index.md': INDEX }, async (base, dir) => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        await fs.writeFile(
            path.join(dir, 'index.md'),
            '---\ntitle: Index\n---\n\nchanged\n',
        );

        const second = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });

        assert.equal(second.status, 200);
        assert.notEqual(second.headers.get('etag'), etag);
        assert.match(await second.text(), /changed/);
    });
});

test('404s a note that does not exist', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/260101-0000`);

        assert.equal(response.status, 404);
        assert.match(await response.text(), /Not found/);
    });
});

test('404s a traversal attempt rather than reading outside the wiki', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
        await response.text();

        assert.equal(response.status, 404);
    });
});

test('404s a dotted path so .git and .sync stay unreachable', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/.git`);
        await response.text();

        assert.equal(response.status, 404);
    });
});

test('rejects a non-GET method', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`, { method: 'POST' });
        await response.text();

        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
    });
});

test('a HEAD request carries the headers but no body', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`, { method: 'HEAD' });

        assert.equal(response.status, 200);
        assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
        assert.equal(await response.text(), '');
    });
});

test('ignores a query string when resolving the note', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/?v=1`);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /<h1>Index<\/h1>/);
    });
});
