import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Box } from '../vision.js';

export interface Label {
    /**
     * Where the cat is, in the source image's own pixels; `null` means no cat. Absent
     * until a human has looked at the frame, and `run` refuses a corpus holding any.
     * Anything that compares against it — model output included — converts into
     * source pixels first, so the truth never depends on how a frame was resized.
     */
    box?: Box | null;
    /**
     * The verdict from before frames were boxed. Read only to hint the annotator,
     * and dropped once a box (or null) is saved; it is never ground truth.
     */
    cat?: boolean | null;
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
        labels[key] = {};
        added.push(key);
    }

    const present = new Set(found);
    const orphaned = Object.keys(existing).filter((key) => !present.has(key)).sort();

    return { labels: sortKeys(labels), added, orphaned };
}

/** A well-formed box: whole non-negative pixels, with a positive width and height. */
export function isBox(value: unknown): value is Box {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
    const { xMin, yMin, xMax, yMax } = value as Record<string, unknown>;
    const coordinates = [xMin, yMin, xMax, yMax];
    if (!coordinates.every((coordinate) => Number.isInteger(coordinate) && (coordinate as number) >= 0)) return false;
    return (xMin as number) < (xMax as number) && (yMin as number) < (yMax as number);
}

export function hasCat(label: Label | undefined): boolean {
    return label?.box != null;
}

/** Keys still waiting on a human. Anything but a box or null counts, so a hand-edit typo is caught too. */
export function pendingLabels(labels: Labels): string[] {
    return Object.keys(labels)
        .filter((key) => {
            const box = labels[key]?.box;
            return box !== null && !isBox(box);
        })
        .sort();
}

/**
 * Folds boxes drawn in the annotator into the labels on disk. Only the keys sent
 * are touched — a frame the annotator never showed keeps whatever it had — and
 * the note survives, since it is the one field a human writes by hand.
 */
export function applyBoxes(labels: Labels, boxes: Record<string, Box | null>): Labels {
    const applied: Labels = { ...labels };

    for (const [key, box] of Object.entries(boxes)) {
        const label = labels[key];
        if (!label) throw new Error(`no label for ${key}; run "yarn eval bootstrap" first`);

        // The page measures in CSS pixels scaled to the image, so fractions are expected;
        // anything that is not four numbers is left as it came, for isBox to refuse.
        const numeric = box !== null && typeof box === 'object' &&
            [box.xMin, box.yMin, box.xMax, box.yMax].every((value) => typeof value === 'number');
        const rounded = !numeric ? box : {
            xMin: Math.round(box.xMin),
            yMin: Math.round(box.yMin),
            xMax: Math.round(box.xMax),
            yMax: Math.round(box.yMax),
        };
        if (rounded !== null && !isBox(rounded)) throw new Error(`malformed box for ${key}: ${JSON.stringify(box)}`);

        const { cat: _legacy, ...rest } = label;
        applied[key] = { ...rest, box: rounded };
    }

    return sortKeys(applied);
}

/**
 * Narrows the corpus to the keys matching any of the patterns — globs or exact
 * paths, relative to images/. No patterns keeps everything. A pattern that
 * matches nothing is reported rather than ignored: it is almost always a typo.
 */
export function selectKeys(keys: string[], patterns: string[]): { selected: string[]; unmatched: string[] } {
    if (patterns.length === 0) return { selected: keys, unmatched: [] };

    const matches = (key: string, pattern: string) => key === pattern || path.posix.matchesGlob(key, pattern);
    return {
        selected: keys.filter((key) => patterns.some((pattern) => matches(key, pattern))),
        unmatched: patterns.filter((pattern) => !keys.some((key) => matches(key, pattern))),
    };
}

/**
 * Fingerprints the ground truth so a comparison across re-labelled corpora can be
 * caught. Notes are excluded: re-wording one must not invalidate an old run.
 */
export function labelsSha(labels: Labels): string {
    const canonical = Object.keys(labels)
        .sort()
        .map((key) => {
            const box = labels[key]?.box;
            return `${key}:${box ? `${box.xMin},${box.yMin},${box.xMax},${box.yMax}` : '-'}`;
        })
        .join('\n');

    return crypto.createHash('sha256').update(canonical).digest('hex');
}
