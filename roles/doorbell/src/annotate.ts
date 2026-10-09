import fs from 'node:fs';
import path from 'node:path';
import { Jimp } from 'jimp';
import { Box, Detection, scaleBox } from './vision.js';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('annotate');

const BOX_COLOR = 0xff0000ff; // opaque red, RGBA
const TRUTH_COLOR = 0x00ff00ff; // opaque green: the labelled box, drawn only by the eval
const BOX_THICKNESS = 2;

export type Verdict = 'cat' | 'nocat';

/** Minimal surface of a Jimp image, so drawing can be tested without decoding one. */
export interface DrawableImage {
    width: number;
    height: number;
    setPixelColor(hex: number, x: number, y: number): unknown;
}

function pad(value: number): string {
    return String(value).padStart(2, '0');
}

function frameDay(at: Date): string {
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function frameTime(at: Date): string {
    return `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
}

export function rawFramePath(framesPath: string, at: Date): string {
    return path.join(framesPath, frameDay(at), `${frameTime(at)}.raw.jpg`);
}

export function resultPaths(framesPath: string, at: Date, verdict: Verdict): { annotated: string; json: string } {
    const dir = path.join(framesPath, frameDay(at));
    return {
        annotated: path.join(dir, `${frameTime(at)}-${verdict}.jpg`),
        json: path.join(dir, `${frameTime(at)}.json`),
    };
}

export function drawBoxes(image: DrawableImage, boxes: Box[], color = BOX_COLOR): void {
    for (const unclamped of boxes) {
        // A hand-drawn box may run to the far edge, one past the last pixel.
        const box = {
            xMin: Math.min(unclamped.xMin, image.width - 1),
            yMin: Math.min(unclamped.yMin, image.height - 1),
            xMax: Math.min(unclamped.xMax, image.width - 1),
            yMax: Math.min(unclamped.yMax, image.height - 1),
        };
        for (let thickness = 0; thickness < BOX_THICKNESS; thickness += 1) {
            const top = Math.min(box.yMin + thickness, image.height - 1);
            const bottom = Math.max(box.yMax - thickness, 0);
            const left = Math.min(box.xMin + thickness, image.width - 1);
            const right = Math.max(box.xMax - thickness, 0);

            for (let x = box.xMin; x <= box.xMax; x += 1) {
                image.setPixelColor(color, x, top);
                image.setPixelColor(color, x, bottom);
            }
            for (let y = box.yMin; y <= box.yMax; y += 1) {
                image.setPixelColor(color, left, y);
                image.setPixelColor(color, right, y);
            }
        }
    }
}

/**
 * Decode once: the frame's real size is what the 0-1000 coordinates scale against.
 * `truth` is the labelled box, which the eval draws underneath so a drifting box
 * shows as the gap between the two.
 */
export async function annotate(
    raw: Buffer,
    detections: Detection[],
    truth?: Box | null,
): Promise<{ buffer: Buffer; boxes: Box[] }> {
    const started = performance.now();
    const image = await Jimp.fromBuffer(raw);
    const boxes = detections.map((detection) => scaleBox(detection.box_2d, image.width, image.height));

    if (truth) drawBoxes(image, [truth], TRUTH_COLOR);
    drawBoxes(image, boxes);

    const buffer = await image.getBuffer('image/jpeg', { quality: 90 });

    log.debug('annotated', {
        width: image.width,
        height: image.height,
        boxes: JSON.stringify(boxes),
        bytes: buffer.length,
        ms: elapsedMs(started),
    });

    return { buffer, boxes };
}

export async function writeResult(options: {
    framesPath: string;
    at: Date;
    verdict: Verdict;
    annotated: Buffer | null;
    body: unknown;
}): Promise<void> {
    const paths = resultPaths(options.framesPath, options.at, options.verdict);

    await fs.promises.mkdir(path.dirname(paths.json), { recursive: true });
    if (options.annotated) await fs.promises.writeFile(paths.annotated, options.annotated);
    await fs.promises.writeFile(paths.json, `${JSON.stringify(options.body, null, 2)}\n`);

    log.debug('wrote result', {
        verdict: options.verdict,
        json: paths.json,
        annotated: options.annotated ? paths.annotated : 'none',
    });
}
