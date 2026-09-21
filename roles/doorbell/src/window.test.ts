import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ActivityWindow } from './window.js';

// The tick loop awaits its callback, so every assertion has to let the pending
// continuations run first. setImmediate is left unmocked precisely for this.
function flush(): Promise<void> {
    return new Promise((resolve) => { setImmediate(resolve); });
}

// The global timer, not node:timers/promises: the mock clock reaches one and not
// the other, and a grab on the wrong one would sleep for real.
function grabbing(ms: number): Promise<void> {
    return new Promise((resolve) => { setTimeout(resolve, ms); });
}

function build(options: { grabMs?: number } = {}) {
    const calls = { open: 0, tick: 0, close: 0 };
    const signals: AbortSignal[] = [];
    const activityWindow = new ActivityWindow({
        windowMs: 120_000,
        pollMs: 30_000,
        callbacks: {
            onOpen: () => { calls.open += 1; },
            onTick: async (signal) => {
                calls.tick += 1;
                signals.push(signal);
                if (options.grabMs) await grabbing(options.grabMs);
            },
            onClose: () => { calls.close += 1; },
        },
    });
    return { calls, signals, activityWindow };
}

test('first event opens the window and ticks immediately', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();

    assert.equal(calls.open, 1);
    assert.equal(calls.tick, 1);
    assert.equal(activityWindow.isOpen, true);
    activityWindow.close();
});

test('ticks on the poll interval while open', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    t.mock.timers.tick(30_000);
    await flush();

    assert.equal(calls.tick, 3);
    activityWindow.close();
});

test('paces the next grab from the start of the last one', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build({ grabMs: 10_000 });

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(10_000);
    await flush();
    assert.equal(calls.tick, 1);

    // 10s grabbing plus 20s waiting: the second grab starts 30s after the first
    // did, not 30s after it finished.
    t.mock.timers.tick(19_999);
    await flush();
    assert.equal(calls.tick, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls.tick, 2);

    activityWindow.close();
});

test('waits out a grab that runs longer than the poll interval', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build({ grabMs: 45_000 });

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(30_000);
    await flush();
    assert.equal(calls.tick, 1);

    // It overran the interval, so the next one starts the moment it lands rather
    // than overlapping it.
    t.mock.timers.tick(15_000);
    await flush();
    assert.equal(calls.tick, 2);

    activityWindow.close();
});

test('a second event does not reopen the window but slides expiry', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(119_000);
    await flush();
    activityWindow.onEvent();
    t.mock.timers.tick(119_000);
    await flush();

    assert.equal(calls.open, 1);
    assert.equal(calls.close, 0);
    assert.equal(activityWindow.isOpen, true);
    activityWindow.close();
});

test('closes after the window elapses with no events', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(120_000);
    await flush();

    assert.equal(calls.close, 1);
    assert.equal(activityWindow.isOpen, false);
});

test('stops ticking once closed', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(120_000);
    await flush();
    const ticksAtClose = calls.tick;
    t.mock.timers.tick(300_000);
    await flush();

    assert.equal(calls.tick, ticksAtClose);
});

test('aborts the grab in flight when the window closes', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, signals, activityWindow } = build({ grabMs: 45_000 });

    activityWindow.onEvent();
    await flush();
    assert.equal(signals[0].aborted, false);

    activityWindow.close();
    assert.equal(signals[0].aborted, true);

    // The grab still settles; what matters is that it starts no successor.
    t.mock.timers.tick(45_000);
    await flush();
    assert.equal(calls.tick, 1);
});

test('reopens after a close with a fresh signal', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, signals, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(120_000);
    await flush();
    activityWindow.onEvent();
    await flush();

    assert.equal(calls.open, 2);
    assert.equal(activityWindow.isOpen, true);
    assert.equal(signals[0].aborted, true);
    assert.equal(signals[signals.length - 1].aborted, false);
    activityWindow.close();
});

test('close is idempotent', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    const { calls, activityWindow } = build();

    activityWindow.onEvent();
    await flush();
    activityWindow.close();
    activityWindow.close();

    assert.equal(calls.close, 1);
});

test('a failing tick does not stop the loop', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
    let ticks = 0;
    const activityWindow = new ActivityWindow({
        windowMs: 120_000,
        pollMs: 30_000,
        callbacks: {
            onOpen: () => {},
            onTick: async () => { ticks += 1; throw new Error('go2rtc is down'); },
            onClose: () => {},
        },
    });

    activityWindow.onEvent();
    await flush();
    t.mock.timers.tick(30_000);
    await flush();

    assert.equal(ticks, 2);
    activityWindow.close();
});
