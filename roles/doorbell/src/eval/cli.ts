import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { annotate } from '../annotate.js';
import { createVisionClient, promptFor } from '../vision.js';
import { imagesDir, labelsSha, loadLabels, mergeLabels, walkImages, writeLabels } from './corpus.js';
import { loadDotEnv } from './env.js';
import { ImageResult, RunFile, byDirectory, diffRuns, mcnemarExact, outcomeFor, score, sha } from './metrics.js';
import { mapWithConcurrency } from './pool.js';
import { renderCompare, renderReport, renderSheet } from './report.js';

// dist/eval/cli.js → dist → package root, so the default corpus is the same whether
// the command is run from the role or from the repository root.
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

// Before the defaults below read the environment, and from the package root for the
// same reason as the corpus: so the command behaves the same from either directory.
loadDotEnv(PACKAGE_ROOT);

const DEFAULT_DIR = path.join(PACKAGE_ROOT, 'eval');
// Which LM Studio to talk to is a property of the machine running the harness, not
// of the corpus, so it comes from the environment or --url.
const DEFAULT_URL = process.env.LM_STUDIO_URL ?? 'ws://localhost:1234';
// The model the service actually runs (roles/doorbell/defaults/main.yml), so a bare
// `yarn eval run` scores the deployed configuration rather than refusing to start.
// Kept in step with that file by hand: the harness runs on a laptop, nowhere near
// Ansible, and reading the role's YAML to learn one string is not worth the coupling.
const DEFAULT_MODEL = process.env.LM_STUDIO_MODEL ?? 'google/gemma-4-12b-qat';
const DEFAULT_BETA = 0.5;
/**
 * The service retries an evicted model because a missed frame is a missed cat. A
 * scored run wants the opposite. Each result carries the wall clock around its own
 * `detect`, and that number is read months later to compare one model against
 * another: silently folding backoff sleeps and burned attempts into it would put a
 * wrong figure in a kept artifact. A failure here is already cheap and honest —
 * recorded as `error` and excluded from the matrix — and a server dropping the model
 * mid-corpus is a fact about the setup worth seeing rather than smoothing over.
 */
const EVAL_ATTEMPTS = 1;
/**
 * No retries means nothing bounds a wedged server but this. Far short of the
 * service's ten minutes because a human is watching the counter tick, and it can
 * afford to be: it bounds the inference only, which on a warm model is seconds.
 */
const EVAL_DEADLINE_MS = 120_000;
/**
 * The load keeps the generous bound the service uses. A batch launched from a laptop
 * is the one caller that reliably pays a cold load — often the first thing to touch
 * that model since it was last evicted — and at `DEFAULT_CONCURRENCY` the lanes enter
 * together, so the first one's bound is the bound they all wait under. Anything tight
 * enough to keep a watched counter moving would fail the whole first lane on a model
 * that was merely coming off disk.
 */
const EVAL_LOAD_DEADLINE_MS = 600_000;
// Measured on a 12B model: two in flight buys about 1.66x, four about 1.81x, and
// eight no more than that. Decode is memory-bandwidth bound, so the extra lanes
// mostly slow each other down; two collects the bulk of it.
const DEFAULT_CONCURRENCY = 2;

const USAGE = `usage:
  yarn eval bootstrap [--dir <corpus>]
  yarn eval run       [--dir <corpus>] [--model <name>] [--url <ws://…>] [--prompt-file <f>]
                      [--limit <n>] [--concurrency <n>]
  yarn eval compare   <runA.json> <runB.json> [--beta <n>]

--url defaults to LM_STUDIO_URL, which may be set in the environment or in a .env
file next to package.json, and falls back to ws://localhost:1234.

--model defaults the same way from LM_STUDIO_MODEL, falling back to the model the
service is deployed with (${DEFAULT_MODEL}).
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
    concurrency: number;
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
    const vision = createVisionClient({
        baseUrl: options.baseUrl,
        model: options.model,
        prompt,
        attempts: EVAL_ATTEMPTS,
        deadlineMs: EVAL_DEADLINE_MS,
        loadDeadlineMs: EVAL_LOAD_DEADLINE_MS,
    });

    const startedAt = new Date();
    const name = `${stamp(startedAt)}-${slug(options.model)}`;
    const runDir = path.join(options.corpusDir, 'runs', name);
    await fs.promises.mkdir(runDir, { recursive: true });

    const scored = keys.filter((key) => onDisk.has(key)).slice(0, options.limit ?? Infinity);
    const began = performance.now();
    let completed = 0;

    const results = await mapWithConcurrency(scored, options.concurrency, async (key): Promise<ImageResult> => {
        const expected = labels[key]?.cat ?? false;
        const imagePath = path.join(images, key);
        const started = performance.now();

        // Every frame is scored, so a failure is recorded and never thrown: one bad
        // call must not abandon the frames still in flight beside it.
        const record = (result: ImageResult): ImageResult => {
            completed += 1;
            // Out of order above a concurrency of one, hence the count rather than
            // the frame's own index.
            console.log(`[${completed}/${scored.length}] ${result.outcome.padEnd(5)} ${result.ms}ms  ${key}`);
            return result;
        };

        try {
            const detections = await vision.detect(imagePath);
            const verdict = detections.length > 0;
            let annotated: string | null = null;

            const raw = await fs.promises.readFile(imagePath);
            const drawn = await annotate(raw, detections);
            annotated = `${key.replace(/\//g, '__')}`;
            await fs.promises.writeFile(path.join(runDir, annotated), drawn.buffer);

            return record({
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
            return record({
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
    });

    const scores = score(results, DEFAULT_BETA);
    const artifact: RunFile = {
        startedAt: startedAt.toISOString(),
        model: options.model,
        baseUrl: options.baseUrl,
        concurrency: options.concurrency,
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

const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
        dir: { type: 'string' },
        model: { type: 'string' },
        url: { type: 'string' },
        'prompt-file': { type: 'string' },
        limit: { type: 'string' },
        concurrency: { type: 'string' },
        beta: { type: 'string' },
    },
});

const command = positionals[0];
const corpusDir = path.resolve(values.dir ?? DEFAULT_DIR);

if (command === 'bootstrap') {
    await bootstrap(corpusDir);
} else if (command === 'run') {
    await run({
        corpusDir,
        model: values.model ?? DEFAULT_MODEL,
        baseUrl: values.url ?? DEFAULT_URL,
        promptFile: values['prompt-file'],
        limit: values.limit ? Number(values.limit) : undefined,
        concurrency: values.concurrency ? Number(values.concurrency) : DEFAULT_CONCURRENCY,
    });
} else if (command === 'compare') {
    const [, fileA, fileB] = positionals;
    if (!fileA || !fileB) fail(`compare needs two run files\n\n${USAGE}`);
    await compare(fileA, fileB, values.beta ? Number(values.beta) : DEFAULT_BETA);
} else {
    fail(USAGE);
}
