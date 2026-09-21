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
    /** Frames in flight at once. Absent on runs written before it was settable. */
    concurrency?: number;
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
 * McNemar's test over the discordant pairs, exact two-sided binomial.
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
