# Doorbell Eval Harness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local `yarn eval` CLI in `roles/doorbell` that scores a folder of images through the service's real detection path against hand-written labels, and compares two runs with a significance-aware verdict.

**Architecture:** Four new modules under `roles/doorbell/src/eval/`. Three are pure and unit-tested (`corpus.ts` walks images and manages labels, `metrics.ts` scores and diffs, `report.ts` renders HTML and text); `cli.ts` is the thin impure shell that parses args, calls the real `createVisionClient()` from `vision.ts`, and writes files. The vision client is deliberately not mocked — running `eval run` against LM Studio is itself the integration test.

**Tech Stack:** Node 24, TypeScript (ESM, `NodeNext`), `node:test` + `node:assert/strict`, `node:util`'s `parseArgs`, `node:crypto`. Existing deps only: `jimp`, `zod`, `@lmstudio/sdk`. **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-09-11-doorbell-eval-design.md`

## Global Constraints

- **Working directory is `roles/doorbell/`** for every command in this plan unless a path says otherwise. `task`/Ansible is not involved; nothing here deploys.
- **No new dependencies.** If you reach for one, you have gone wrong.
- **Code style, matching the rest of `src/`:** 4-space indent, single quotes, semicolons, named exports, `import … from './x.js'` (the `.js` extension is required by `NodeNext` even in TypeScript sources).
- **Test style, matching the rest of `src/`:** `import { test } from 'node:test'; import assert from 'node:assert/strict';` — flat `test(...)` calls, no `describe`. Temp dirs via `fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'))`.
- **`strict: true`** is on. No `any`, no non-null `!` except where a test has just asserted the value.
- **Corpus default location:** `roles/doorbell/eval/`, resolved from the package root via `import.meta.url`, never from `process.cwd()`.
- **Ranking metric:** F-beta, `beta` default **0.5** (precision weighted twice recall). F1 is still reported; only ranking uses F-beta.
- **Errors are excluded from the confusion matrix**, never counted as negatives. A failed inference is not evidence of no cat.
- **Commit after every task**, using the message given in the task's final step.

---

### Task 1: Corpus walking and labels (`eval/corpus.ts`)

The corpus directory may be a symlink or a bind mount, and its contents may be arbitrarily nested — that is the whole reason this module exists rather than a `readdir` call in the CLI.

**Files:**
- Create: `src/eval/corpus.ts`
- Test: `src/eval/corpus.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces:
  - `interface Label { cat: boolean; note?: string }`
  - `type Labels = Record<string, Label>`
  - `function imagesDir(corpusDir: string): string`
  - `function labelsPath(corpusDir: string): string`
  - `function walkImages(dir: string): Promise<string[]>`
  - `function loadLabels(corpusDir: string): Promise<Labels>`
  - `function writeLabels(corpusDir: string, labels: Labels): Promise<void>`
  - `function mergeLabels(existing: Labels, found: string[]): { labels: Labels; added: string[]; orphaned: string[] }`
  - `function labelsSha(labels: Labels): string`

- [ ] **Step 1: Write the failing tests**

Create `src/eval/corpus.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn build`
Expected: FAIL — `Cannot find module './corpus.js'` / `File 'src/eval/corpus.ts' not found`.

- [ ] **Step 3: Write the implementation**

Create `src/eval/corpus.ts`:

```typescript
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface Label {
    cat: boolean;
    /** Free text for a human reviewing a failure months later. Not ground truth. */
    note?: string;
}

export type Labels = Record<string, Label>;

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png']);

export function imagesDir(corpusDir: string): string {
    return path.join(corpusDir, 'images');
}

export function labelsPath(corpusDir: string): string {
    return path.join(corpusDir, 'labels.json');
}

/**
 * Every image under `dir`, keyed by its POSIX path relative to `dir`. The relative
 * path is the label key, which is what frees the corpus from any filename
 * convention: `160141.raw.jpg` exists in every date directory, but
 * `2026-09-11/160141.raw.jpg` is unique.
 */
export async function walkImages(dir: string): Promise<string[]> {
    const found: string[] = [];
    const visited = new Set<string>();

    async function walk(current: string, prefix: string): Promise<void> {
        // realpath, and a visited set of real paths: the corpus may be a symlink or
        // a mount, and a link pointing at an ancestor would otherwise recurse forever.
        const real = await fs.promises.realpath(current);
        if (visited.has(real)) return;
        visited.add(real);

        for (const entry of await fs.promises.readdir(current)) {
            // Covers both dotfiles and macOS AppleDouble `._*` siblings.
            if (entry.startsWith('.')) continue;

            const full = path.join(current, entry);
            const key = prefix ? `${prefix}/${entry}` : entry;

            // stat, not lstat: a symlinked subdirectory of frames should be traversed.
            let stats: fs.Stats;
            try {
                stats = await fs.promises.stat(full);
            } catch {
                continue; // dangling symlink, or it vanished mid-walk
            }

            if (stats.isDirectory()) await walk(full, key);
            else if (IMAGE_EXTENSIONS.has(path.extname(entry).toLowerCase())) found.push(key);
        }
    }

    await walk(dir, '');

    return found.sort();
}

export async function loadLabels(corpusDir: string): Promise<Labels> {
    let body: string;
    try {
        body = await fs.promises.readFile(labelsPath(corpusDir), 'utf-8');
    } catch {
        return {};
    }
    return JSON.parse(body) as Labels;
}

