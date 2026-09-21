import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CatPresence } from './presence.js';

function build(missLimit = 3) {
    const changes: boolean[] = [];
    const presence = new CatPresence({ missLimit, onChange: (present) => changes.push(present) });
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

test('reset clears presence and the miss counter', () => {
    const { changes, presence } = build();

    presence.recordDetection(true);
    presence.reset();
    presence.recordDetection(false);
    presence.recordDetection(false);

    assert.equal(presence.present, false);
    assert.deepEqual(changes, [true, false]);
});
