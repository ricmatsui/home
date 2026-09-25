import fs from 'node:fs';
import path from 'node:path';
import { LMStudioClient } from '@lmstudio/sdk';
import { Jimp } from 'jimp';
import { z } from 'zod';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('vision');

// Asked in gemma's own order: it emits [ymin, xmin, ymax, xmax] — the PaliGemma
// order it was trained on — whatever the prompt says, so asking for x-first only
// mislabels what comes back.
export const PROMPT = `Detect any black animals in the image. Output only a JSON array — no
markdown fences, no explanation. Each element must be an object with keys
"box_2d" and "label", where box_2d is [ymin, xmin, ymax, xmax] and label
names the animal. The species does not matter and does not need to be
right: anything animal-shaped and black counts, so report it rather than
leaving it out because you are unsure what it is. People are not animals
here: ignore humans completely, including anyone dressed in black, and
never report a person as an animal. Include one entry per distinct animal,
including partially visible or occluded ones. If the image contains only
people, or no black animals at all, output [].`;

/** An empty string is a mistake, not an instruction, so it falls back. */
export function promptFor(prompt: string | undefined): string {
    return prompt && prompt.trim().length > 0 ? prompt : PROMPT;
}

const coordinates = z.tuple([z.number(), z.number(), z.number(), z.number()]);

/**
 * Gemma's own shape, carried unchanged through the service: `box_2d` is
 * [ymin, xmin, ymax, xmax] on a 0-1000 scale — the PaliGemma order the model was
 * trained on, and not something a prompt can talk it out of. Storing what it
 * actually said keeps a frame's `.json` comparable with the model's output; the
 * y-first reading lives in `scaleBox`, which is the one place it matters.
 */
export const detectionsSchema = z.array(
    z.object({
        label: z.string(),
        box_2d: coordinates,
    }),
);

export type Detection = z.infer<typeof detectionsSchema>[number];

const THINK_BLOCK = /<think>[\s\S]*?<\/think>/gi;
const SNIPPET_LIMIT = 400;

function snippet(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim();
    return collapsed.length > SNIPPET_LIMIT ? `${collapsed.slice(0, SNIPPET_LIMIT)}…` : collapsed;
}

/**
 * Every top-level `[…]` span in `text`, in the order they appear. Depth-counting
 * rather than a regex, so a bbox nested inside a detection stays part of its
 * enclosing array; string-aware, so a bracket inside a label does not unbalance it.
 */
function arraySpans(text: string): string[] {
    const spans: string[] = [];
    let depth = 0;
    let start = 0;
    let inString = false;
    let escaped = false;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (inString) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === '"') inString = false;
            continue;
        }

        if (character === '"') inString = true;
        else if (character === '[') {
            if (depth === 0) start = index;
            depth += 1;
        } else if (character === ']' && depth > 0) {
            depth -= 1;
            if (depth === 0) spans.push(text.slice(start, index + 1));
        }
    }

    return spans;
}

/**
 * The detections out of a free-form response. Without a grammar constraining the
 * model, the answer arrives wrapped in reasoning, prose or a code fence, so the
 * candidates are tried last first: whatever the model settled on comes after
 * whatever it was weighing.
 */
export function parseDetections(text: string): Detection[] {
    const answer = text.replace(THINK_BLOCK, ' ');

    for (const span of arraySpans(answer).reverse()) {
        let value: unknown;
        try {
            value = JSON.parse(span);
        } catch {
            continue;
        }

        const parsed = detectionsSchema.safeParse(value);
        if (parsed.success) return parsed.data;
    }

    throw new UnparseableResponseError(text);
}

/** The model answered, but not with anything the schema recognises. */
export class UnparseableResponseError extends Error {
    constructor(text: string) {
        super(`no JSON array matching the detections schema in the response: "${snippet(text)}"`);
        this.name = 'UnparseableResponseError';
    }
}

/** The attempt ran past its own deadline. */
export class InferenceTimeoutError extends Error {
    constructor(readonly deadlineMs: number) {
        super(`the model did not answer within ${deadlineMs}ms`);
        this.name = 'InferenceTimeoutError';
    }
}

/** The caller gave up — the process is shutting down. */
export class InferenceAbortedError extends Error {
    constructor() {
        super('the inference was abandoned');
        this.name = 'InferenceAbortedError';
    }
}

