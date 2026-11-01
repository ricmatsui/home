import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCameraNotification } from './notifications.js';

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);

function message(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        event: 'posted',
        package: 'com.google.android.apps.chromecast.app',
        postTime: 1793496522755,
        channelId: 'CameraChannel-user@example.com',
        title: 'Person seen',
        text: 'Front Door',
        hasPicture: true,
        picture: JPEG.toString('base64'),
        ...overrides,
    });
}

test('decodes the picture', () => {
    assert.deepEqual(parseCameraNotification(message())?.picture, JPEG);
});

// The phone escapes slashes, which base64 is full of.
test('decodes a picture with escaped slashes', () => {
    const data = '{"hasPicture":true,"postTime":1793496522755,"picture":"\\/9j\\/4A=="}';

    assert.deepEqual(parseCameraNotification(data)?.picture, Buffer.from('/9j/4A==', 'base64'));
});

test('stamps the frame with the post time', () => {
    assert.equal(parseCameraNotification(message())?.at.getTime(), 1793496522755);
});

test('falls back to now without a post time', () => {
    const before = Date.now();
    const at = parseCameraNotification(message({ postTime: undefined }))?.at.getTime() ?? 0;

    assert.ok(at >= before && at <= Date.now());
});

test('returns the title and text', () => {
    const notification = parseCameraNotification(message());

    assert.equal(notification?.title, 'Person seen');
    assert.equal(notification?.text, 'Front Door');
});

test('ignores a notification without a picture', () => {
    assert.equal(parseCameraNotification(message({ hasPicture: false, picture: undefined })), null);
});

test('ignores a picture flag with nothing behind it', () => {
    assert.equal(parseCameraNotification(message({ picture: '' })), null);
    assert.equal(parseCameraNotification(message({ picture: undefined })), null);
});

test('rejects malformed json without throwing', () => {
    assert.equal(parseCameraNotification('not json'), null);
    assert.equal(parseCameraNotification('null'), null);
});
