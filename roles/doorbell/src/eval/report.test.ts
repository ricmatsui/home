import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageResult, RunFile, byDirectory, diffHits, diffRuns, localize, mcnemarExact, outcomeFor, score } from './metrics.js';
import { escapeHtml, renderAnnotator, renderCompare, renderReport, renderSheet } from './report.js';

function result(image: string, expected: boolean, verdict: boolean | null): ImageResult {
    return {
        image,
        expected,
        verdict,
        outcome: verdict === null ? 'error' : outcomeFor(expected, verdict),
        detections: verdict ? [{ label: 'cat', box_2d: [0, 0, 10, 10] }] : [],
        annotated: verdict ? `${image.replace(/\//g, '__')}` : null,
        ms: 2100,
        error: verdict === null ? 'boom' : null,
    };
}

function run(results: ImageResult[], model = 'gemma-3-12b'): RunFile {
    const scores = score(results, 0.5);
    return {
        startedAt: '2026-09-11T18:04:00.000Z',
        model,
        baseUrl: 'ws://lm-studio.example.com:1234',
        prompt: 'find cats',
        promptSha: 'abc123',
        labelsSha: 'def456',
        corpus: { dir: '/c', images: results.length, positives: results.filter((r) => r.expected).length },
        summary: { ...scores, totalMs: 4200, byDirectory: byDirectory(results, 0.5), localization: localize(results) },
        results,
    };
}

test('escapes the characters that would break out of markup', () => {
    assert.equal(escapeHtml('<img src="x" & \'y\'>'), '&lt;img src=&quot;x&quot; &amp; &#39;y&#39;&gt;');
});

const BOX = { xMin: 120, yMin: 200, xMax: 260, yMax: 330 };

test('the sheet lists every label with its current verdict and source path', () => {
    const html = renderSheet({ 'night/a.jpg': { box: BOX, note: 'IR' }, 'b.jpg': { box: null } });

    assert.match(html, /images\/night\/a\.jpg/);
    assert.match(html, /images\/b\.jpg/);
    assert.match(html, /IR/);
    assert.match(html, /<!doctype html>/i);
});

test('the sheet marks an unlabelled image apart from nocat', () => {
    const html = renderSheet({ 'a.jpg': { cat: true }, 'b.jpg': { box: null } });

    assert.match(html, /class="unlabelled"[^]*\? unlabelled<br>a\.jpg/);
    assert.match(html, /— nocat<br>b\.jpg/);
    assert.match(html, /1 unlabelled/);
});

test('the sheet escapes paths and notes', () => {
    const html = renderSheet({ 'a.jpg': { box: null, note: '<script>alert(1)</script>' } });

    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
});

function annotatorData(html: string): unknown {
    const match = /<script type="application\/json" id="frames">([^]*?)<\/script>/.exec(html);
    assert.ok(match, 'the page embeds its frames as JSON');
    return JSON.parse(match[1] as string);
}

test('the annotator embeds each selected frame with its box and legacy verdict', () => {
    const html = renderAnnotator({
        'a.jpg': { box: BOX },
        'b.jpg': { cat: true },
        'c.jpg': { box: null },
        'd.jpg': {},
    }, ['a.jpg', 'b.jpg', 'c.jpg', 'd.jpg']);

    assert.deepEqual(annotatorData(html), [
        { key: 'a.jpg', box: BOX, hint: null },
        { key: 'b.jpg', box: null, hint: true },
        { key: 'c.jpg', box: null, hint: null },
        { key: 'd.jpg', box: null, hint: null },
    ]);
    assert.match(html, /<!doctype html>/i);
});

test('the annotator shows only the keys it was given, in that order', () => {
    const html = renderAnnotator({ 'a.jpg': {}, 'b.jpg': {}, 'c.jpg': {} }, ['c.jpg', 'a.jpg']);

    assert.deepEqual((annotatorData(html) as { key: string }[]).map((frame) => frame.key), ['c.jpg', 'a.jpg']);
});

// The keys are filenames off a shared mount: one holding "</script>" must not end
// the data block early and run the rest as markup.
test('the annotator cannot be broken out of by a key', () => {
    const key = '</script><script>alert(1)</script>.jpg';
    const html = renderAnnotator({ [key]: {} }, [key]);

    assert.ok(!html.includes('<script>alert(1)'));
    assert.deepEqual((annotatorData(html) as { key: string }[])[0]?.key, key);
});