/**
 * The discriminant LM Studio puts on its own errors — `generic.specificModelUnloaded`
 * when the handle we hold has been evicted, `generic.noModelMatchingQuery` when the
 * server has nothing matching the key. Worth lifting out because the logger renders
 * an Error as `name: message` and would otherwise drop it.
 */
export function errorCode(error: unknown): string | undefined {
    const code = (error as { displayData?: { code?: unknown } })?.displayData?.code;
    return typeof code === 'string' ? code : undefined;
}

/**
 * Whether another attempt could plausibly answer differently.
 *
 * The default is yes: an evicted model, a refused connection, a dropped socket and a
 * truncated answer are all the server having a bad moment, and the next attempt gets
 * a fresh handle. The exceptions are failures another attempt cannot change — a
 * deadline that has already been spent, a caller that has stopped caring, and a
 * response the model will produce again verbatim, since it runs at temperature 0.
 */
export function retryable(error: unknown): boolean {
    return !(
        error instanceof UnparseableResponseError ||
        error instanceof InferenceTimeoutError ||
        error instanceof InferenceAbortedError
    );
}

/**
 * Run `run` under a signal that fires when `deadlineMs` elapses or when the caller's
 * own signal does, and translate an abort into which of the two it was. The
 * difference is what `retryable` reads: both are final, but a spent deadline means
 * the server is unreachable and a caller abort means the process is going away.
 */
export async function withDeadline<T>(
    run: (signal: AbortSignal) => Promise<T>,
    options: { deadlineMs: number; signal?: AbortSignal },
): Promise<T> {
    // Checked before the timer is even armed: a frame that waited out the shutdown in
    // the queue must not open a request, and a run watching for an `abort` event it
    // has already missed would wait for one that never comes.
    if (options.signal?.aborted) throw new InferenceAbortedError();

    const timeout = AbortSignal.timeout(options.deadlineMs);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;

    try {
        return await run(signal);
    } catch (error) {
        // The caller is asked first: a shutdown that happens to land on the deadline
        // is still a shutdown.
        if (options.signal?.aborted) throw new InferenceAbortedError();
        if (timeout.aborted) throw new InferenceTimeoutError(options.deadlineMs);
        throw error;
    }
}

/** Doubling from a second, for the 1-indexed attempt that just failed. */
export function backoffMs(attempt: number): number {
    return 1000 * 2 ** (attempt - 1);
}