function sortKeys(labels: Labels): Labels {
    const sorted: Labels = {};
    for (const key of Object.keys(labels).sort()) sorted[key] = labels[key] as Label;
    return sorted;
}

export async function writeLabels(corpusDir: string, labels: Labels): Promise<void> {
    await fs.promises.mkdir(corpusDir, { recursive: true });
    await fs.promises.writeFile(labelsPath(corpusDir), `${JSON.stringify(sortKeys(labels), null, 2)}\n`);
}

/**
 * Fold the images on disk into the labels already written. Existing labels are
 * never touched and vanished images are never dropped — the corpus is revised
 * repeatedly, and a bootstrap that discarded prior work would make it disposable.
 */
export function mergeLabels(existing: Labels, found: string[]): {
    labels: Labels;
    added: string[];
    orphaned: string[];
} {
    const labels: Labels = { ...existing };
    const added: string[] = [];

    for (const key of found) {
        if (labels[key]) continue;
        labels[key] = { cat: false };
        added.push(key);
    }

    const present = new Set(found);
    const orphaned = Object.keys(existing).filter((key) => !present.has(key)).sort();

    return { labels: sortKeys(labels), added, orphaned };
}

/**
 * Fingerprints the ground truth so a comparison across re-labelled corpora can be
 * caught. Notes are excluded: re-wording one must not invalidate an old run.
 */
