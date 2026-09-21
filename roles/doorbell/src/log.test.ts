import assert from 'node:assert/strict';
import test from 'node:test';
import { createLogger, formatLine, formatValue, setLogLevel } from './log.js';

test('formatValue quotes strings only when they need it', () => {
    assert.equal(formatValue('example_camera'), 'example_camera');
    assert.equal(formatValue('two words'), '"two words"');
    assert.equal(formatValue(42), '42');
    assert.equal(formatValue(false), 'false');
    assert.equal(formatValue(undefined), 'undefined');
});

test('formatValue renders errors as name and message', () => {
    assert.equal(formatValue(new Error('boom')), '"Error: boom"');
});

test('formatLine carries the level, scope, message and fields', () => {
    const line = formatLine('debug', 'window', 'tick', { tick: 2, events: 1 });
    assert.match(line, /^\d{4}-\d{2}-\d{2}T[\d:.]+Z debug \[window\] tick tick=2 events=1$/);
});

test('formatLine drops undefined fields', () => {
    assert.match(formatLine('info', 'mqtt', 'publish', { topic: 'a', retain: undefined }), /publish topic=a$/);
});

test('the level threshold suppresses quieter lines', () => {
    const lines: string[] = [];
    const original = console.debug;
    console.debug = (line: string) => void lines.push(line);

    try {
        const log = createLogger('test');

        setLogLevel('info');
        assert.equal(log.debugEnabled, false);
        log.debug('hidden');
        assert.deepEqual(lines, []);

        setLogLevel('debug');
        assert.equal(log.debugEnabled, true);
        log.debug('shown');
        assert.equal(lines.length, 1);
        assert.match(lines[0]!, /\[test\] shown$/);
    } finally {
        console.debug = original;
        setLogLevel('info');
    }
});