export interface RetryOptions {
    attempts: number;
    /** Injectable so tests do not wait; node:test's mock clock cannot reach a real one. */
    sleep?: (ms: number) => Promise<void>;
    onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/**
 * Run `run` until it succeeds, `attempts` is exhausted, or it fails with something
 * `retryable` says another attempt cannot change. The last error is what surfaces.
 */
export async function withRetries<T>(run: (attempt: number) => Promise<T>, options: RetryOptions): Promise<T> {
    const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

    for (let attempt = 1; ; attempt += 1) {
        try {
            return await run(attempt);
        } catch (error) {
            if (attempt >= options.attempts || !retryable(error)) throw error;

            const delayMs = backoffMs(attempt);
            options.onRetry?.(error, attempt, delayMs);
            await sleep(delayMs);
        }
    }
}

/** The model ran out of things to say. Every other stop reason cut it off. */
const CLEAN_STOPS = new Set(['eosFound', 'stopStringFound']);

export class TruncatedResponseError extends Error {
    constructor(readonly stopReason: string) {
        super(`the model stopped early: ${stopReason}`);
        this.name = 'TruncatedResponseError';
    }
}

/**
 * Guards the response before anything reads it. A prediction interrupted partway —
 * `modelUnloaded` when the server evicts the model mid-answer, `contextLengthReached`
 * when it runs out of room — still resolves, carrying whatever text it had managed.
 * Parsing that text is the danger: `arraySpans` is depth-counting, so a cut-off
 * detections array never closes and is never a candidate, which leaves the *last
 * balanced array the model was weighing* as the answer. A truncated response is not
 * evidence about the porch, so it is thrown out rather than read.
 */
export function assertComplete(stopReason: string | undefined): void {
    // An absent stop reason is not evidence of truncation; only a known-bad one is.
    if (stopReason === undefined || CLEAN_STOPS.has(stopReason)) return;
    throw new TruncatedResponseError(stopReason);
}

export interface Box {
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
}

/** Convert gemma's 0-1000 normalised [ymin, xmin, ymax, xmax] to frame pixels. */
export function scaleBox(box: [number, number, number, number], width: number, height: number): Box {
    const clamp = (value: number, size: number) => Math.min(Math.max(Math.round(value), 0), size - 1);
    const [rawYMin, rawXMin, rawYMax, rawXMax] = box;

    const x1 = clamp((rawXMin / 1000) * width, width);
    const x2 = clamp((rawXMax / 1000) * width, width);
    const y1 = clamp((rawYMin / 1000) * height, height);
    const y2 = clamp((rawYMax / 1000) * height, height);

    return {
        xMin: Math.min(x1, x2),
        yMin: Math.min(y1, y2),
        xMax: Math.max(x1, x2),
        yMax: Math.max(y1, y2),
    };
}

/**
 * Gemma spends soft tokens in proportion to the image's pixels, and a 512x384 frame
 * earns only ~90 of them — about 47 source pixels per token, too coarse for a cat at
 * the far end of the porch. Sending it at twice the size earns ~338 instead.
 */
const UPSCALE = 2;

/** Resample by `factor`. Boxes are unaffected: they come back on a 0-1000 scale. */
export async function upscale(raw: Buffer, factor: number): Promise<Buffer> {
    const image = await Jimp.fromBuffer(raw);

    image.resize({ w: image.width * factor, h: image.height * factor });

    return image.getBuffer('image/jpeg', { quality: 90 });
}

export interface Once<T, A extends unknown[] = []> {
    (...args: A): Promise<T>;
    /** Discard what was memoised, so the next call builds it again. */
    reset(): void;
}

/**
 * Memoise an async factory. The *promise* is cached, not its result: with the eval
 * harness running frames concurrently, caching only the settled value lets several
 * first callers each start their own model load. A rejection is not cached, so a
 * server that was down when the first frame arrived can still serve the second.
 *
 * Arguments belong to whichever call found the memo cold — a later caller joins the
 * load already in flight and its own are ignored. That is the right trade for the
 * abort signal this carries: one frame's deadline governing a shared load is better
 * than every frame starting a load of its own.
 */
export function once<T, A extends unknown[]>(factory: (...args: A) => Promise<T>): Once<T, A> {
    let pending: Promise<T> | null = null;

    const get = (...args: A) => {
        if (!pending) {
            pending = factory(...args).catch((error: unknown) => {
                pending = null;
                throw error;
            });
        }

        return pending;
    };

    get.reset = () => {
        pending = null;
    };

    return get;
}

/** One attempt, then the five retries a server we do not own has earned. */
const ATTEMPTS = 6;

/**
 * Bounds the inference alone, per attempt. A late frame still beats a dropped one, so
 * only a host that has genuinely stopped answering should ever reach it. Spending it
 * is final — `retryable` does not hand another ten minutes to a server that just
 * ignored the first.
 */
const DEADLINE_MS = 600_000;

/**
 * Bounds the model load, which is a different animal on a different timescale: it
 * happens once per process, and a slow one means a cold 12B coming off disk on a busy
 * machine — minutes, legitimately — rather than a server in trouble. One number
 * covering both would have to be generous enough for the load, which would then be
 * the bound every inference inherited.
 *
 * It is also the one bound a caller can impose on work others are waiting for: the
 * memoised load carries the signal of whichever call found it cold, so an impatient
 * deadline here fails every caller queued behind that load, not just its owner. At
 * this length only a genuinely wedged server reaches it, and failing them all is then
 * the right answer.
 */
const LOAD_DEADLINE_MS = 600_000;

/**
 * Idle TTL on the JIT load, long enough that the model outlives the gaps between
 * doorbell events. It only governs *idle* unloading: it cannot stop the server
 * evicting the model to make room for a different one, which is what the retries and
 * the server's own JIT settings are for.
 */
const MODEL_TTL_S = 3600;

export interface DetectOptions {
    /**
     * Abandons the call. This is the process shutting down, deliberately not the
     * activity window closing — a frame already grabbed is worth finishing whenever
     * it finishes.
     */
    signal?: AbortSignal;
}

export interface VisionClient {
    detect(imagePath: string, options?: DetectOptions): Promise<Detection[]>;
}

export function createVisionClient(options: {
    baseUrl: string;
    model: string;
    prompt?: string;
    attempts?: number;
    deadlineMs?: number;
    loadDeadlineMs?: number;
}): VisionClient {
    const client = new LMStudioClient({ baseUrl: options.baseUrl });
    const prompt = promptFor(options.prompt);
    const attempts = options.attempts ?? ATTEMPTS;
    const deadlineMs = options.deadlineMs ?? DEADLINE_MS;
    const loadDeadlineMs = options.loadDeadlineMs ?? LOAD_DEADLINE_MS;

    // First inference of the process pays for loading the model; the rest wait on
    // the same promise rather than each asking for a load of their own.
    const loadModel = once(async (signal: AbortSignal) => {
        const started = performance.now();
        log.debug('loading model', { model: options.model });
        const loaded = await client.llm.model(options.model, { ttl: MODEL_TTL_S, signal });
        log.debug('model loaded', { model: options.model, ms: elapsedMs(started) });
        return loaded;
    });

    log.debug('client created', {
        base_url: options.baseUrl,
        model: options.model,
        attempts,
        deadline_ms: deadlineMs,
        load_deadline_ms: loadDeadlineMs,
    });

    return {
        async detect(imagePath: string, detectOptions: DetectOptions = {}): Promise<Detection[]> {
            const started = performance.now();

            // Resampling is pure CPU and identical every time, so it happens once
            // rather than per attempt. Everything the server holds is redone inside
            // one: a reload invalidates the handle *and* the uploaded file.
            const enlarged = await upscale(await fs.promises.readFile(imagePath), UPSCALE);

            const attemptOnce = async (attempt: number): Promise<Detection[]> => {
                // Bounded on its own clock: see LOAD_DEADLINE_MS. Once the model is up
                // this resolves from the memo and the deadline never arms at all.
                const model = await withDeadline(
                    (signal) => loadModel(signal),
                    { deadlineMs: loadDeadlineMs, signal: detectOptions.signal },
                );

                return withDeadline(async (signal) => {
                    const image = await client.files.prepareImageBase64(
                        path.basename(imagePath),
                        enlarged.toString('base64'),
                    );
                    const prepared = performance.now();
                    log.debug('image prepared', { path: imagePath, upscale: UPSCALE, attempt });

                    // Unconstrained on purpose: a grammar would forbid the model from
                    // thinking before it answers, so the JSON is parsed out of the text
                    // instead. Reasoning models get their <think> block separated here;
                    // for the rest nonReasoningContent is simply the whole response.
                    const result = await model.respond(
                        [{ role: 'user', content: prompt, images: [image] }],
                        { temperature: 0, signal },
                    );

                    // Before anything reads the text: a prediction the server
                    // interrupted still resolves, carrying a partial answer that must
                    // not be parsed.
                    assertComplete(result.stats?.stopReason);

                    const detections = parseDetections(result.nonReasoningContent || result.content);

                    log.debug('inferred', {
                        path: imagePath,
                        attempt,
                        detections: detections.length,
                        labels: detections.map((detection) => detection.label).join(',') || 'none',
                        tokens: result.stats?.predictedTokensCount,
                        prompt_tokens: result.stats?.promptTokensCount,
                        reasoning_chars: result.reasoningContent.length,
                        stop_reason: result.stats?.stopReason,
                        infer_ms: elapsedMs(prepared),
                        ms: elapsedMs(started),
                    });

                    return detections;
                }, { deadlineMs, signal: detectOptions.signal });
            };

            return withRetries((attempt) => attemptOnce(attempt).catch((error: unknown) => {
                // LM Studio evicts one JIT model to load another and the handle we
                // hold dies with it — permanently, since it is memoised. Any failure
                // the server could be behind is reason enough to fetch a fresh one;
                // it costs a getOrLoad and nothing when the model is up. A response
                // we simply could not read is not one of those: the model is alive
                // and answering, and would be reloaded for nothing.
                if (retryable(error)) loadModel.reset();
                throw error;
            }), {
                attempts,
                // A retry that goes on to succeed would otherwise leave no trace at
                // all, and a server flapping every third frame would look healthy.
                onRetry: (error, attempt, delayMs) => log.warn('inference failed, retrying', {
                    path: imagePath,
                    attempt,
                    attempts,
                    code: errorCode(error),
                    error,
                    retry_in_ms: delayMs,
                    ms: elapsedMs(started),
                }),
            });
        },
    };
}
