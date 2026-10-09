import crypto from 'node:crypto';
import { Box, Detection } from '../vision.js';

export type Outcome = 'tp' | 'fp' | 'fn' | 'tn' | 'error';

export interface ImageResult {
    image: string;
    expected: boolean;
    /** null when the call failed; such a frame is evidence of nothing. */
    verdict: boolean | null;
    outcome: Outcome;
    detections: Detection[];
    /**
     * The labelled box in source pixels, or null for a no-cat frame. Carried on the
     * result so a run stays scorable without the labels it ran against. Absent on
     * runs from before frames were boxed.
     */
    truth?: Box | null;
    /** The detections converted to source pixels, the space `truth` is in. */
    boxes?: Box[];
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
    /** Factor frames were resampled by before sending. Absent on runs before it was settable, which all sent 2x. */
    upscale?: number;
    /** The --only patterns a subset run was narrowed by. Absent on full-corpus runs. */
    only?: string[];
    prompt: string;
    promptSha: string;
    labelsSha: string;
    corpus: { dir: string; images: number; positives: number };
    summary: Scores & {
        totalMs: number;
        byDirectory: Record<string, Scores>;
        /** Absent on runs from before frames were boxed. */
        localization?: Localization | null;
    };
    results: ImageResult[];
}

/**
 * How well the boxes land, over the cat frames that ran. `hits` counts frames whose
 * best box clears `threshold` IoU, out of every cat frame — a miss is not a hit —
 * while the means are over `found`, the frames with any box at all, so they say
 * how tight a found cat is. The offsets are the best box's centre minus the
 * truth's, in source pixels: a negative `meanDy` is a box sitting above the cat.
 */
export interface Localization {
    frames: number;
    hits: number;
    hitRate: number;
    found: number;
    meanIou: number;
    meanDx: number;
    meanDy: number;
    threshold: number;
}

export interface HitDiff {
    fixed: string[];
    broke: string[];
    unchanged: number;
    excluded: number;
    /** Mean of B's best IoU minus A's over the paired cat frames; a miss counts as zero. */
    meanIouDelta: number;
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

/** The conventional bar for a box that found the right thing. */
export const IOU_THRESHOLD = 0.5;

export function iou(a: Box, b: Box): number {
    const width = Math.min(a.xMax, b.xMax) - Math.max(a.xMin, b.xMin);
    const height = Math.min(a.yMax, b.yMax) - Math.max(a.yMin, b.yMin);
    if (width <= 0 || height <= 0) return 0;

    const intersection = width * height;
    const area = (box: Box) => (box.xMax - box.xMin) * (box.yMax - box.yMin);
    return intersection / (area(a) + area(b) - intersection);
}

/** The box overlapping `truth` most, and how far its centre sits from the truth's. */
export function bestMatch(truth: Box, boxes: Box[]): { iou: number; dx: number; dy: number } | null {
    let best: { iou: number; dx: number; dy: number } | null = null;

    for (const box of boxes) {
        const overlap = iou(truth, box);
        if (best && overlap <= best.iou) continue;
        best = {
            iou: overlap,
            dx: (box.xMin + box.xMax) / 2 - (truth.xMin + truth.xMax) / 2,
            dy: (box.yMin + box.yMax) / 2 - (truth.yMin + truth.yMax) / 2,
        };
    }

    return best;
}

/** Cat frames with a box to score against and a call that did not fail. */
function scorable(item: ImageResult): item is ImageResult & { truth: Box } {
    return item.truth != null && item.outcome !== 'error';
}

export function localize(results: ImageResult[]): Localization | null {
    if (!results.some((item) => item.truth !== undefined)) return null;

    const cats = results.filter(scorable);
    const matches = cats
        .map((item) => bestMatch(item.truth, item.boxes ?? []))
        .filter((match) => match !== null);
    const mean = (pick: (match: { iou: number; dx: number; dy: number }) => number) =>
        ratio(matches.reduce((sum, match) => sum + pick(match), 0), matches.length);
    const hits = matches.filter((match) => match.iou >= IOU_THRESHOLD).length;

    return {
        frames: cats.length,
        hits,
        hitRate: ratio(hits, cats.length),
        found: matches.length,
        meanIou: mean((match) => match.iou),
        meanDx: mean((match) => match.dx),
        meanDy: mean((match) => match.dy),
        threshold: IOU_THRESHOLD,
    };
}

/**
 * Pairs cat frames across two runs by whether each located the cat, so the same
 * McNemar test that compares verdicts can compare localization.
 */
export function diffHits(a: ImageResult[], b: ImageResult[]): HitDiff {
    const before = new Map(a.map((item) => [item.image, item]));
    const diff: HitDiff = { fixed: [], broke: [], unchanged: 0, excluded: 0, meanIouDelta: 0 };
    let deltaSum = 0;
    let paired = 0;

    for (const after of b) {
        const original = before.get(after.image);
        if (!original || after.truth == null) continue;

        if (!scorable(original) || !scorable(after)) {
            diff.excluded += 1;
            continue;
        }

        const overlapA = bestMatch(original.truth, original.boxes ?? [])?.iou ?? 0;
        const overlapB = bestMatch(after.truth, after.boxes ?? [])?.iou ?? 0;
        deltaSum += overlapB - overlapA;
        paired += 1;

        const hitA = overlapA >= IOU_THRESHOLD;
        const hitB = overlapB >= IOU_THRESHOLD;
        if (hitA === hitB) diff.unchanged += 1;
        else diff[hitB ? 'fixed' : 'broke'].push(after.image);
    }

    diff.meanIouDelta = ratio(deltaSum, paired);
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