test('the report leads with false positives and false negatives', () => {
    const html = renderReport(run([
        result('tp.jpg', true, true),
        result('fp.jpg', false, true),
        result('fn.jpg', true, false),
        result('tn.jpg', false, false),
    ]), 'r');

    const order = ['False positives', 'False negatives', 'True positives', 'True negatives']
        .map((heading) => html.indexOf(heading));

    assert.ok(order.every((index) => index >= 0), 'every section should render');
    assert.deepEqual(order, [...order].sort((x, y) => x - y), 'sections should be in review order');
});

test('the report shows the full prompt, escaped', () => {
    const html = renderReport({ ...run([result('tn.jpg', false, false)]), prompt: 'Find <cats>\nOutput JSON' }, 'r');

    assert.match(html, /<pre>Find &lt;cats&gt;\nOutput JSON<\/pre>/);
});

test('the report names the patterns a subset run was narrowed by', () => {
    const html = renderReport({ ...run([result('tn.jpg', false, false)]), only: ['2026-09-25/*'] }, 'r');

    assert.match(html, /only <code>2026-09-25\/\*<\/code>/);
});

test('the report points at the annotated copy when there is one and the source otherwise', () => {
    const html = renderReport(run([result('night/fp.jpg', false, true), result('tn.jpg', false, false)]), 'r');

    assert.match(html, /src="r\/night__fp\.jpg"/);
    assert.match(html, /src="\.\.\/images\/tn\.jpg"/);
});

test('the report renders a run with no failures at all', () => {
    const html = renderReport(run([result('a.jpg', false, false)]), 'r');

    assert.match(html, /True negatives/);
    assert.match(html, /<!doctype html>/i);
});

test('the report carries the per-directory table and the shas', () => {
    const html = renderReport(run([result('night/a.jpg', true, false), result('day/b.jpg', true, true)]), 'r');

    assert.match(html, /night/);
    assert.match(html, /day/);
    assert.match(html, /abc123/);
    assert.match(html, /def456/);
});

test('compare names a winner when the flips are lopsided', () => {
    const a = Array.from({ length: 16 }, (_, i) => result(`f${i}.jpg`, true, i >= 14));
    const b = Array.from({ length: 16 }, (_, i) => result(`f${i}.jpg`, true, i < 14));
    const diff = diffRuns(a, b);

    const text = renderCompare({
        a: run(a, 'A'),
        b: run(b, 'B'),
        diff,
        beta: 0.5,
        p: mcnemarExact(diff.fixed.length, diff.broke.length),
    });

    assert.match(text, /verdict: B better/);
    assert.match(text, /14 fixed \/ 2 broke/);
});

test('compare refuses to call a small difference a winner', () => {
    const a = [result('x.jpg', true, false), result('y.jpg', false, false), result('z.jpg', true, true)];
    const b = [result('x.jpg', true, true), result('y.jpg', false, true), result('z.jpg', true, true)];
    const diff = diffRuns(a, b);

    const text = renderCompare({ a: run(a, 'A'), b: run(b, 'B'), diff, beta: 0.5, p: mcnemarExact(1, 1) });

    assert.match(text, /no clear winner/);
    assert.match(text, /n too small to call/);
});

test('compare lists the flipped frames with their labels', () => {
    const a = [result('night/x.jpg', true, false)];
    const b = [result('night/x.jpg', true, true)];
    const diff = diffRuns(a, b);

    const text = renderCompare({ a: run(a, 'A'), b: run(b, 'B'), diff, beta: 0.5, p: mcnemarExact(1, 0) });

    assert.match(text, /night\/x\.jpg/);
    assert.match(text, /FN fixed/);
});

// Found by running two prompts against the same model: naming the model alone is
// ambiguous when both runs share it.
test('compare names the run slot, not just the model', () => {
    const a = Array.from({ length: 16 }, (_, i) => result(`f${i}.jpg`, true, i >= 14));
    const b = Array.from({ length: 16 }, (_, i) => result(`f${i}.jpg`, true, i < 14));
    const diff = diffRuns(a, b);

    const text = renderCompare({
        a: run(a, 'same-model'),
        b: run(b, 'same-model'),
        diff,
        beta: 0.5,
        p: mcnemarExact(diff.fixed.length, diff.broke.length),
    });

    assert.match(text, /verdict: B better \(same-model\)/);
});

