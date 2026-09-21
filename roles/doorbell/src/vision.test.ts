import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import {
    PROMPT,
    detectionsSchema,
    hasCat,
    once,
    parseDetections,
    promptFor,
    scaleBox,
    upscale,
} from './vision.js';

test('scales a full-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 1000, 1000], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('scales a half-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 500, 500], 512, 384), { xMin: 0, yMin: 0, xMax: 256, yMax: 192 });
});

test('reads the coordinates y first, as gemma reports them', () => {
    // [ymin, xmin, ymax, xmax]: the full height of the frame, the left half of it.
    assert.deepEqual(scaleBox([0, 0, 1000, 500], 512, 384), { xMin: 0, yMin: 0, xMax: 256, yMax: 383 });
});

test('clamps coordinates beyond the 0-1000 scale', () => {
    assert.deepEqual(scaleBox([-50, -50, 1200, 1200], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('normalises an inverted box', () => {
    const box = scaleBox([800, 800, 200, 200], 1000, 1000);

    assert.equal(box.xMin, 200);
    assert.equal(box.xMax, 800);
    assert.equal(box.yMin, 200);
    assert.equal(box.yMax, 800);
});

test('hasCat is true for any cat label regardless of case', () => {
    assert.equal(hasCat([{ label: 'Cat', box_2d: [0, 0, 1, 1] }]), true);
    assert.equal(hasCat([{ label: 'cat', box_2d: [0, 0, 1, 1] }]), true);
});

test('hasCat is false for an empty list', () => {
    assert.equal(hasCat([]), false);
});

test('hasCat is false when nothing is a cat', () => {
    assert.equal(hasCat([{ label: 'dog', box_2d: [0, 0, 1, 1] }]), false);
});

test('hasCat matches the label exactly, so a word merely containing cat is not one', () => {
    assert.equal(hasCat([{ label: 'caterpillar', box_2d: [0, 0, 1, 1] }]), false);
    assert.equal(hasCat([{ label: 'cat toy', box_2d: [0, 0, 1, 1] }]), false);
    assert.equal(hasCat([{ label: ' cat ', box_2d: [0, 0, 1, 1] }]), true);
});

test('the schema accepts a well-formed response', () => {
    const parsed = detectionsSchema.parse([{ label: 'cat', box_2d: [10, 20, 30, 40] }]);

    assert.equal(parsed[0].label, 'cat');
    assert.deepEqual(parsed[0].box_2d, [10, 20, 30, 40]);
});

test('the schema rejects a short bbox', () => {
    assert.throws(() => detectionsSchema.parse([{ label: 'cat', box_2d: [10, 20, 30] }]));
});

test('the prompt defaults to the shipped one', () => {
    assert.equal(promptFor(undefined), PROMPT);
});

test('an explicit prompt overrides the shipped one', () => {
    assert.equal(promptFor('find dogs'), 'find dogs');
});

test('an empty prompt falls back rather than asking the model nothing', () => {
    assert.equal(promptFor(''), PROMPT);
});

test('parses a bare JSON array', () => {
    const parsed = parseDetections('[{"label": "cat", "box_2d": [10, 20, 30, 40]}]');

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].label, 'cat');
});

test('keeps the coordinates exactly as the model reported them', () => {
    const parsed = parseDetections('[{"label": "cat", "box_2d": [100, 200, 300, 400]}]');

    assert.deepEqual(parsed[0].box_2d, [100, 200, 300, 400]);
});

test('rejects bbox_2d, the key gemma sometimes writes instead of box_2d', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "bbox_2d": [100, 200, 300, 400]}]'), /no JSON/);
});

test('throws when a detection carries no box at all', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "coords": [1, 2, 3, 4]}]'), /no JSON/);
});

test('parses an empty list', () => {
    assert.deepEqual(parseDetections('[]'), []);
});

test('parses a fenced JSON block', () => {
    const text = 'Here is the result:\n```json\n[{"label": "cat", "box_2d": [1, 2, 3, 4]}]\n```\n';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [1, 2, 3, 4] }]);
});

test('parses JSON that follows prose', () => {
    const text = 'I can see one cat on the step [it is sitting].\n[{"label": "cat", "box_2d": [5, 6, 7, 8]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [5, 6, 7, 8] }]);
});

test('ignores an array inside a think block', () => {
    const text = '<think>maybe [{"label": "dog", "box_2d": [0, 0, 1, 1]}] is right</think>\n' +
        '[{"label": "cat", "box_2d": [9, 9, 9, 9]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [9, 9, 9, 9] }]);
});

test('ignores brackets inside a JSON string value', () => {
    const text = '[{"label": "cat [tabby]", "box_2d": [1, 2, 3, 4]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat [tabby]', box_2d: [1, 2, 3, 4] }]);
});

test('throws when the response contains no JSON at all', () => {
    assert.throws(() => parseDetections('I am unable to look at images.'), /no JSON/);
});

test('throws when the JSON does not match the schema', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "box_2d": [10, 20, 30]}]'), /no JSON/);
});

test('the parse error quotes what the model said', () => {
    assert.throws(() => parseDetections('sorry, no cats today'), /sorry, no cats today/);
});

test('the prompt asks for the key and order gemma actually emits', () => {
    assert.match(PROMPT, /box_2d/);
    assert.match(PROMPT, /ymin, xmin, ymax, xmax/);
});

test('upscale multiplies both dimensions', async () => {
    const source = await new Jimp({ width: 8, height: 6, color: 0xff0000ff }).getBuffer('image/jpeg');
    const bigger = await Jimp.fromBuffer(await upscale(source, 2));

    assert.equal(bigger.width, 16);
    assert.equal(bigger.height, 12);
});

test('upscale leaves the image readable', async () => {
    const source = await new Jimp({ width: 8, height: 6, color: 0xff0000ff }).getBuffer('image/jpeg');
    const bigger = await Jimp.fromBuffer(await upscale(source, 2));
    const pixel = bigger.getPixelColor(8, 6);

    // Still a red frame in the middle. Exact equality would be testing JPEG, which
    // comes back a point or two short of 0xff however little the resampling did.
    assert.ok((pixel >>> 24) > 0xf0, `red channel ${pixel >>> 24}`);
    assert.ok(((pixel >>> 16) & 0xff) < 0x10, `green channel ${(pixel >>> 16) & 0xff}`);
});

test('once runs the factory a single time for concurrent callers', async () => {
    let calls = 0;
    const load = once(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'model';
    });

    const [first, second] = await Promise.all([load(), load()]);

    assert.equal(calls, 1);
    assert.equal(first, 'model');
    assert.equal(second, 'model');
});

test('once keeps returning the first result', async () => {
    let calls = 0;
    const load = once(async () => `model ${(calls += 1)}`);

    assert.equal(await load(), 'model 1');
    assert.equal(await load(), 'model 1');
});

test('once retries after a failure rather than caching it forever', async () => {
    let calls = 0;
    const load = once(async () => {
        calls += 1;
        if (calls === 1) throw new Error('lm studio is down');
        return 'model';
    });

    await assert.rejects(load(), /lm studio is down/);
    assert.equal(await load(), 'model');
});

test('once can be reset, so a dead handle is not cached forever', async () => {
    let calls = 0;
    const load = once(async () => `model ${(calls += 1)}`);

    assert.equal(await load(), 'model 1');
    load.reset();

    assert.equal(await load(), 'model 2');
});
