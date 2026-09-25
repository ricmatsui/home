import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Jimp } from 'jimp';
import {
    InferenceAbortedError,
    InferenceTimeoutError,
    TruncatedResponseError,
    UnparseableResponseError,
    backoffMs,
    errorCode,
    retryable,
    withDeadline,
    withRetries,
    assertComplete,
    PROMPT,
    detectionsSchema,
    once,
    parseDetections,
    promptFor,
    scaleBox,
    upscale,
} from './vision.js';

test('scales a full-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 1000, 1000], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('scales a half-frame box', () => {
    assert.deepEqual(scaleBox([0, 0, 500, 500], 512, 384), { xMin: 0, yMin: 0, xMax: 256, yMax: 192 });
});

test('reads the coordinates y first, as gemma reports them', () => {
    // [ymin, xmin, ymax, xmax]: the full height of the frame, the left half of it.
    assert.deepEqual(scaleBox([0, 0, 1000, 500], 512, 384), { xMin: 0, yMin: 0, xMax: 256, yMax: 383 });
});

test('clamps coordinates beyond the 0-1000 scale', () => {
    assert.deepEqual(scaleBox([-50, -50, 1200, 1200], 512, 384), { xMin: 0, yMin: 0, xMax: 511, yMax: 383 });
});

test('normalises an inverted box', () => {
    const box = scaleBox([800, 800, 200, 200], 1000, 1000);

    assert.equal(box.xMin, 200);
    assert.equal(box.xMax, 800);
    assert.equal(box.yMin, 200);
    assert.equal(box.yMax, 800);
});

test('the schema accepts a well-formed response', () => {
    const parsed = detectionsSchema.parse([{ label: 'cat', box_2d: [10, 20, 30, 40] }]);

    assert.equal(parsed[0].label, 'cat');
    assert.deepEqual(parsed[0].box_2d, [10, 20, 30, 40]);
});

test('the schema rejects a short bbox', () => {
    assert.throws(() => detectionsSchema.parse([{ label: 'cat', box_2d: [10, 20, 30] }]));
});

test('the prompt defaults to the shipped one', () => {
    assert.equal(promptFor(undefined), PROMPT);
});

test('an explicit prompt overrides the shipped one', () => {
    assert.equal(promptFor('find dogs'), 'find dogs');
});

test('an empty prompt falls back rather than asking the model nothing', () => {
    assert.equal(promptFor(''), PROMPT);
});

test('parses a bare JSON array', () => {
    const parsed = parseDetections('[{"label": "cat", "box_2d": [10, 20, 30, 40]}]');

    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].label, 'cat');
});

test('keeps the coordinates exactly as the model reported them', () => {
    const parsed = parseDetections('[{"label": "cat", "box_2d": [100, 200, 300, 400]}]');

    assert.deepEqual(parsed[0].box_2d, [100, 200, 300, 400]);
});

test('rejects bbox_2d, the key gemma sometimes writes instead of box_2d', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "bbox_2d": [100, 200, 300, 400]}]'), /no JSON/);
});

test('throws when a detection carries no box at all', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "coords": [1, 2, 3, 4]}]'), /no JSON/);
});

test('parses an empty list', () => {
    assert.deepEqual(parseDetections('[]'), []);
});

test('parses a fenced JSON block', () => {
    const text = 'Here is the result:\n```json\n[{"label": "cat", "box_2d": [1, 2, 3, 4]}]\n```\n';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [1, 2, 3, 4] }]);
});

test('parses JSON that follows prose', () => {
    const text = 'I can see one cat on the step [it is sitting].\n[{"label": "cat", "box_2d": [5, 6, 7, 8]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [5, 6, 7, 8] }]);
});

test('ignores an array inside a think block', () => {
    const text = '<think>maybe [{"label": "dog", "box_2d": [0, 0, 1, 1]}] is right</think>\n' +
        '[{"label": "cat", "box_2d": [9, 9, 9, 9]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat', box_2d: [9, 9, 9, 9] }]);
});

test('ignores brackets inside a JSON string value', () => {
    const text = '[{"label": "cat [tabby]", "box_2d": [1, 2, 3, 4]}]';

    assert.deepEqual(parseDetections(text), [{ label: 'cat [tabby]', box_2d: [1, 2, 3, 4] }]);
});

test('throws when the response contains no JSON at all', () => {
    assert.throws(() => parseDetections('I am unable to look at images.'), /no JSON/);
});

test('throws when the JSON does not match the schema', () => {
    assert.throws(() => parseDetections('[{"label": "cat", "box_2d": [10, 20, 30]}]'), /no JSON/);
});

test('the parse error quotes what the model said', () => {
    assert.throws(() => parseDetections('sorry, no cats today'), /sorry, no cats today/);
});

test('the prompt asks for the key and order gemma actually emits', () => {
    assert.match(PROMPT, /box_2d/);
    assert.match(PROMPT, /ymin, xmin, ymax, xmax/);
});

