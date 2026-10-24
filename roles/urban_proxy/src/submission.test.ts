import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSubmission, parseTimestamp } from './submission.js';

const body = {
    nickname: 'example',
    timestamp: '2025-09-20T07:32:29Z',
    readings: { temperature: 25.95, humidity: 51.23, pm2_5: 10 },
};

test('parses the readings and the device timestamp', () => {
    const submission = parseSubmission(body);

    assert.deepEqual(submission.at, new Date('2025-09-20T07:32:29Z'));
    assert.deepEqual(submission.readings, { temperature: 25.95, humidity: 51.23, pm2_5: 10 });
});

test('rejects a timestamp in any other format', () => {
    assert.throws(() => parseTimestamp('2025-09-20 07:32:29'), /timestamp/);
    assert.throws(() => parseTimestamp('2025-09-20T07:32:29'), /timestamp/);
    assert.throws(() => parseTimestamp('2025-09-20T07:32:29-07:00'), /timestamp/);
    assert.throws(() => parseTimestamp('2025-09-20T07:32:29.123Z'), /timestamp/);
});

test('rejects a timestamp in the format that is not a date', () => {
    assert.throws(() => parseTimestamp('2025-13-40T07:32:29Z'), /timestamp/);
});

test('rejects a body that is not an object', () => {
    assert.throws(() => parseSubmission([]), /object/);
    assert.throws(() => parseSubmission(null), /object/);
});

test('rejects a body without a timestamp', () => {
    assert.throws(() => parseSubmission({ readings: {} }), /timestamp/);
});

test('rejects a body without readings', () => {
    assert.throws(() => parseSubmission({ timestamp: body.timestamp }), /readings/);
});

test('drops readings that are not finite numbers and names them', () => {
    const submission = parseSubmission({
        ...body,
        readings: { temperature: 25.95, noise: 'loud', pm1: null, pm10: Number.NaN },
    });

    assert.deepEqual(submission.readings, { temperature: 25.95 });
    assert.deepEqual(submission.dropped, ['noise', 'pm1', 'pm10']);
});
