import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidId, resolveNotePath } from './ids.js';

test('accepts the ids that actually appear in the wiki', () => {
    assert.equal(isValidId('index'), true);
    assert.equal(isValidId('260726-0000a'), true);
    assert.equal(isValidId('220306-0621'), true);
});

test('rejects ids containing a slash', () => {
    assert.equal(isValidId('a/b'), false);
    assert.equal(isValidId('../etc/passwd'), false);
    assert.equal(isValidId('.sync/Archive/x'), false);
});

test('rejects ids starting with a dot, which keeps .git and .sync unreachable', () => {
    assert.equal(isValidId('.git'), false);
    assert.equal(isValidId('.sync'), false);
    assert.equal(isValidId('.claude'), false);
    assert.equal(isValidId('..'), false);
});

test('rejects the empty id', () => {
    assert.equal(isValidId(''), false);
});

test('rejects ids with characters outside the allowed set', () => {
    assert.equal(isValidId('a b'), false);
    assert.equal(isValidId('a\0b'), false);
    assert.equal(isValidId('a%2fb'), false);
});

test('resolves a valid id to a direct child of the wiki root', () => {
    assert.equal(
        resolveNotePath('/wiki', '260726-0000a'),
        '/wiki/260726-0000a.md',
    );
});

test('resolves relative wiki roots to absolute paths', () => {
    const resolved = resolveNotePath('/wiki/../wiki', 'index');
    assert.equal(resolved, '/wiki/index.md');
});

test('returns null for an unsafe id rather than throwing', () => {
    assert.equal(resolveNotePath('/wiki', '../secret'), null);
    assert.equal(resolveNotePath('/wiki', '.git'), null);
});
