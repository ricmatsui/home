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