test('upscale multiplies both dimensions', async () => {
    const source = await new Jimp({ width: 8, height: 6, color: 0xff0000ff }).getBuffer('image/jpeg');
    const bigger = await Jimp.fromBuffer(await upscale(source, 2));

    assert.equal(bigger.width, 16);
    assert.equal(bigger.height, 12);
});

test('upscale leaves the image readable', async () => {
    const source = await new Jimp({ width: 8, height: 6, color: 0xff0000ff }).getBuffer('image/jpeg');
    const bigger = await Jimp.fromBuffer(await upscale(source, 2));
    const pixel = bigger.getPixelColor(8, 6);

    // Still a red frame in the middle. Exact equality would be testing JPEG, which
    // comes back a point or two short of 0xff however little the resampling did.
    assert.ok((pixel >>> 24) > 0xf0, `red channel ${pixel >>> 24}`);
    assert.ok(((pixel >>> 16) & 0xff) < 0x10, `green channel ${(pixel >>> 16) & 0xff}`);
});

test('once runs the factory a single time for concurrent callers', async () => {
    let calls = 0;
    const load = once(async () => {
        calls += 1;
        await new Promise((resolve) => setTimeout(resolve, 5));
        return 'model';
    });

    const [first, second] = await Promise.all([load(), load()]);

    assert.equal(calls, 1);
    assert.equal(first, 'model');
    assert.equal(second, 'model');
});

test('once keeps returning the first result', async () => {
    let calls = 0;
    const load = once(async () => `model ${(calls += 1)}`);

    assert.equal(await load(), 'model 1');
    assert.equal(await load(), 'model 1');
});

test('once retries after a failure rather than caching it forever', async () => {
    let calls = 0;
    const load = once(async () => {
        calls += 1;
        if (calls === 1) throw new Error('lm studio is down');
        return 'model';
    });

    await assert.rejects(load(), /lm studio is down/);
    assert.equal(await load(), 'model');
});

test('once can be reset, so a dead handle is not cached forever', async () => {
    let calls = 0;
    const load = once(async () => `model ${(calls += 1)}`);

    assert.equal(await load(), 'model 1');
    load.reset();

    assert.equal(await load(), 'model 2');
});

test('a response the model finished on its own terms is complete', () => {
    assert.doesNotThrow(() => assertComplete('eosFound'));
    assert.doesNotThrow(() => assertComplete('stopStringFound'));
});

test('a response cut short by eviction is rejected before it is parsed', () => {
    assert.throws(() => assertComplete('modelUnloaded'), TruncatedResponseError);
});

test('a response cut short by the context length is rejected', () => {
    assert.throws(() => assertComplete('contextLengthReached'), /contextLengthReached/);
});

test('a response with no stats is taken at face value', () => {
    // The stop reason is optional on the SDK's result; an absent one is not
    // evidence of truncation, and inventing a failure here would lose good frames.
    assert.doesNotThrow(() => assertComplete(undefined));
});

test('reads the error code LM Studio puts on an evicted model', () => {
    const error = Object.assign(new Error('Model unloaded'), {
        displayData: { code: 'generic.specificModelUnloaded' },
    });

    assert.equal(errorCode(error), 'generic.specificModelUnloaded');
});

test('an error carrying no display data has no code', () => {
    assert.equal(errorCode(new Error('socket hang up')), undefined);
});

test('a model the server no longer has loaded is worth retrying', () => {
    const error = Object.assign(new Error('No model matching query'), {
        displayData: { code: 'generic.noModelMatchingQuery' },
    });

    assert.equal(retryable(error), true);
});

test('a connection failure is worth retrying', () => {
    assert.equal(retryable(new Error('connect ECONNREFUSED 127.0.0.1:1234')), true);
});

test('a response cut short by eviction is worth retrying', () => {
    assert.equal(retryable(new TruncatedResponseError('modelUnloaded')), true);
});

test('an unparseable response is not retried, because temperature is zero', () => {
    // The same image and the same prompt produce the same text; a retry would
    // spend a model load to be told the same thing again.
    assert.equal(retryable(new UnparseableResponseError('sorry, no cats today')), false);
});

test('a call that already burned its deadline is not retried', () => {
    assert.equal(retryable(new InferenceTimeoutError(600_000)), false);
});

test('a call abandoned at shutdown is not retried', () => {
    assert.equal(retryable(new InferenceAbortedError()), false);
});

test('parseDetections throws the unparseable error, so callers can classify it', () => {
    assert.throws(() => parseDetections('sorry, no cats today'), UnparseableResponseError);
});

test('the backoff doubles from a second', () => {
    assert.deepEqual([1, 2, 3, 4, 5].map(backoffMs), [1000, 2000, 4000, 8000, 16000]);
});

/** Records what it was asked to wait for without actually waiting. */
function fakeSleep(): { waits: number[]; sleep: (ms: number) => Promise<void> } {
    const waits: number[] = [];
    return { waits, sleep: async (ms: number) => void waits.push(ms) };
}

