import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    Labels,
    imagesDir,
    labelsPath,
    labelsSha,
    loadLabels,
    mergeLabels,
    walkImages,
    writeLabels,
} from './corpus.js';

async function corpus(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));
}

async function write(file: string, body = 'x'): Promise<void> {
    await fs.promises.mkdir(path.dirname(file), { recursive: true });
    await fs.promises.writeFile(file, body);
}

test('walks nested directories and returns posix relative paths', async () => {
    const dir = await corpus();
    await write(path.join(dir, '2026-09-11', '160141.raw.jpg'));
    await write(path.join(dir, 'night', 'porch-ir-03.jpg'));
    await write(path.join(dir, 'top.png'));

    assert.deepEqual(await walkImages(dir), [
        '2026-09-11/160141.raw.jpg',
        'night/porch-ir-03.jpg',
        'top.png',
    ]);
});

test('takes only image extensions, case-insensitively', async () => {
    const dir = await corpus();
    await write(path.join(dir, 'a.JPG'));
    await write(path.join(dir, 'b.jpeg'));
    await write(path.join(dir, 'c.png'));
    await write(path.join(dir, 'notes.txt'));
    await write(path.join(dir, '160141.json'));

    assert.deepEqual(await walkImages(dir), ['a.JPG', 'b.jpeg', 'c.png']);
});

// macOS leaves these beside real files on network and external volumes; handing
// one to the model as an image is a confusing failure, not an obvious one.
test('skips dotfiles and AppleDouble siblings', async () => {
    const dir = await corpus();
    await write(path.join(dir, 'real.jpg'));
    await write(path.join(dir, '._real.jpg'));
    await write(path.join(dir, '.DS_Store'));
    await write(path.join(dir, '._.DS_Store'));
    await write(path.join(dir, '.hidden', 'inside.jpg'));

    assert.deepEqual(await walkImages(dir), ['real.jpg']);
});

test('follows a symlinked subdirectory', async () => {
    const dir = await corpus();
    const outside = await corpus();
    await write(path.join(outside, '160141.raw.jpg'));
    await fs.promises.symlink(outside, path.join(dir, 'linked'));

    assert.deepEqual(await walkImages(dir), ['linked/160141.raw.jpg']);
});

test('a symlink cycle terminates instead of recursing forever', async () => {
    const dir = await corpus();
    await write(path.join(dir, 'a.jpg'));
    await fs.promises.symlink(dir, path.join(dir, 'loop'));

    assert.deepEqual(await walkImages(dir), ['a.jpg']);
});

test('a broken symlink is skipped', async () => {
    const dir = await corpus();
    await write(path.join(dir, 'a.jpg'));
    await fs.promises.symlink(path.join(dir, 'gone.jpg'), path.join(dir, 'dangling.jpg'));

    assert.deepEqual(await walkImages(dir), ['a.jpg']);
});

test('merge preserves existing labels and adds new files as false', () => {
    const existing: Labels = { 'a.jpg': { cat: true, note: 'on the mat' } };

    const merged = mergeLabels(existing, ['a.jpg', 'b.jpg']);

    assert.deepEqual(merged.labels, {
        'a.jpg': { cat: true, note: 'on the mat' },
        'b.jpg': { cat: false },
    });
    assert.deepEqual(merged.added, ['b.jpg']);
    assert.deepEqual(merged.orphaned, []);
});

test('merge keeps labels whose image is gone and reports them', () => {
    const merged = mergeLabels({ 'gone.jpg': { cat: true }, 'a.jpg': { cat: false } }, ['a.jpg']);

    assert.deepEqual(merged.orphaned, ['gone.jpg']);
    assert.equal(merged.labels['gone.jpg']?.cat, true);
});

test('merge does not mutate the labels it was given', () => {
    const existing: Labels = { 'a.jpg': { cat: true } };

    mergeLabels(existing, ['a.jpg', 'b.jpg']);

    assert.deepEqual(existing, { 'a.jpg': { cat: true } });
});

test('labels round-trip through disk sorted by key', async () => {
    const dir = await corpus();

    await writeLabels(dir, { 'b.jpg': { cat: false }, 'a.jpg': { cat: true, note: 'dusk' } });

    const body = await fs.promises.readFile(labelsPath(dir), 'utf-8');
    assert.ok(body.indexOf('"a.jpg"') < body.indexOf('"b.jpg"'), 'keys should be sorted');
    assert.deepEqual(await loadLabels(dir), { 'a.jpg': { cat: true, note: 'dusk' }, 'b.jpg': { cat: false } });
});

test('loading a corpus with no labels file yields an empty set', async () => {
    assert.deepEqual(await loadLabels(await corpus()), {});
});

test('the labels sha ignores key order but not values', () => {
    const one = labelsSha({ 'a.jpg': { cat: true }, 'b.jpg': { cat: false } });
    const two = labelsSha({ 'b.jpg': { cat: false }, 'a.jpg': { cat: true } });
    const three = labelsSha({ 'a.jpg': { cat: false }, 'b.jpg': { cat: false } });

    assert.equal(one, two);
    assert.notEqual(one, three);
});

// The note is documentation for a human, not ground truth; a re-worded note must
// not make an old run look like it scored against different labels.
test('the labels sha ignores notes', () => {
    assert.equal(labelsSha({ 'a.jpg': { cat: true } }), labelsSha({ 'a.jpg': { cat: true, note: 'dusk' } }));
});

test('image and labels paths sit under the corpus directory', () => {
    assert.equal(imagesDir('/c'), path.join('/c', 'images'));
    assert.equal(labelsPath('/c'), path.join('/c', 'labels.json'));
});