export function labelsSha(labels: Labels): string {
    const canonical = Object.keys(labels)
        .sort()
        .map((key) => `${key}:${labels[key]?.cat ? 1 : 0}`)
        .join('\n');

    return crypto.createHash('sha256').update(canonical).digest('hex');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn build && node --test dist/eval/corpus.test.js`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/eval/corpus.ts src/eval/corpus.test.ts
git commit -m "Add eval corpus walking and label merging"
```

---

### Task 2: Scoring and comparison (`eval/metrics.ts`)

Pure arithmetic over results. No filesystem, no model.

**Files:**
- Create: `src/eval/metrics.ts`
- Test: `src/eval/metrics.test.ts`

**Interfaces:**
- Consumes: `Detection` from `../vision.js` (existing: `{ label: string; bbox_2d: [number, number, number, number] }`).
- Produces:
  - `type Outcome = 'tp' | 'fp' | 'fn' | 'tn' | 'error'`
  - `interface ImageResult { image: string; expected: boolean; verdict: boolean | null; outcome: Outcome; detections: Detection[]; annotated: string | null; ms: number; error: string | null }`
  - `interface Scores { tp: number; fp: number; fn: number; tn: number; errors: number; precision: number; recall: number; f1: number; fbeta: number; beta: number }`
  - `interface RunFile { startedAt: string; model: string; baseUrl: string; prompt: string; promptSha: string; labelsSha: string; corpus: { dir: string; images: number; positives: number }; summary: Scores & { totalMs: number; byDirectory: Record<string, Scores> }; results: ImageResult[] }`
  - `interface Flip { image: string; expected: boolean; a: boolean; b: boolean; kind: 'fixed' | 'broke' }`
  - `interface RunDiff { fixed: Flip[]; broke: Flip[]; unchanged: number; excluded: number }`
  - `function outcomeFor(expected: boolean, verdict: boolean): Outcome`
  - `function score(results: ImageResult[], beta: number): Scores`
  - `function byDirectory(results: ImageResult[], beta: number): Record<string, Scores>`
  - `function diffRuns(a: ImageResult[], b: ImageResult[]): RunDiff`
  - `function mcnemarExact(fixed: number, broke: number): number`
  - `function sha(value: string): string`

- [ ] **Step 1: Write the failing tests**

Create `src/eval/metrics.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn build`
Expected: FAIL — `File 'src/eval/metrics.ts' not found`.

- [ ] **Step 3: Write the implementation**

Create `src/eval/metrics.ts`:

```typescript
import crypto from 'node:crypto';
import { Detection } from '../vision.js';

export type Outcome = 'tp' | 'fp' | 'fn' | 'tn' | 'error';

export interface ImageResult {
    image: string;
    expected: boolean;
    /** null when the call failed; such a frame is evidence of nothing. */
    verdict: boolean | null;
    outcome: Outcome;
    detections: Detection[];
    /** Filename of the annotated copy within the run directory, when one was written. */
    annotated: string | null;
    ms: number;
    error: string | null;
}

export interface Scores {
    tp: number;
    fp: number;
    fn: number;
    tn: number;
    errors: number;
    precision: number;
    recall: number;
    f1: number;
    fbeta: number;
    beta: number;
}

export interface RunFile {
    startedAt: string;
    model: string;
    baseUrl: string;
    prompt: string;
    promptSha: string;
    labelsSha: string;
    corpus: { dir: string; images: number; positives: number };
    summary: Scores & { totalMs: number; byDirectory: Record<string, Scores> };
    results: ImageResult[];
}

export interface Flip {
    image: string;
    expected: boolean;
    a: boolean;
    b: boolean;
    kind: 'fixed' | 'broke';
}

export interface RunDiff {
    fixed: Flip[];
    broke: Flip[];
    unchanged: number;
    /** Images one run or the other failed on, so they say nothing about either. */
    excluded: number;
}

export function outcomeFor(expected: boolean, verdict: boolean): Outcome {
    if (expected && verdict) return 'tp';
    if (!expected && verdict) return 'fp';
    if (expected && !verdict) return 'fn';
    return 'tn';
}

/** Zero, not NaN: an empty or one-sided corpus is a thin result, not an undefined one. */
function ratio(numerator: number, denominator: number): number {
    return denominator === 0 ? 0 : numerator / denominator;
}

function fMeasure(precision: number, recall: number, beta: number): number {
    const squared = beta * beta;
    return ratio((1 + squared) * precision * recall, squared * precision + recall);
}

export function score(results: ImageResult[], beta: number): Scores {
    const counts = { tp: 0, fp: 0, fn: 0, tn: 0, errors: 0 };
    for (const item of results) {
        if (item.outcome === 'error') counts.errors += 1;
        else counts[item.outcome] += 1;
    }

    const precision = ratio(counts.tp, counts.tp + counts.fp);
    const recall = ratio(counts.tp, counts.tp + counts.fn);

    return {
        ...counts,
        precision,
        recall,
        f1: fMeasure(precision, recall, 1),
        fbeta: fMeasure(precision, recall, beta),
        beta,
    };
}

/**
 * Folders are how the corpus is organised, so folders should mean something: one
 * averaged recall hides exactly the split worth seeing, like night against day.
 */
export function byDirectory(results: ImageResult[], beta: number): Record<string, Scores> {
    const groups = new Map<string, ImageResult[]>();

    for (const item of results) {
        const slash = item.image.indexOf('/');
        const key = slash === -1 ? '.' : item.image.slice(0, slash);
        const group = groups.get(key);
        if (group) group.push(item);
        else groups.set(key, [item]);
    }

    const rollup: Record<string, Scores> = {};
    for (const key of [...groups.keys()].sort()) {
        rollup[key] = score(groups.get(key) as ImageResult[], beta);
    }

    return rollup;
}

export function diffRuns(a: ImageResult[], b: ImageResult[]): RunDiff {
    const before = new Map(a.map((item) => [item.image, item]));
    const diff: RunDiff = { fixed: [], broke: [], unchanged: 0, excluded: 0 };

    for (const after of b) {
        const original = before.get(after.image);
        if (!original) continue;

        if (original.verdict === null || after.verdict === null) {
            diff.excluded += 1;
            continue;
        }

        if (original.verdict === after.verdict) {
            diff.unchanged += 1;
            continue;
        }

        const kind = after.verdict === after.expected ? 'fixed' : 'broke';
        diff[kind].push({
            image: after.image,
            expected: after.expected,
            a: original.verdict,
            b: after.verdict,
            kind,
        });
    }

    return diff;
}

/**
 * McNemar's test over the discordant pairs, exact two-sided binomial. At a corpus
 * of ~100 frames a two-image delta is noise, and a tool that crowns a winner on it
 * launders noise into a decision.
 */
export function mcnemarExact(fixed: number, broke: number): number {
    const n = fixed + broke;
    if (n === 0) return 1;

    const smaller = Math.min(fixed, broke);

    // Accumulate the pmf by its recurrence rather than summing binomial coefficients,
    // which overflow long before n does.
    let pmf = Math.pow(0.5, n);
    let cumulative = pmf;
    for (let i = 1; i <= smaller; i += 1) {
        pmf *= (n - i + 1) / i;
        cumulative += pmf;
    }

    return Math.min(1, 2 * cumulative);
}

export function sha(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn build && node --test dist/eval/metrics.test.js`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add src/eval/metrics.ts src/eval/metrics.test.ts
git commit -m "Add eval scoring, per-directory rollup and McNemar comparison"
```

---

### Task 3: Rendering (`eval/report.ts`)

Pure string building: the labelling contact sheet, the run report, and the compare text.

**Files:**
- Create: `src/eval/report.ts`
- Test: `src/eval/report.test.ts`

**Interfaces:**
- Consumes: `Labels` from `./corpus.js`; `RunFile`, `RunDiff`, `Scores` from `./metrics.js`.
- Produces:
  - `function escapeHtml(value: string): string`
  - `function renderSheet(labels: Labels): string`
  - `function renderReport(run: RunFile): string`
  - `function renderCompare(options: { a: RunFile; b: RunFile; diff: RunDiff; beta: number; p: number }): string`

- [ ] **Step 1: Write the failing tests**

Create `src/eval/report.test.ts`:

```typescript
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
        detections: verdict ? [{ label: 'cat', bbox_2d: [0, 0, 10, 10] }] : [],
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
        baseUrl: 'ws://mbp2023.home.ricmatsui.com:1234',
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

    const text = renderCompare({ a: run(a, 'A'), b: run(b, 'B'), diff, beta: 0.5, p: mcnemarExact(diff.fixed.length, diff.broke.length) });

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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `yarn build`
Expected: FAIL — `File 'src/eval/report.ts' not found`.

- [ ] **Step 3: Write the implementation**

Create `src/eval/report.ts`:

```typescript
import { Labels } from './corpus.js';
import { ImageResult, RunDiff, RunFile, Scores } from './metrics.js';

const SIGNIFICANT = 0.05;

export function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const STYLE = `
body { font-family: -apple-system, system-ui, sans-serif; margin: 2rem; background: #111; color: #eee; }
h1, h2 { font-weight: 600; }
.grid { display: flex; flex-wrap: wrap; gap: 1rem; }
figure { margin: 0; width: 14rem; }
img { width: 100%; border-radius: 4px; display: block; background: #222; }
figcaption { font-size: 0.75rem; color: #aaa; word-break: break-all; margin-top: 0.25rem; }
.cat { outline: 3px solid #e33; }
table { border-collapse: collapse; margin: 1rem 0; font-size: 0.85rem; }
th, td { border: 1px solid #444; padding: 0.25rem 0.6rem; text-align: right; }
th:first-child, td:first-child { text-align: left; }
`;

function page(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body>
${body}
</body>
</html>
`;
}

/**
 * The labelling sheet. Images are referenced relative to the corpus root, where
 * this file is written, so nothing is copied.
 */
export function renderSheet(labels: Labels): string {
    const keys = Object.keys(labels).sort();
    const positives = keys.filter((key) => labels[key]?.cat).length;

    const figures = keys.map((key) => {
        const label = labels[key];
        const note = label?.note ? `<br>${escapeHtml(label.note)}` : '';
        return `<figure>
  <img class="${label?.cat ? 'cat' : ''}" src="images/${escapeHtml(key)}" loading="lazy" alt="">
  <figcaption>${label?.cat ? '🐈 cat' : '— nocat'}<br>${escapeHtml(key)}${note}</figcaption>
</figure>`;
    });

    return page('doorbell eval corpus', `<h1>Corpus</h1>
<p>${keys.length} images, ${positives} labelled cat. Red outline means <code>cat: true</code>.
Edit <code>labels.json</code> to correct.</p>
<div class="grid">
${figures.join('\n')}
</div>`);
}

function scoreRow(name: string, scores: Scores): string {
    return `<tr><td>${escapeHtml(name)}</td><td>${scores.tp}</td><td>${scores.fp}</td><td>${scores.fn}</td>` +
        `<td>${scores.tn}</td><td>${scores.errors}</td><td>${scores.precision.toFixed(3)}</td>` +
        `<td>${scores.recall.toFixed(3)}</td><td>${scores.f1.toFixed(3)}</td><td>${scores.fbeta.toFixed(3)}</td></tr>`;
}

function section(title: string, results: ImageResult[]): string {
    if (results.length === 0) return `<h2>${escapeHtml(title)} (0)</h2>`;

    const figures = results.map((item) => {
        // Annotated copies exist only where there were boxes to draw; everything else
        // points back at the untouched source image.
        const src = item.annotated ?? `../../images/${item.image}`;
        const labels = item.detections.map((detection) => detection.label).join(', ') || '—';
        const error = item.error ? `<br>${escapeHtml(item.error)}` : '';
        return `<figure>
  <img src="${escapeHtml(src)}" loading="lazy" alt="">
  <figcaption>${escapeHtml(item.image)}<br>${escapeHtml(labels)} · ${item.ms}ms${error}</figcaption>
</figure>`;
    });

    return `<h2>${escapeHtml(title)} (${results.length})</h2>
<div class="grid">
${figures.join('\n')}
</div>`;
}

export function renderReport(run: RunFile): string {
    const of = (outcome: ImageResult['outcome']) => run.results.filter((item) => item.outcome === outcome);

    const directories = Object.entries(run.summary.byDirectory)
        .map(([name, scores]) => scoreRow(name, scores))
        .join('\n');

    // False positives and false negatives lead: they are the only two anyone looks at.
    const body = `<h1>${escapeHtml(run.model)}</h1>
<p>${escapeHtml(run.startedAt)} · ${run.corpus.images} images, ${run.corpus.positives} cat ·
${(run.summary.totalMs / 1000).toFixed(1)}s<br>
prompt <code>${escapeHtml(run.promptSha.slice(0, 12))}</code> ·
labels <code>${escapeHtml(run.labelsSha.slice(0, 12))}</code></p>
<table>
<tr><th>scope</th><th>tp</th><th>fp</th><th>fn</th><th>tn</th><th>err</th>
<th>precision</th><th>recall</th><th>f1</th><th>f${run.summary.beta}</th></tr>
${scoreRow('all', run.summary)}
${directories}
</table>
${section('False positives', of('fp'))}
${section('False negatives', of('fn'))}
${section('True positives', of('tp'))}
${section('True negatives', of('tn'))}
${section('Errors', of('error'))}`;

    return page(`${run.model} — doorbell eval`, body);
}

function summaryLine(name: string, run: RunFile): string {
    const s = run.summary;
    return `${name.padEnd(10)} tp=${String(s.tp).padStart(3)} fp=${String(s.fp).padStart(3)} ` +
        `fn=${String(s.fn).padStart(3)} tn=${String(s.tn).padStart(3)} err=${String(s.errors).padStart(3)}  ` +
        `P=${s.precision.toFixed(3)} R=${s.recall.toFixed(3)} F1=${s.f1.toFixed(3)} F${s.beta}=${s.fbeta.toFixed(3)}`;
}

export function renderCompare(options: {
    a: RunFile;
    b: RunFile;
    diff: RunDiff;
    beta: number;
    p: number;
}): string {
    const { a, b, diff, beta, p } = options;
    const delta = b.summary.fbeta - a.summary.fbeta;
    const fixed = diff.fixed.length;
    const broke = diff.broke.length;

    const flips = [...diff.fixed, ...diff.broke]
        .sort((one, two) => one.image.localeCompare(two.image))
        .map((flip) => {
            const sign = flip.kind === 'fixed' ? '+' : '-';
            const was = flip.expected ? 'FN' : 'FP';
            const note = flip.kind === 'fixed' ? `${was} fixed` : `new ${was}`;
            return `  ${sign} ${flip.image.padEnd(40)} expected=${flip.expected ? 'cat  ' : 'nocat'} ` +
                `A=${flip.a ? 'cat  ' : 'nocat'} B=${flip.b ? 'cat  ' : 'nocat'}  (${note})`;
        });

    const better = delta > 0 ? b.model : a.model;
    const verdict = p <= SIGNIFICANT && fixed !== broke
        ? `verdict: ${better} better — F${beta} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ` +
          `(${a.summary.fbeta.toFixed(3)} → ${b.summary.fbeta.toFixed(3)}), ` +
          `${fixed} fixed / ${broke} broke, McNemar p=${p.toFixed(3)}`
        : `verdict: no clear winner — F${beta} ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}, ` +
          `${fixed} fixed / ${broke} broke, McNemar p=${p.toFixed(3)} (n too small to call)`;

    return [
        `A  ${a.model}  ${a.startedAt}`,
        `B  ${b.model}  ${b.startedAt}`,
        '',
        summaryLine('A', a),
        summaryLine('B', b),
        '',
        `A→B   fixed ${fixed}   broke ${broke}   unchanged ${diff.unchanged}   excluded ${diff.excluded}`,
        ...flips,
        '',
        verdict,
        `ranking uses F${beta}: a false positive latches the sensor wrong for ~90s, a false negative is usually absorbed.`,
        '',
    ].join('\n');
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn build && node --test dist/eval/report.test.js`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/eval/report.ts src/eval/report.test.ts
git commit -m "Add eval contact sheet and comparison rendering"
```

---

### Task 4: CLI wiring and `bootstrap` mode

The first runnable command, plus the ignore rules the corpus needs. The `.dockerignore` entry is not cosmetic: `tasks/main.yml` builds with `path: "{{ role_path }}"`, so without it every `task deploy --tags doorbell` uploads the whole corpus as build context — unbounded if `eval/` is a mount.

**Files:**
- Create: `src/eval/cli.ts`
- Modify: `package.json` (scripts), `.gitignore`, `.dockerignore`

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: `yarn eval bootstrap [--dir <corpus>]`.

- [ ] **Step 1: Add the ignore rules**

Append `eval/` to `roles/doorbell/.gitignore` so it reads:

```
dist/
node_modules/
eval/
```

Append `eval` to `roles/doorbell/.dockerignore` so it reads:

```
node_modules
dist
.git
.DS_Store
eval
```

- [ ] **Step 2: Update the package scripts**

In `package.json`, change the `test` script so discovery recurses into `dist/eval/`, and add `eval`:

```json
    "scripts": {
        "build": "tsc || exit 1",
        "test": "rm -rf dist && tsc && TZ=America/Los_Angeles node --test dist",
        "start": "node dist/index.js",
        "eval": "tsc && node dist/eval/cli.js"
    },
```

- [ ] **Step 3: Verify the existing suite still runs under the new glob**

Run: `yarn test`
Expected: PASS — all pre-existing tests plus the eval tests from Tasks 1–3 (`node --test dist` recurses; the old `dist/*.test.js` glob would have missed `dist/eval/`).

- [ ] **Step 4: Write the CLI with only `bootstrap` implemented**

Create `src/eval/cli.ts`:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { imagesDir, loadLabels, mergeLabels, walkImages, writeLabels } from './corpus.js';
import { renderSheet } from './report.js';

// dist/eval/cli.js → dist → package root, so the default corpus is the same whether
// the command is run from the role or from the repository root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const DEFAULT_DIR = path.join(PACKAGE_ROOT, 'eval');

const USAGE = `usage:
  yarn eval bootstrap [--dir <corpus>]
  yarn eval run       [--dir <corpus>] --model <name> [--url <ws://…>] [--prompt-file <f>] [--limit <n>]
  yarn eval compare   <runA.json> <runB.json> [--beta <n>]
`;

function fail(message: string): never {
    console.error(message);
    process.exit(1);
}

async function bootstrap(corpusDir: string): Promise<void> {
    const images = imagesDir(corpusDir);
    if (!fs.existsSync(images)) fail(`no images directory at ${images}\ncreate it and copy frames in, then re-run`);

    const found = await walkImages(images);
    const { labels, added, orphaned } = mergeLabels(await loadLabels(corpusDir), found);

    await writeLabels(corpusDir, labels);
    await fs.promises.writeFile(path.join(corpusDir, 'sheet.html'), renderSheet(labels));

    const positives = Object.values(labels).filter((label) => label.cat).length;

    console.log(`found ${found.length} images in ${images}`);
    console.log(`added ${added.length} as nocat`);
    if (orphaned.length > 0) console.log(`orphaned ${orphaned.length} labels with no image (kept)`);
    console.log(`labels: ${positives} cat / ${Object.keys(labels).length - positives} nocat`);
    console.log(`open ${path.join(corpusDir, 'sheet.html')} and correct ${path.join(corpusDir, 'labels.json')}`);
}

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        dir: { type: 'string' },
        model: { type: 'string' },
        url: { type: 'string' },
        'prompt-file': { type: 'string' },
        limit: { type: 'string' },
        beta: { type: 'string' },
    },
});

const command = positionals[0];
const corpusDir = path.resolve(values.dir ?? DEFAULT_DIR);

if (command === 'bootstrap') {
    await bootstrap(corpusDir);
} else {
    fail(USAGE);
}
```

- [ ] **Step 5: Verify bootstrap end to end against real frames**

```bash
mkdir -p eval/images/2026-09-11
cp /mnt/gluster/doorbell/frames/2026-09-11/*.raw.jpg eval/images/2026-09-11/
yarn eval bootstrap
```

Expected: reports ~51 images found and added, writes `eval/labels.json` and `eval/sheet.html`. Open `eval/sheet.html` — every frame renders as a thumbnail. Then run `yarn eval bootstrap` a second time and confirm it reports `added 0` (the merge is idempotent).

Note: if yarn swallows the flags, use `yarn eval -- bootstrap --dir …`.

- [ ] **Step 6: Verify nothing in the corpus is tracked or shipped**

Run: `git status --short`
Expected: `eval/` does not appear.

- [ ] **Step 7: Commit**

```bash
git add src/eval/cli.ts package.json .gitignore .dockerignore
git commit -m "Add eval CLI with corpus bootstrap"
```

---

### Task 5: Optional prompt override in `vision.ts`

The only production change this design makes. Prompt is frequently a bigger lever on quality than model choice, and leaving it module-scoped makes half the interesting experiments impossible.

**Files:**
- Modify: `src/vision.ts`
- Test: `src/vision.test.ts`

**Interfaces:**
- Produces: `createVisionClient(options: { baseUrl: string; model: string; prompt?: string })` — defaults to the exported `PROMPT`. `index.ts` is unchanged and keeps working.

- [ ] **Step 1: Write the failing test**

Append to `src/vision.test.ts`:

Extend the existing `from './vision.js'` import at the top of the file with `PROMPT` and `promptFor` — do not add a second import statement — then append:

```typescript
test('the prompt defaults to the shipped one', () => {
    assert.equal(promptFor(undefined), PROMPT);
});

test('an explicit prompt overrides the shipped one', () => {
    assert.equal(promptFor('find dogs'), 'find dogs');
});

test('an empty prompt falls back rather than asking the model nothing', () => {
    assert.equal(promptFor(''), PROMPT);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `yarn build`
Expected: FAIL — `Module '"./vision.js"' has no exported member 'promptFor'`.

- [ ] **Step 3: Implement the override**

In `src/vision.ts`, add after the `PROMPT` constant:

```typescript
/** An empty string is a mistake, not an instruction, so it falls back. */
export function promptFor(prompt: string | undefined): string {
    return prompt && prompt.trim().length > 0 ? prompt : PROMPT;
}
```

Then change the client factory signature and the single use of the prompt:

```typescript
export function createVisionClient(options: { baseUrl: string; model: string; prompt?: string }): VisionClient {
    const client = new LMStudioClient({ baseUrl: options.baseUrl });
    const prompt = promptFor(options.prompt);
    let model: Awaited<ReturnType<typeof client.llm.model>> | null = null;

    log.debug('client created', { base_url: options.baseUrl, model: options.model });
```

and inside `detect`, replace `content: PROMPT` with `content: prompt`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `yarn test`
Expected: PASS — the three new tests plus every pre-existing one. `index.ts` passes no `prompt` and is unaffected.

- [ ] **Step 5: Commit**

```bash
git add src/vision.ts src/vision.test.ts
git commit -m "Allow the vision prompt to be overridden"
```

---

### Task 6: `run` mode

**Files:**
- Modify: `src/eval/cli.ts`

**Interfaces:**
- Consumes: `createVisionClient`, `hasCat` from `../vision.js`; `annotate` from `../annotate.js`; `score`, `byDirectory`, `outcomeFor`, `sha`, `ImageResult`, `RunFile` from `./metrics.js`; `renderReport` from `./report.js`.
- Produces: `yarn eval run --model <name>`, writing `eval/runs/<stamp>-<model>.json` and `eval/runs/<stamp>-<model>/index.html`.

- [ ] **Step 1: Add the run implementation**

In `src/eval/cli.ts`, add these imports to the existing import block:

```typescript
import { annotate } from '../annotate.js';
import { createVisionClient, hasCat, promptFor } from '../vision.js';
import { imagesDir, labelsSha, loadLabels, mergeLabels, walkImages, writeLabels } from './corpus.js';
import { ImageResult, RunFile, byDirectory, outcomeFor, score, sha } from './metrics.js';
import { renderReport, renderSheet } from './report.js';
```

(replacing the two narrower `./corpus.js` and `./report.js` imports already there)

Add the default URL constant beside `DEFAULT_DIR`:

```typescript
const DEFAULT_URL = 'ws://mbp2023.home.ricmatsui.com:1234';
const DEFAULT_BETA = 0.5;
```

Add the `run` function:

```typescript
function stamp(at: Date): string {
    return at.toISOString().replace(/:/g, '-').replace(/\.\d+Z$/, 'Z');
}

function slug(value: string): string {
    return value.replace(/[^a-zA-Z0-9._-]+/g, '-');
}

async function run(options: {
    corpusDir: string;
    model: string;
    baseUrl: string;
    promptFile?: string;
    limit?: number;
}): Promise<void> {
    const labels = await loadLabels(options.corpusDir);
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) fail(`no labels in ${options.corpusDir}; run "yarn eval bootstrap" first`);

    const images = imagesDir(options.corpusDir);
    const onDisk = new Set(await walkImages(images));
    const unlabelled = [...onDisk].filter((key) => !labels[key]);
    if (unlabelled.length > 0) {
        console.warn(`skipping ${unlabelled.length} unlabelled images; run "yarn eval bootstrap" to add them`);
    }

    const override = options.promptFile ? await fs.promises.readFile(options.promptFile, 'utf-8') : undefined;
    // Record the prompt that actually ran, not the override: an artifact whose
    // promptSha hashes an empty string is unattributable months later.
    const prompt = promptFor(override);
    const vision = createVisionClient({ baseUrl: options.baseUrl, model: options.model, prompt });

    const startedAt = new Date();
    const name = `${stamp(startedAt)}-${slug(options.model)}`;
    const runDir = path.join(options.corpusDir, 'runs', name);
    await fs.promises.mkdir(runDir, { recursive: true });

    const scored = keys.filter((key) => onDisk.has(key)).slice(0, options.limit ?? Infinity);
    const results: ImageResult[] = [];
    const began = performance.now();

    for (const [index, key] of scored.entries()) {
        const expected = labels[key]?.cat ?? false;
        const imagePath = path.join(images, key);
        const started = performance.now();

        try {
            const detections = await vision.detect(imagePath);
            const verdict = hasCat(detections);
            let annotated: string | null = null;

            // Only frames with boxes get a copy; everything else points back at the
            // source image from the report, which keeps the run directory small.
            if (detections.length > 0) {
                const raw = await fs.promises.readFile(imagePath);
                const drawn = await annotate(raw, detections);
                annotated = `${key.replace(/\//g, '__')}`;
                await fs.promises.writeFile(path.join(runDir, annotated), drawn.buffer);
            }

            results.push({
                image: key,
                expected,
                verdict,
                outcome: outcomeFor(expected, verdict),
                detections,
                annotated,
                ms: Math.round(performance.now() - started),
                error: null,
            });
        } catch (error) {
            // Excluded from the matrix downstream: a failed call is not evidence of no cat.
            results.push({
                image: key,
                expected,
                verdict: null,
                outcome: 'error',
                detections: [],
                annotated: null,
                ms: Math.round(performance.now() - started),
                error: error instanceof Error ? error.message : String(error),
            });
        }

        const last = results[results.length - 1] as ImageResult;
        console.log(`[${index + 1}/${scored.length}] ${last.outcome.padEnd(5)} ${last.ms}ms  ${key}`);
    }

    const scores = score(results, DEFAULT_BETA);
    const artifact: RunFile = {
        startedAt: startedAt.toISOString(),
        model: options.model,
        baseUrl: options.baseUrl,
        prompt,
        promptSha: sha(prompt),
        labelsSha: labelsSha(labels),
        corpus: {
            dir: options.corpusDir,
            images: scored.length,
            positives: scored.filter((key) => labels[key]?.cat).length,
        },
        summary: {
            ...scores,
            totalMs: Math.round(performance.now() - began),
            byDirectory: byDirectory(results, DEFAULT_BETA),
        },
        results,
    };

    const artifactPath = path.join(options.corpusDir, 'runs', `${name}.json`);
    await fs.promises.writeFile(artifactPath, `${JSON.stringify(artifact, null, 2)}\n`);
    await fs.promises.writeFile(path.join(runDir, 'index.html'), renderReport(artifact));

    console.log('');
    console.log(`tp=${scores.tp} fp=${scores.fp} fn=${scores.fn} tn=${scores.tn} err=${scores.errors}`);
    console.log(`P=${scores.precision.toFixed(3)} R=${scores.recall.toFixed(3)} ` +
        `F1=${scores.f1.toFixed(3)} F${DEFAULT_BETA}=${scores.fbeta.toFixed(3)}`);
    console.log(artifactPath);
    console.log(path.join(runDir, 'index.html'));
}
```

- [ ] **Step 2: Dispatch the command**

Replace the command dispatch at the bottom of `cli.ts`:

```typescript
if (command === 'bootstrap') {
    await bootstrap(corpusDir);
} else if (command === 'run') {
    if (!values.model) fail('--model is required\n\n' + USAGE);
    await run({
        corpusDir,
        model: values.model,
        baseUrl: values.url ?? DEFAULT_URL,
        promptFile: values['prompt-file'],
        limit: values.limit ? Number(values.limit) : undefined,
    });
} else {
    fail(USAGE);
}
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run: `yarn test`
Expected: PASS — no eval unit test covers `cli.ts` (it is the impure shell), but the build must be clean.

- [ ] **Step 4: Verify against LM Studio**

With LM Studio running and the model loaded:

```bash
yarn eval run --model gemma-3-12b-it-qat --limit 5
```

Expected: five progress lines, a summary, and two paths. Open the `index.html` — thumbnails render, false positives and false negatives come first, and the per-directory table is present. Then run without `--limit` over the whole corpus and confirm the confusion matrix roughly agrees with the `-cat.jpg` / `-nocat.jpg` files already on gluster.

- [ ] **Step 5: Commit**

```bash
git add src/eval/cli.ts
git commit -m "Add eval run mode"
```

---

### Task 7: `compare` mode

**Files:**
- Modify: `src/eval/cli.ts`

**Interfaces:**
- Consumes: `diffRuns`, `mcnemarExact`, `RunFile` from `./metrics.js`; `renderCompare` from `./report.js`.
- Produces: `yarn eval compare <runA.json> <runB.json> [--beta <n>]`.

- [ ] **Step 1: Add the compare implementation**

Extend the `./metrics.js` and `./report.js` imports with `diffRuns`, `mcnemarExact` and `renderCompare`, then add:

```typescript
async function readRun(file: string): Promise<RunFile> {
    try {
        return JSON.parse(await fs.promises.readFile(file, 'utf-8')) as RunFile;
    } catch {
        return fail(`cannot read run file ${file}`);
    }
}

async function compare(fileA: string, fileB: string, beta: number): Promise<void> {
    const a = await readRun(fileA);
    const b = await readRun(fileB);

    const imagesA = a.results.map((item) => item.image).sort().join('\n');
    const imagesB = b.results.map((item) => item.image).sort().join('\n');
    if (imagesA !== imagesB) {
        fail(`these runs scored different images (${a.results.length} vs ${b.results.length}); they are not comparable`);
    }

    // Ground truth shifts as the corpus is re-labelled; comparing across it silently
    // is worse than not comparing at all.
    if (a.labelsSha !== b.labelsSha) {
        console.warn('warning: these runs scored against different labels; the comparison is not like for like\n');
    }

    // The stored summaries were scored at the run's own beta; re-score when the
    // caller asks for a different one, or the verdict would rank on stale numbers.
    if (a.summary.beta !== beta) a.summary = { ...a.summary, ...score(a.results, beta) };
    if (b.summary.beta !== beta) b.summary = { ...b.summary, ...score(b.results, beta) };

    const diff = diffRuns(a.results, b.results);
    process.stdout.write(renderCompare({
        a,
        b,
        diff,
        beta,
        p: mcnemarExact(diff.fixed.length, diff.broke.length),
    }));
}
```

- [ ] **Step 2: Dispatch the command**

Add before the final `else`:

```typescript
} else if (command === 'compare') {
    const [, fileA, fileB] = positionals;
    if (!fileA || !fileB) fail('compare needs two run files\n\n' + USAGE);
    await compare(fileA, fileB, values.beta ? Number(values.beta) : DEFAULT_BETA);
```

- [ ] **Step 3: Verify it compiles and the suite still passes**

Run: `yarn test`
Expected: PASS.

- [ ] **Step 4: Verify against two real runs**

```bash
yarn eval run --model gemma-3-12b-it-qat
yarn eval run --model <a second vision model loaded in LM Studio>
yarn eval compare eval/runs/<first>.json eval/runs/<second>.json
```

Expected: both summaries, a flip list naming frames that visibly differ, and a verdict line. Confirm that a small number of flips produces `no clear winner`. Then deliberately test the guards: `yarn eval compare <a run> <a run made with --limit 5>` must refuse with the "different images" message.

- [ ] **Step 5: Commit**

```bash
git add src/eval/cli.ts
git commit -m "Add eval compare mode with McNemar verdict"
```

---

### Task 8: Document the harness

**Files:**
- Modify: `roles/doorbell/README.md`

- [ ] **Step 1: Add the Eval section**

Insert between the existing `## Logging` and `## Deploying` sections:

```markdown
## Eval

`yarn eval` scores a folder of images through the same `detect` path the service
uses, against labels you write by hand. It is a development tool: nothing deploys
it, and the service does not depend on it.

The corpus lives in `eval/`, which is ignored by git and by the Docker build
context — so it can be a symlink or a mount, and the frames never enter history.

    mkdir -p eval/images/2026-09-11
    cp /mnt/gluster/doorbell/frames/2026-09-11/*.raw.jpg eval/images/2026-09-11/
    yarn eval bootstrap

`bootstrap` walks `eval/images/` recursively — any layout, any filenames, since the
label key is the relative path — and merges what it finds into `eval/labels.json`,
adding unseen files as `nocat` and never touching a label you have already set. It
writes `eval/sheet.html`; open it, then correct `labels.json`.

Copy in only the raw frames. The `-cat.jpg` / `-nocat.jpg` siblings on gluster are a
previous run's own output, and scoring a model against images it already drew boxes
on would be circular.

    yarn eval run --model gemma-3-12b-it-qat
    yarn eval compare eval/runs/<a>.json eval/runs/<b>.json

`run` needs LM Studio reachable. It writes `eval/runs/<stamp>-<model>.json` and a
contact sheet beside it with false positives and false negatives first, which are the
only two worth looking at.

`compare` ranks with **F0.5**, not F1. The errors are not symmetric here: with a 30s
poll and `missLimit` 3, one false positive holds the sensor wrong for about ninety
seconds, while one false negative is usually absorbed by the latch or by the next
frame. It then runs McNemar's exact test over the frames that flipped, so a
two-image difference on a hundred-image corpus reports `no clear winner` instead of
crowning one.

What no number here can tell you is whether a model generalises beyond this porch at
the hours that happen to be sampled. That is a corpus problem — add night frames and
hard negatives — not a math problem.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "Document the doorbell eval harness"
```

---

## Self-review notes

Checked against the spec:

- Corpus layout, recursive walk, symlink following, dotfile/AppleDouble skip, gitignore and dockerignore — Tasks 1 and 4.
- Labels keyed by relative path, merge semantics, orphan reporting, `labelsSha` excluding notes — Task 1.
- Confusion matrix with errors excluded, precision/recall/F1/F-beta, per-directory rollup, McNemar, flip list — Tasks 2 and 3.
- Run artifact fields including `promptSha` and `labelsSha`, contact sheet ordering — Tasks 2, 3 and 6.
- CLI surface, `--dir` resolved from the package root, `loadConfig()` untouched, unlabelled images skipped with a warning, `--limit` — Tasks 4, 6 and 7.
- `compare` refusing on differing image sets and warning on differing labels — Task 7.
- `package.json` scripts, `vision.ts` optional prompt, README — Tasks 4, 5 and 8.

Out of scope and deliberately absent: episode replay through `CatPresence`, box IoU, `--repeat` determinism, CI gating, a labelling UI.
