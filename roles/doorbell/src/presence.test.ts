import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatPresence } from './presence.js';

const HOLD_MS = 600_000;

function build(options: { missLimit?: number; holdMs?: number } = {}) {
    const changes: boolean[] = [];
    const presence = new CatPresence({
        missLimit: options.missLimit ?? 3,
        holdMs: options.holdMs ?? HOLD_MS,
        onChange: (present) => changes.push(present),
    });
    return { changes, presence };
}

test('a cat sets presence and emits one change', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(true);

    assert.equal(presence.present, true);
    assert.deepEqual(changes, [true]);
});

test('presence survives fewer misses than the limit', () => {
    const { presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, true);
});

test('the miss limit clears presence', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});

test('a cat resets the miss counter', () => {
    const { presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, true);
});

test('misses while already absent emit nothing', () => {
    const { changes, presence } = build();

    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.deepEqual(changes, []);
});

test('the hold expiring clears presence with no frames at all', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { changes, presence } = build();

    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});

test('presence survives right up to the hold', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { presence } = build();

    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS - 1);

    assert.equal(presence.present, true);
});

test('a later cat slides the hold out', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { presence } = build();

    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS - 1);
    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS - 1);

    assert.equal(presence.present, true);
});

test('a miss does not slide the hold out', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { presence } = build();

    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS - 1);
    presence.recordDetection(false);
    t.mock.timers.tick(1);

    assert.equal(presence.present, false);
});

test('the miss limit clears first and leaves the hold nothing to emit', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.recordDetection(false);
    presence.recordDetection(false);
    presence.recordDetection(false);
    t.mock.timers.tick(HOLD_MS);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});

test('a cat after the hold expired latches again', (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const { changes, presence } = build();

    presence.recordDetection(true);
    t.mock.timers.tick(HOLD_MS);
    presence.recordDetection(true);

    assert.equal(presence.present, true);
    assert.deepEqual(changes, [true, false, true]);
});
