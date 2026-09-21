import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { rawFramePath } from './annotate.js';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('frames');

const RETRY_DELAY_MS = 3_000;

export interface Frame {
    at: Date;
    raw: Buffer;
    rawPath: string;
}

export function frameUrl(go2rtcUrl: string, stream: string): string {
    return `${go2rtcUrl.replace(/\/$/, '')}/api/frame.jpeg?src=${encodeURIComponent(stream)}`;
}

async function fetchFrame(url: string, signal: AbortSignal): Promise<Buffer> {
    const started = performance.now();
    const response = await fetch(url, { signal });
    log.debug('fetched', {
        url,
        status: response.status,
        content_type: response.headers.get('content-type'),
        ms: elapsedMs(started),
    });
    if (!response.ok) throw new Error(`go2rtc returned ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

/**
 * Grab one frame and persist it. The first grab after a window opens can fail
 * while go2rtc is still dialling Nest, so one retry is worth it.
 *
 * The activity window is the only deadline. `signal` aborts when it expires, so a
 * grab that go2rtc takes a minute to answer is waited out instead of being cut
 * off, and an event arriving mid-grab extends it for free. Nothing here is
 * budgeted against the poll interval: the caller awaits each grab before pacing
 * the next, so a slow one delays its successor rather than overlapping it.
 */
export async function grabFrame(options: {
    go2rtcUrl: string;
    stream: string;
    framesPath: string;
    signal: AbortSignal;
    at?: Date;
    fetchImpl?: (url: string, signal: AbortSignal) => Promise<Buffer>;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<Frame> {
    const at = options.at ?? new Date();
    const grab = options.fetchImpl ?? fetchFrame;
    const delay = options.delay ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));
    const signal = options.signal;
    const url = frameUrl(options.go2rtcUrl, options.stream);

    signal.throwIfAborted();

    const started = performance.now();
    log.debug('grabbing', { url, at });

    let raw: Buffer;
    let attempts = 1;
    try {
        raw = await grab(url, signal);
    } catch (error) {
        // A grab the window closed under is not a grab that failed, and there is
        // nothing left to retry into either way.
        if (signal.aborted) {
            log.debug('frame grab abandoned, window closed', { error });
            throw error;
        }

        log.warn('frame grab failed, retrying', { retry_in_ms: RETRY_DELAY_MS, error });
        await delay(RETRY_DELAY_MS, signal);
        signal.throwIfAborted();
        attempts = 2;
        raw = await grab(url, signal);
    }

    const rawPath = rawFramePath(options.framesPath, at);
    await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.promises.writeFile(rawPath, raw);

    log.debug('grabbed', { path: rawPath, bytes: raw.length, attempts, ms: elapsedMs(started) });

    return { at, raw, rawPath };
}
