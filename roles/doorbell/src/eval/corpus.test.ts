import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    Labels,
    applyBoxes,
    hasCat,
    imagesDir,
    labelsPath,
    labelsSha,
    loadLabels,
    mergeLabels,
    pendingLabels,
    selectKeys,
    walkImages,
    writeLabels,
} from './corpus.js';

const BOX = { xMin: 120, yMin: 200, xMax: 260, yMax: 330 };

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

test('merge preserves existing labels and adds new files as unlabelled', () => {
    const existing: Labels = { 'a.jpg': { box: BOX, note: 'on the mat' } };

    const merged = mergeLabels(existing, ['a.jpg', 'b.jpg']);

    assert.deepEqual(merged.labels, {
        'a.jpg': { box: BOX, note: 'on the mat' },
        'b.jpg': {},
    });
    assert.deepEqual(merged.added, ['b.jpg']);
    assert.deepEqual(merged.orphaned, []);
});

test('merge keeps labels whose image is gone and reports them', () => {
    const merged = mergeLabels({ 'gone.jpg': { box: BOX }, 'a.jpg': { box: null } }, ['a.jpg']);

    assert.deepEqual(merged.orphaned, ['gone.jpg']);
    assert.deepEqual(merged.labels['gone.jpg']?.box, BOX);
});

test('merge does not mutate the labels it was given', () => {
    const existing: Labels = { 'a.jpg': { box: BOX } };

    mergeLabels(existing, ['a.jpg', 'b.jpg']);

    assert.deepEqual(existing, { 'a.jpg': { box: BOX } });
});

// A legacy `cat` verdict is a hint for the annotator, not a label: until a box (or
// null) is drawn, the frame has not been localised and cannot be scored.
test('pendingLabels lists every key without a box or an explicit null, and none that has one', () => {
    const labels: Labels = {
        'b.jpg': { cat: true },
        'a.jpg': {},
        'c.jpg': { box: null },
        'd.jpg': { box: BOX },
        'e.jpg': { box: { xMin: 1 } as unknown as typeof BOX },
    };

    assert.deepEqual(pendingLabels(labels), ['a.jpg', 'b.jpg', 'e.jpg']);
});

test('a label has a cat exactly when it has a box', () => {
    assert.equal(hasCat({ box: BOX }), true);
    assert.equal(hasCat({ box: null }), false);
    assert.equal(hasCat({ cat: true }), false);
});

test('labels round-trip through disk sorted by key', async () => {
    const dir = await corpus();

    await writeLabels(dir, { 'b.jpg': { box: null }, 'a.jpg': { box: BOX, note: 'dusk' } });

    const body = await fs.promises.readFile(labelsPath(dir), 'utf-8');
    assert.ok(body.indexOf('"a.jpg"') < body.indexOf('"b.jpg"'), 'keys should be sorted');
    assert.deepEqual(await loadLabels(dir), { 'a.jpg': { box: BOX, note: 'dusk' }, 'b.jpg': { box: null } });
});

test('loading a corpus with no labels file yields an empty set', async () => {
    assert.deepEqual(await loadLabels(await corpus()), {});
});

test('the labels sha ignores key order but not boxes', () => {
    const one = labelsSha({ 'a.jpg': { box: BOX }, 'b.jpg': { box: null } });
    const two = labelsSha({ 'b.jpg': { box: null }, 'a.jpg': { box: BOX } });
    const moved = labelsSha({ 'a.jpg': { box: { ...BOX, yMin: BOX.yMin + 1 } }, 'b.jpg': { box: null } });
    const cleared = labelsSha({ 'a.jpg': { box: null }, 'b.jpg': { box: null } });

    assert.equal(one, two);
    assert.notEqual(one, moved);
    assert.notEqual(one, cleared);
});

// The note is documentation for a human, not ground truth; a re-worded note must
// not make an old run look like it scored against different labels.
test('the labels sha ignores notes', () => {
    assert.equal(labelsSha({ 'a.jpg': { box: BOX } }), labelsSha({ 'a.jpg': { box: BOX, note: 'dusk' } }));
});

test('applying boxes sets each one, drops the legacy verdict and keeps the note', () => {
    const labels: Labels = {
        'a.jpg': { cat: true, note: 'dusk' },
        'b.jpg': { cat: true },
        'c.jpg': { cat: false },
    };

    const applied = applyBoxes(labels, { 'a.jpg': BOX, 'b.jpg': null });

    assert.deepEqual(applied, {
        'a.jpg': { box: BOX, note: 'dusk' },
        'b.jpg': { box: null },
        'c.jpg': { cat: false },
    });
    assert.deepEqual(labels['a.jpg'], { cat: true, note: 'dusk' }, 'the input is not mutated');
});

test('applying boxes rounds coordinates to whole pixels', () => {
    const applied = applyBoxes({ 'a.jpg': {} }, { 'a.jpg': { xMin: 10.4, yMin: 20.6, xMax: 30, yMax: 40 } });

    assert.deepEqual(applied['a.jpg']?.box, { xMin: 10, yMin: 21, xMax: 30, yMax: 40 });
});

test('applying a box to a key with no label is refused', () => {
    assert.throws(() => applyBoxes({}, { 'nope.jpg': BOX }), /nope\.jpg/);
});

test('applying a malformed box is refused', () => {
    const labels: Labels = { 'a.jpg': {} };
    const bad = [
        { xMin: 10, yMin: 10, xMax: 5, yMax: 20 },
        { xMin: -1, yMin: 0, xMax: 5, yMax: 5 },
        { xMin: 0, yMin: 0, xMax: 5 },
        { xMin: '0', yMin: 0, xMax: 5, yMax: 5 },
        [0, 0, 5, 5],
    ];

    for (const box of bad) {
        assert.throws(() => applyBoxes(labels, { 'a.jpg': box as unknown as typeof BOX }), /a\.jpg/, JSON.stringify(box));
    }
});

test('image and labels paths sit under the corpus directory', () => {
    assert.equal(imagesDir('/c'), path.join('/c', 'images'));
    assert.equal(labelsPath('/c'), path.join('/c', 'labels.json'));
});

test('no patterns selects every key', () => {
    assert.deepEqual(selectKeys(['a.jpg', 'b/c.jpg'], []), { selected: ['a.jpg', 'b/c.jpg'], unmatched: [] });
});

test('selects by exact path or glob, keeping corpus order', () => {
    const keys = ['2026-09-11/a.raw.jpg', '2026-09-25/b.raw.jpg', '2026-09-25/c.raw.jpg', 'night/d.jpg'];

    assert.deepEqual(selectKeys(keys, ['night/d.jpg', '2026-09-25/*']).selected,
        ['2026-09-25/b.raw.jpg', '2026-09-25/c.raw.jpg', 'night/d.jpg']);
});

test('a key matched by two patterns is selected once', () => {
    assert.deepEqual(selectKeys(['x/a.jpg'], ['x/*', 'x/a.jpg']).selected, ['x/a.jpg']);
});

test('reports patterns that match nothing', () => {
    assert.deepEqual(selectKeys(['x/a.jpg'], ['x/*', 'y/*']).unmatched, ['y/*']);
});
