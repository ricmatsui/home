import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { frameUrl, grabFrame } from './frames.js';

const AT = new Date(2026, 8, 11, 14, 5, 9);

async function framesDir(): Promise<string> {
    return fs.promises.mkdtemp(path.join(os.tmpdir(), 'doorbell-'));
}

test('builds the go2rtc frame url', () => {
    assert.equal(frameUrl('http://go2rtc:1984', 'example_camera'), 'http://go2rtc:1984/api/frame.jpeg?src=example_camera');
});

test('tolerates a trailing slash on the base url', () => {
    assert.equal(frameUrl('http://go2rtc:1984/', 'example_camera'), 'http://go2rtc:1984/api/frame.jpeg?src=example_camera');
});

test('writes the raw frame to a dated path', async () => {
    const framesPath = await framesDir();

    const frame = await grabFrame({
        go2rtcUrl: 'http://go2rtc:1984',
        stream: 'example_camera',
        framesPath,
        signal: new AbortController().signal,
        at: AT,
        fetchImpl: async () => Buffer.from([0xff, 0xd8, 0x01]),
    });

    assert.equal(frame.rawPath, path.join(framesPath, '2026-09-11', '140509.raw.jpg'));
    assert.deepEqual(await fs.promises.readFile(frame.rawPath), Buffer.from([0xff, 0xd8, 0x01]));
});

test('hands the window signal to every attempt', async () => {
    const framesPath = await framesDir();
    const controller = new AbortController();
    const signals: AbortSignal[] = [];
    let attempts = 0;

    await grabFrame({
        go2rtcUrl: 'http://go2rtc:1984',
        stream: 'example_camera',
        framesPath,
        signal: controller.signal,
        at: AT,
        delay: async () => {},
        fetchImpl: async (_url, signal) => {
            signals.push(signal);
            attempts += 1;
            if (attempts === 1) throw new Error('connection refused');
            return Buffer.from([0xff, 0xd8]);
        },
    });

    assert.deepEqual(signals, [controller.signal, controller.signal]);
});

test('retries once after a failure', async () => {
    const framesPath = await framesDir();
    const delays: number[] = [];
    let attempts = 0;

    const frame = await grabFrame({
        go2rtcUrl: 'http://go2rtc:1984',
        stream: 'example_camera',
        framesPath,
        signal: new AbortController().signal,
        at: AT,
        delay: async (ms) => { delays.push(ms); },
        fetchImpl: async () => {
            attempts += 1;
            if (attempts === 1) throw new Error('connection refused');
            return Buffer.from([0xff, 0xd8]);
        },
    });

    assert.equal(attempts, 2);
    assert.deepEqual(delays, [3000]);
    assert.equal(frame.raw.length, 2);
});

test('gives up after the retry also fails', async () => {
    const framesPath = await framesDir();
    let attempts = 0;

    await assert.rejects(
        grabFrame({
            go2rtcUrl: 'http://go2rtc:1984',
            stream: 'example_camera',
            framesPath,
            signal: new AbortController().signal,
            at: AT,
            delay: async () => {},
            fetchImpl: async () => { attempts += 1; throw new Error('connection refused'); },
        }),
        /connection refused/,
    );

    assert.equal(attempts, 2);
});

test('does not grab at all once the window has closed', async () => {
    const framesPath = await framesDir();
    const controller = new AbortController();
    controller.abort();
    let attempts = 0;

    await assert.rejects(
        grabFrame({
            go2rtcUrl: 'http://go2rtc:1984',
            stream: 'example_camera',
            framesPath,
            signal: controller.signal,
            at: AT,
            fetchImpl: async () => { attempts += 1; return Buffer.from([0xff, 0xd8]); },
        }),
        { name: 'AbortError' },
    );

    assert.equal(attempts, 0);
});

test('does not retry a grab the window closed under', async () => {
    const framesPath = await framesDir();
    const controller = new AbortController();
    let attempts = 0;

    await assert.rejects(
        grabFrame({
            go2rtcUrl: 'http://go2rtc:1984',
            stream: 'example_camera',
            framesPath,
            signal: controller.signal,
            at: AT,
            delay: async () => {},
            fetchImpl: async () => {
                attempts += 1;
                controller.abort();
                throw new Error('The operation was aborted');
            },
        }),
        /aborted/,
    );

    assert.equal(attempts, 1);
});

test('abandons the retry when the window closes during the delay', async () => {
    const framesPath = await framesDir();
    const controller = new AbortController();
    let attempts = 0;

    await assert.rejects(
        grabFrame({
            go2rtcUrl: 'http://go2rtc:1984',
            stream: 'example_camera',
            framesPath,
            signal: controller.signal,
            at: AT,
            delay: async () => { controller.abort(); },
            fetchImpl: async () => { attempts += 1; throw new Error('connection refused'); },
        }),
        { name: 'AbortError' },
    );

    assert.equal(attempts, 1);
});
