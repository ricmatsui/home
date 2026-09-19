import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderCache, computeEtag } from './cache.js';

function entry(html: string, mtimeMs: number, size: number) {
    return { mtimeMs, size, etag: computeEtag(html), html };
}

test('an etag is a quoted strong validator', () => {
    const etag = computeEtag('<p>x</p>');

    assert.match(etag, /^"[0-9a-f]+"$/);
});

test('identical html yields an identical etag', () => {
    assert.equal(computeEtag('<p>x</p>'), computeEtag('<p>x</p>'));
});

test('different html yields a different etag', () => {
    assert.notEqual(computeEtag('<p>x</p>'), computeEtag('<p>y</p>'));
});

test('returns a stored entry when mtime and size both match', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    const found = cache.get('/wiki/a.md', 100, 10);

    assert.notEqual(found, undefined);
    assert.equal(found?.html, '<p>a</p>');
});

test('returns undefined when the mtime has moved', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    assert.equal(cache.get('/wiki/a.md', 200, 10), undefined);
});

test('returns undefined when the size has changed', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    assert.equal(cache.get('/wiki/a.md', 100, 11), undefined);
});

test('returns undefined for a key that was never stored', () => {
    assert.equal(new RenderCache().get('/wiki/missing.md', 1, 1), undefined);
});

test('replacing a key does not grow the cache', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));
    cache.set('/wiki/a.md', entry('<p>b</p>', 200, 10));

    assert.equal(cache.size, 1);
    assert.equal(cache.get('/wiki/a.md', 200, 10)?.html, '<p>b</p>');
});

test('evicts the oldest entry past the cap', () => {
    const cache = new RenderCache(2);
    cache.set('/wiki/a.md', entry('<p>a</p>', 1, 1));
    cache.set('/wiki/b.md', entry('<p>b</p>', 1, 1));
    cache.set('/wiki/c.md', entry('<p>c</p>', 1, 1));

    assert.equal(cache.size, 2);
    assert.equal(cache.get('/wiki/a.md', 1, 1), undefined);
    assert.notEqual(cache.get('/wiki/b.md', 1, 1), undefined);
    assert.notEqual(cache.get('/wiki/c.md', 1, 1), undefined);
});
