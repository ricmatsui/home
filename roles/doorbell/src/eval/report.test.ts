import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ImageResult, RunFile, byDirectory, diffRuns, mcnemarExact, outcomeFor, score } from './metrics.js';
import { escapeHtml, renderCompare, renderReport, renderSheet } from './report.js';

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
        summary: { ...scores, totalMs: 4200, byDirectory: byDirectory(results, 0.5) },
        results,
    };
}

test('escapes the characters that would break out of markup', () => {
    assert.equal(escapeHtml('<img src="x" & \'y\'>'), '&lt;img src=&quot;x&quot; &amp; &#39;y&#39;&gt;');
});

test('the sheet lists every label with its current verdict and source path', () => {
    const html = renderSheet({ 'night/a.jpg': { cat: true, note: 'IR' }, 'b.jpg': { cat: false } });

    assert.match(html, /images\/night\/a\.jpg/);
    assert.match(html, /images\/b\.jpg/);
    assert.match(html, /IR/);
    assert.match(html, /<!doctype html>/i);
});

test('the sheet escapes paths and notes', () => {
    const html = renderSheet({ 'a.jpg': { cat: false, note: '<script>alert(1)</script>' } });

    assert.ok(!html.includes('<script>alert(1)</script>'));
    assert.match(html, /&lt;script&gt;/);
});

test('the report leads with false positives and false negatives', () => {
    const html = renderReport(run([
        result('tp.jpg', true, true),
        result('fp.jpg', false, true),
        result('fn.jpg', true, false),
        result('tn.jpg', false, false),
    ]));

    const order = ['False positives', 'False negatives', 'True positives', 'True negatives']
        .map((heading) => html.indexOf(heading));

    assert.ok(order.every((index) => index >= 0), 'every section should render');
    assert.deepEqual(order, [...order].sort((x, y) => x - y), 'sections should be in review order');
});

test('the report points at the annotated copy when there is one and the source otherwise', () => {
    const html = renderReport(run([result('night/fp.jpg', false, true), result('tn.jpg', false, false)]));

    assert.match(html, /night__fp\.jpg/);
    assert.match(html, /\.\.\/\.\.\/images\/tn\.jpg/);
});

test('the report renders a run with no failures at all', () => {
    const html = renderReport(run([result('a.jpg', false, false)]));

    assert.match(html, /True negatives/);
    assert.match(html, /<!doctype html>/i);
});

test('the report carries the per-directory table and the shas', () => {
    const html = renderReport(run([result('night/a.jpg', true, false), result('day/b.jpg', true, true)]));

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
    const html = renderReport({ ...run([result('a.jpg', false, false)]), concurrency: 4 });

    assert.match(html, /4 at a time/);
});

test('a run from before concurrency was settable says nothing about it', () => {
    const html = renderReport(run([result('a.jpg', false, false)]));

    assert.doesNotMatch(html, /at a time/);
});