test('a call that succeeds first time never sleeps', async () => {
    const { waits, sleep } = fakeSleep();

    assert.equal(await withRetries(async () => 'ok', { attempts: 6, sleep }), 'ok');
    assert.deepEqual(waits, []);
});

test('a retryable failure is tried again and can still succeed', async () => {
    let calls = 0;
    const { sleep } = fakeSleep();

    const result = await withRetries(async () => {
        calls += 1;
        if (calls < 3) throw new TruncatedResponseError('modelUnloaded');
        return 'ok';
    }, { attempts: 6, sleep });

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
});

test('five retries follow the first attempt, then it gives up', async () => {
    let calls = 0;
    const { sleep } = fakeSleep();

    await assert.rejects(withRetries(async () => {
        calls += 1;
        throw new Error('connect ECONNREFUSED');
    }, { attempts: 6, sleep }), /ECONNREFUSED/);

    assert.equal(calls, 6);
});

test('it backs off between attempts, and not after the last one', async () => {
    const { waits, sleep } = fakeSleep();

    await assert.rejects(withRetries(async () => {
        throw new Error('connect ECONNREFUSED');
    }, { attempts: 4, sleep }));

    assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('a failure another attempt cannot change is thrown at once', async () => {
    let calls = 0;
    const { sleep } = fakeSleep();

    await assert.rejects(withRetries(async () => {
        calls += 1;
        throw new UnparseableResponseError('sorry, no cats today');
    }, { attempts: 6, sleep }), UnparseableResponseError);

    assert.equal(calls, 1);
});

test('each attempt is told which attempt it is', async () => {
    const seen: number[] = [];
    const { sleep } = fakeSleep();

    await assert.rejects(withRetries(async (attempt) => {
        seen.push(attempt);
        throw new Error('connect ECONNREFUSED');
    }, { attempts: 3, sleep }));

    assert.deepEqual(seen, [1, 2, 3]);
});

test('every retry is reported, so a recovered failure still leaves a trace', async () => {
    const reported: Array<{ attempt: number; delayMs: number }> = [];
    const { sleep } = fakeSleep();

    await withRetries(async (attempt) => {
        if (attempt < 3) throw new TruncatedResponseError('modelUnloaded');
        return 'ok';
    }, {
        attempts: 6,
        sleep,
        onRetry: (_error, attempt, delayMs) => reported.push({ attempt, delayMs }),
    });

    assert.deepEqual(reported, [{ attempt: 1, delayMs: 1000 }, { attempt: 2, delayMs: 2000 }]);
});

test('a call that finishes inside its deadline returns normally', async () => {
    assert.equal(await withDeadline(async () => 'ok', { deadlineMs: 1000 }), 'ok');
});

test('the run is handed a signal that fires when the deadline passes', async () => {
    await assert.rejects(
        withDeadline((signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }), { deadlineMs: 5 }),
        InferenceTimeoutError,
    );
});

test('the timeout error names the deadline it spent', async () => {
    await assert.rejects(
        withDeadline((signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }), { deadlineMs: 5 }),
        /5ms/,
    );
});

test('a caller that has already given up is not made to wait', async () => {
    await assert.rejects(
        withDeadline((signal) => new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        }), { deadlineMs: 60_000, signal: AbortSignal.abort() }),
        InferenceAbortedError,
    );
});

test('a shutdown mid-call reads as abandoned, not as a spent deadline', async () => {
    const controller = new AbortController();
    const pending = withDeadline((signal) => new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { deadlineMs: 60_000, signal: controller.signal });

    controller.abort();

    await assert.rejects(pending, InferenceAbortedError);
});

test('a failure of its own is not mistaken for a deadline', async () => {
    await assert.rejects(
        withDeadline(async () => { throw new Error('socket hang up'); }, { deadlineMs: 60_000 }),
        /socket hang up/,
    );
});

test('a caller that has already given up never reaches the server', async () => {
    let called = false;

    await assert.rejects(withDeadline(async () => {
        called = true;
        return 'ok';
    }, { deadlineMs: 60_000, signal: AbortSignal.abort() }), InferenceAbortedError);

    assert.equal(called, false);
});

test('once hands the factory the arguments of the call that woke it', async () => {
    const seen: string[] = [];
    const load = once(async (label: string) => {
        seen.push(label);
        return label;
    });

    assert.equal(await load('first'), 'first');
    assert.deepEqual(seen, ['first']);
});

test('a caller that finds the memo warm does not re-run the factory with its own arguments', async () => {
    // The memo means the first caller's arguments govern the shared load. Worth
    // stating outright: a later caller's signal has no say over a load in flight.
    const seen: string[] = [];
    const load = once(async (label: string) => {
        seen.push(label);
        return label;
    });

    assert.equal(await load('first'), 'first');
    assert.equal(await load('second'), 'first');
    assert.deepEqual(seen, ['first']);
});
