import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { describeError } from './errors.js';

describe('describeError', () => {
    it('reads the message off an error', () => {
        assert.equal(describeError(new Error('Forecast request failed (503)')), 'Forecast request failed (503)');
    });

    // serializeItem writes multiline item text out raw, which would turn a
    // stack-carrying message into a broken code block in the day file
    it('collapses a multiline message onto one line', () => {
        const error = new Error('fetch failed\n  cause: ECONNREFUSED\n  at Object.fetch');

        assert.equal(describeError(error), 'fetch failed cause: ECONNREFUSED at Object.fetch');
    });

    it('truncates a message too long to read on one line', () => {
        const described = describeError(new Error('x'.repeat(500)));

        assert.equal(described.length, 200);
        assert.equal(described, `${'x'.repeat(199)}…`);
    });

    it('describes something thrown that is not an error', () => {
        assert.equal(describeError({ status: 503 }), '[object Object]');
    });

    it('names the error type when it carries no message', () => {
        assert.equal(describeError(new TypeError('')), 'TypeError');
    });

    it('describes a failure that left nothing behind at all', () => {
        assert.equal(describeError(''), 'Unknown error');
    });
});
