import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { FrameSource, rawFramePath } from './annotate.js';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('frames');

const RETRY_DELAY_MS = 3_000;

/**
 * Per attempt. A healthy grab, Nest dial included, lands in a few seconds; one
 * still waiting at this point is stuck on a stream that connected but stopped
 * sending, which go2rtc answers only once Nest drops it, often long after the
 * window has closed. Under go2rtc's own 30s keyframe limit, so giving up here is
 * what releases its side.
 */
const ATTEMPT_TIMEOUT_MS = 20_000;

export interface Frame {
    at: Date;
    source: FrameSource;
    raw: Buffer;
    rawPath: string;
}

/** Persists the raw image before inference, which reads it back from disk. */
export async function saveFrame(options: {
    framesPath: string;
    at: Date;
    source: FrameSource;
    raw: Buffer;
}): Promise<Frame> {
    const rawPath = rawFramePath(options.framesPath, options.at, options.source);
    await fs.promises.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.promises.writeFile(rawPath, options.raw);
    return { at: options.at, source: options.source, raw: options.raw, rawPath };
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
 * Each attempt is bounded by `ATTEMPT_TIMEOUT_MS` as well as by the activity
 * window, whose `signal` aborts when it expires. A timed-out attempt is a failure
 * and gets the retry; one the window closed under is not, and does not. Nothing
 * here is budgeted against the poll interval: the caller awaits each grab before
 * pacing the next, so a slow one delays its successor rather than overlapping it.
 */
export async function grabFrame(options: {
    go2rtcUrl: string;
    stream: string;
    framesPath: string;
    signal: AbortSignal;
    at?: Date;
    attemptTimeoutMs?: number;
    fetchImpl?: (url: string, signal: AbortSignal) => Promise<Buffer>;
    delay?: (ms: number, signal: AbortSignal) => Promise<void>;
}): Promise<Frame> {
    const at = options.at ?? new Date();
    const fetchImpl = options.fetchImpl ?? fetchFrame;
    const delay = options.delay ?? ((ms: number, signal: AbortSignal) => sleep(ms, undefined, { signal }));
    const signal = options.signal;
    const url = frameUrl(options.go2rtcUrl, options.stream);
    const attemptTimeoutMs = options.attemptTimeoutMs ?? ATTEMPT_TIMEOUT_MS;
    const grab = (): Promise<Buffer> =>
        fetchImpl(url, AbortSignal.any([signal, AbortSignal.timeout(attemptTimeoutMs)]));

    signal.throwIfAborted();

    const started = performance.now();
    log.debug('grabbing', { url, at });

    let raw: Buffer;
    let attempts = 1;
    try {
        raw = await grab();
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
        raw = await grab();
    }

    const frame = await saveFrame({ framesPath: options.framesPath, at, source: 'stream', raw });

    log.debug('grabbed', { path: frame.rawPath, bytes: raw.length, attempts, ms: elapsedMs(started) });

    return frame;
}