// On an all-negative corpus no true positive is possible, so F-beta is structurally
// zero for both runs and its delta cannot point anywhere. The flips still can.
test('the winner comes from the flips when the f-beta delta is degenerate', () => {
    const a = Array.from({ length: 40 }, (_, i) => result(`f${i}.jpg`, false, false));
    const b = Array.from({ length: 40 }, (_, i) => result(`f${i}.jpg`, false, true));
    const diff = diffRuns(a, b);

    const text = renderCompare({
        a: run(a, 'A'),
        b: run(b, 'B'),
        diff,
        beta: 0.5,
        p: mcnemarExact(diff.fixed.length, diff.broke.length),
    });

    assert.equal(run(a).summary.fbeta, 0);
    assert.equal(run(b).summary.fbeta, 0);
    assert.match(text, /verdict: A better/);
    assert.match(text, /0 fixed \/ 40 broke/);
});

test('the report says how many frames were in flight, so timings can be read', () => {
    const html = renderReport({ ...run([result('a.jpg', false, false)]), concurrency: 4 }, 'r');

    assert.match(html, /4 at a time/);
});

test('a run from before concurrency was settable says nothing about it', () => {
    const html = renderReport(run([result('a.jpg', false, false)]), 'r');

    assert.doesNotMatch(html, /at a time/);
});

test('the report and the compare header name the upscale a run sent at', () => {
    const results = [result('a.jpg', false, false)];
    const html = renderReport({ ...run(results), upscale: 1.78125 }, 'r');
    const text = renderCompare({
        a: { ...run(results), upscale: 2 },
        b: { ...run(results), upscale: 1.78125 },
        diff: diffRuns(results, results),
        beta: 0.5,
        p: 1,
    });

    assert.match(html, /1\.78125× upscale/);
    assert.match(text, /^A .*2× upscale$/m);
    assert.match(text, /^B .*1\.78125× upscale$/m);
});

const TRUTH = { xMin: 100, yMin: 100, xMax: 200, yMax: 200 };
const HIGH = { xMin: 100, yMin: 60, xMax: 200, yMax: 160 };

function boxed(image: string, truth: typeof TRUTH | null, boxes: (typeof TRUTH)[]): ImageResult {
    return { ...result(image, truth !== null, boxes.length > 0), truth, boxes };
}

test('the report scores localization when the run carries boxes', () => {
    const html = renderReport(run([boxed('a.jpg', TRUTH, [TRUTH]), boxed('b.jpg', TRUTH, [HIGH]), boxed('c.jpg', null, [])]), 'r');

    assert.match(html, /hit@0\.5 1\/2/);
    assert.match(html, /mean IoU 0\.714/);
    assert.match(html, /centre offset dx \+0\.0 dy -20\.0px/);
});

test('the report says nothing of localization for a run from before boxes', () => {
    const html = renderReport(run([result('a.jpg', true, true)]), 'r');

    assert.ok(!html.includes('hit@'));
});

test('the report captions a cat frame with its best overlap', () => {
    const html = renderReport(run([boxed('a.jpg', TRUTH, [HIGH]), boxed('b.jpg', TRUTH, [])]), 'r');

    assert.match(html, /a\.jpg<br>cat · IoU 0\.43/);
    assert.match(html, /b\.jpg<br>— · IoU 0\.00/);
});

test('compare scores localization side by side, with its own McNemar verdict', () => {
    const a = [boxed('x.jpg', TRUTH, [HIGH]), boxed('y.jpg', TRUTH, [HIGH])];
    const b = [boxed('x.jpg', TRUTH, [TRUTH]), boxed('y.jpg', TRUTH, [HIGH])];
    const diff = diffRuns(a, b);
    const hits = diffHits(a, b);

    const text = renderCompare({
        a: run(a, 'A'),
        b: run(b, 'B'),
        diff,
        beta: 0.5,
        p: mcnemarExact(diff.fixed.length, diff.broke.length),
        hits: { ...hits, p: mcnemarExact(hits.fixed.length, hits.broke.length) },
    });

    assert.match(text, /A +hit@0\.5 +0\/2/);
    assert.match(text, /B +hit@0\.5 +1\/2/);
    assert.match(text, /located +fixed 1 +broke 0 +unchanged 1/);
    assert.match(text, /\+ x\.jpg/);
    assert.match(text, /mean IoU change \+0\.286/);
    assert.match(text, /McNemar p=1\.0000/);
});

test('compare leaves localization out when either run has none', () => {
    const a = [result('x.jpg', true, true)];
    const diff = diffRuns(a, a);

    const text = renderCompare({ a: run(a, 'A'), b: run(a, 'B'), diff, beta: 0.5, p: 1 });

    assert.ok(!text.includes('hit@'));
});
