import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    ImageResult,
    byDirectory,
    diffRuns,
    mcnemarExact,
    outcomeFor,
    score,
    sha,
} from './metrics.js';

function result(image: string, expected: boolean, verdict: boolean | null, ms = 10): ImageResult {
    return {
        image,
        expected,
        verdict,
        outcome: verdict === null ? 'error' : outcomeFor(expected, verdict),
        detections: [],
        annotated: null,
        ms,
        error: verdict === null ? 'lm studio unreachable' : null,
    };
}

test('outcomes name the four quadrants', () => {
    assert.equal(outcomeFor(true, true), 'tp');
    assert.equal(outcomeFor(false, true), 'fp');
    assert.equal(outcomeFor(true, false), 'fn');
    assert.equal(outcomeFor(false, false), 'tn');
});

test('scores the worked example from the spec', () => {
    const results = [
        ...Array.from({ length: 22 }, (_, i) => result(`tp${i}.jpg`, true, true)),
        ...Array.from({ length: 3 }, (_, i) => result(`fp${i}.jpg`, false, true)),
        ...Array.from({ length: 2 }, (_, i) => result(`fn${i}.jpg`, true, false)),
        ...Array.from({ length: 76 }, (_, i) => result(`tn${i}.jpg`, false, false)),
    ];

    const scores = score(results, 0.5);

    assert.deepEqual(
        { tp: scores.tp, fp: scores.fp, fn: scores.fn, tn: scores.tn, errors: scores.errors },
        { tp: 22, fp: 3, fn: 2, tn: 76, errors: 0 },
    );
    assert.equal(scores.precision.toFixed(3), '0.880');
    assert.equal(scores.recall.toFixed(3), '0.917');
    assert.equal(scores.f1.toFixed(3), '0.898');
    assert.equal(scores.fbeta.toFixed(3), '0.887');
    assert.equal(scores.beta, 0.5);
});

// The whole reason beta defaults below 1: a false positive holds the sensor wrong
// for ~90s, a false negative is usually absorbed by the latch or the next frame.
test('beta below one punishes a false positive harder than a false negative', () => {
    const oneFalsePositive = [result('a.jpg', true, true), result('b.jpg', false, true)];
    const oneFalseNegative = [result('a.jpg', true, true), result('c.jpg', true, false)];

    assert.ok(score(oneFalsePositive, 0.5).fbeta < score(oneFalseNegative, 0.5).fbeta);
    assert.ok(score(oneFalsePositive, 1).f1 === score(oneFalseNegative, 1).f1);
});

test('an error is excluded from the matrix rather than counted as a negative', () => {
    const scores = score([result('a.jpg', true, true), result('b.jpg', true, null)], 0.5);

    assert.equal(scores.errors, 1);
    assert.equal(scores.fn, 0);
    assert.equal(scores.recall, 1);
});

test('degenerate corpora score zero rather than NaN', () => {
    const noPredictions = score([result('a.jpg', true, false)], 0.5);
    assert.equal(noPredictions.precision, 0);
    assert.equal(noPredictions.f1, 0);
    assert.equal(noPredictions.fbeta, 0);

    const noPositives = score([result('a.jpg', false, false)], 0.5);
    assert.equal(noPositives.recall, 0);
    assert.equal(noPositives.fbeta, 0);

    assert.equal(score([], 0.5).f1, 0);
});

test('per-directory rollup splits by the leading path segment', () => {
    const results = [
        result('2026-09-11/a.jpg', true, true),
        result('2026-09-11/b.jpg', false, false),
        result('night/c.jpg', true, false),
        result('top.jpg', false, false),
    ];

    const rollup = byDirectory(results, 0.5);

    assert.deepEqual(Object.keys(rollup).sort(), ['2026-09-11', '.', 'night'].sort());
    assert.equal(rollup['2026-09-11']?.tp, 1);
    assert.equal(rollup['night']?.fn, 1);
    assert.equal(rollup['night']?.recall, 0);
    assert.equal(rollup['.']?.tn, 1);
});

test('the diff separates fixed from broken and counts the rest', () => {
    const a = [
        result('fixed.jpg', true, false),
        result('broke.jpg', false, false),
        result('same.jpg', true, true),
    ];
    const b = [
        result('fixed.jpg', true, true),
        result('broke.jpg', false, true),
        result('same.jpg', true, true),
    ];

    const diff = diffRuns(a, b);

    assert.deepEqual(diff.fixed.map((flip) => flip.image), ['fixed.jpg']);
    assert.deepEqual(diff.broke.map((flip) => flip.image), ['broke.jpg']);
    assert.equal(diff.unchanged, 1);
    assert.equal(diff.excluded, 0);
});

test('an image either run failed on is excluded from the diff', () => {
    const diff = diffRuns([result('a.jpg', true, null)], [result('a.jpg', true, true)]);

    assert.equal(diff.excluded, 1);
    assert.equal(diff.fixed.length, 0);
    assert.equal(diff.unchanged, 0);
});

test('mcnemar exact matches hand-computed two-sided p-values', () => {
    assert.equal(mcnemarExact(14, 2).toFixed(4), '0.0042');
    assert.equal(mcnemarExact(3, 1).toFixed(4), '0.6250');
    assert.equal(mcnemarExact(1, 0).toFixed(4), '1.0000');
});

test('mcnemar with no disagreement is p=1, not NaN', () => {
    assert.equal(mcnemarExact(0, 0), 1);
});

test('mcnemar is symmetric and never exceeds 1', () => {
    assert.equal(mcnemarExact(2, 14), mcnemarExact(14, 2));
    assert.ok(mcnemarExact(5, 5) <= 1);
});

test('sha is stable and differs on different input', () => {
    assert.equal(sha('a'), sha('a'));
    assert.notEqual(sha('a'), sha('b'));
    assert.equal(sha('a').length, 64);
});
