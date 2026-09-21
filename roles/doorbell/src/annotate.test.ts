import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Jimp } from 'jimp';
import { annotate, drawBoxes, rawFramePath, resultPaths, writeResult } from './annotate.js';

// Tests run under TZ=America/Los_Angeles, so local components are deterministic.
const AT = new Date(2026, 8, 11, 14, 5, 9);

test('raw frame path is dated and timed', () => {
    assert.equal(rawFramePath('/frames', AT), '/frames/2026-09-11/140509.raw.jpg');
});

test('result paths carry the verdict on the annotated image only', () => {
    assert.deepEqual(resultPaths('/frames', AT, 'cat'), {
        annotated: '/frames/2026-09-11/140509-cat.jpg',
        json: '/frames/2026-09-11/140509.json',
    });
    assert.equal(resultPaths('/frames', AT, 'nocat').annotated, '/frames/2026-09-11/140509-nocat.jpg');
});

test('drawBoxes paints the four edges and nothing inside', () => {
    const painted = new Set<string>();
    const image = {
        width: 100,
        height: 100,
        setPixelColor: (_hex: number, x: number, y: number) => { painted.add(`${x},${y}`); },
    };

    drawBoxes(image, [{ xMin: 10, yMin: 10, xMax: 20, yMax: 20 }]);

    assert.ok(painted.has('10,10'));
    assert.ok(painted.has('20,20'));
    assert.ok(painted.has('15,10'));
    assert.ok(painted.has('10,15'));
    assert.ok(!painted.has('15,15'));
});

test('drawBoxes stays inside the image for an edge box', () => {
    const image = {
        width: 10,
        height: 10,
        setPixelColor: (_hex: number, x: number, y: number) => {
            assert.ok(x >= 0 && x < 10, `x out of bounds: ${x}`);
            assert.ok(y >= 0 && y < 10, `y out of bounds: ${y}`);
        },
    };

    drawBoxes(image, [{ xMin: 0, yMin: 0, xMax: 9, yMax: 9 }]);
});

test('annotate scales detections against the real frame size and returns a jpeg', async () => {
    const blank = new Jimp({ width: 100, height: 100, color: 0x000000ff });
    const raw = await blank.getBuffer('image/jpeg', { quality: 90 });

    const { buffer, boxes } = await annotate(raw, [{ label: 'cat', box_2d: [0, 0, 500, 500] }]);

    assert.deepEqual(boxes, [{ xMin: 0, yMin: 0, xMax: 50, yMax: 50 }]);
    assert.equal(buffer[0], 0xff);
    assert.equal(buffer[1], 0xd8);
});

test('writeResult creates the day directory and both files', async () => {
    const framesPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));

    await writeResult({
        framesPath,
        at: AT,
        verdict: 'cat',
        annotated: Buffer.from([0xff, 0xd8]),
        body: { detections: [] },
    });

    assert.ok(fs.existsSync(path.join(framesPath, '2026-09-11', '140509-cat.jpg')));
    const json = await fs.promises.readFile(path.join(framesPath, '2026-09-11', '140509.json'), 'utf-8');
    assert.deepEqual(JSON.parse(json), { detections: [] });
});

test('writeResult with no annotated image still writes the json', async () => {
    const framesPath = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));

    await writeResult({
        framesPath,
        at: AT,
        verdict: 'nocat',
        annotated: null,
        body: { error: 'lm studio unreachable' },
    });

    assert.ok(!fs.existsSync(path.join(framesPath, '2026-09-11', '140509-nocat.jpg')));
    assert.ok(fs.existsSync(path.join(framesPath, '2026-09-11', '140509.json')));
});
