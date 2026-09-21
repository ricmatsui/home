import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadDotEnv } from './env.js';

async function dir(body?: string): Promise<string> {
    const made = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-env-'));
    if (body !== undefined) await fs.promises.writeFile(path.join(made, '.env'), body);
    return made;
}

test('reads a value out of .env', async () => {
    const loaded = loadDotEnv(await dir('DOORBELL_TEST_READ=from-file\n'));

    assert.equal(loaded, true);
    assert.equal(process.env.DOORBELL_TEST_READ, 'from-file');
});

test('leaves a variable the environment already set alone', async () => {
    process.env.DOORBELL_TEST_EXPORTED = 'from-shell';

    loadDotEnv(await dir('DOORBELL_TEST_EXPORTED=from-file\n'));

    assert.equal(process.env.DOORBELL_TEST_EXPORTED, 'from-shell');
});

test('a missing .env is not an error', async () => {
    assert.equal(loadDotEnv(await dir()), false);
});

test('a directory that does not exist is not an error either', () => {
    assert.equal(loadDotEnv(path.join(os.tmpdir(), 'doorbell-env-nowhere')), false);
});
