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
export const PROMPT = `Detect any cats in the image. Output only a JSON array — no markdown
fences, no explanation. Each element must be an object with keys
"box_2d" and "label", where box_2d is [ymin, xmin, ymax, xmax] and
label is "cat". Include one entry per distinct cat, including partially
visible or occluded ones. If there are no cats, output [].`;

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

    throw new Error(`no JSON array matching the detections schema in the response: "${snippet(text)}"`);
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

export function hasCat(detections: Detection[]): boolean {
    return detections.some((detection) => detection.label.trim().toLowerCase() === 'cat');
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

export interface Once<T> {
    (): Promise<T>;
    /** Discard what was memoised, so the next call builds it again. */
    reset(): void;
}

/**
 * Memoise an async factory. The *promise* is cached, not its result: with the eval
 * harness running frames concurrently, caching only the settled value lets several
 * first callers each start their own model load. A rejection is not cached, so a
 * server that was down when the first frame arrived can still serve the second.
 */
export function once<T>(factory: () => Promise<T>): Once<T> {
    let pending: Promise<T> | null = null;

    const get = () => {
        if (!pending) {
            pending = factory().catch((error: unknown) => {
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

export interface VisionClient {
    detect(imagePath: string): Promise<Detection[]>;
}

export function createVisionClient(options: { baseUrl: string; model: string; prompt?: string }): VisionClient {
    const client = new LMStudioClient({ baseUrl: options.baseUrl });
    const prompt = promptFor(options.prompt);

    // First inference of the process pays for loading the model; the rest wait on
    // the same promise rather than each asking for a load of their own.
    const loadModel = once(async () => {
        const started = performance.now();
        log.debug('loading model', { model: options.model });
        const loaded = await client.llm.model(options.model);
        log.debug('model loaded', { model: options.model, ms: elapsedMs(started) });
        return loaded;
    });

    log.debug('client created', { base_url: options.baseUrl, model: options.model });

    return {
        async detect(imagePath: string): Promise<Detection[]> {
            const started = performance.now();

            const model = await loadModel();

            const enlarged = await upscale(await fs.promises.readFile(imagePath), UPSCALE);
            const image = await client.files.prepareImageBase64(
                path.basename(imagePath),
                enlarged.toString('base64'),
            );
            const prepared = performance.now();
            log.debug('image prepared', { path: imagePath, upscale: UPSCALE, ms: elapsedMs(started) });

            // Unconstrained on purpose: a grammar would forbid the model from
            // thinking before it answers, so the JSON is parsed out of the text
            // instead. Reasoning models get their <think> block separated here;
            // for the rest nonReasoningContent is simply the whole response.
            let result;
            try {
                result = await model.respond(
                    [{ role: 'user', content: prompt, images: [image] }],
                    { temperature: 0 },
                );
            } catch (error) {
                // LM Studio evicts one JIT model to load another, and the handle we
                // hold dies with it — permanently, since it is memoised. Anything
                // else asking that server for a different model would otherwise end
                // this process's inference for good. Dropping the handle costs a
                // getOrLoad on the next frame and nothing when the model is up.
                loadModel.reset();
                throw error;
            }

            const detections = parseDetections(result.nonReasoningContent || result.content);

            log.debug('inferred', {
                path: imagePath,
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
        },
    };
}
