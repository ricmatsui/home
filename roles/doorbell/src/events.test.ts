import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseDoorbellEvent } from './events.js';

const DEVICE_ID = 'example-device-id';

function message(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
        eventId: 'event-1',
        timestamp: '2026-09-11T18:00:00.000Z',
        resourceUpdate: {
            name: `enterprises/project/devices/${DEVICE_ID}`,
            events: { 'sdm.devices.events.CameraMotion.Motion': { eventSessionId: 's' } },
        },
        ...overrides,
    });
}

test('accepts each doorbell event type', () => {
    for (const type of [
        'sdm.devices.events.DoorbellChime.Chime',
        'sdm.devices.events.CameraMotion.Motion',
        'sdm.devices.events.CameraPerson.Person',
        'sdm.devices.events.CameraSound.Sound',
    ]) {
        const data = message({
            resourceUpdate: { name: `enterprises/project/devices/${DEVICE_ID}`, events: { [type]: {} } },
        });

        assert.deepEqual(parseDoorbellEvent(data, DEVICE_ID)?.types, [type]);
    }
});

test('returns the event id and timestamp', () => {
    const event = parseDoorbellEvent(message(), DEVICE_ID);

    assert.equal(event?.eventId, 'event-1');
    assert.equal(event?.timestamp, '2026-09-11T18:00:00.000Z');
});

test('rejects another device', () => {
    const data = message({
        resourceUpdate: {
            name: 'enterprises/project/devices/SOMEOTHERDEVICE',
            events: { 'sdm.devices.events.CameraMotion.Motion': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects a device id that is only a suffix of the real one', () => {
    const data = message({
        resourceUpdate: {
            name: `enterprises/project/devices/PREFIX${DEVICE_ID}`,
            events: { 'sdm.devices.events.CameraMotion.Motion': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects unrelated event types', () => {
    const data = message({
        resourceUpdate: {
            name: `enterprises/project/devices/${DEVICE_ID}`,
            events: { 'sdm.devices.events.ThermostatTemperature.Change': {} },
        },
    });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects a relation update with no resourceUpdate', () => {
    const data = JSON.stringify({ eventId: 'e', relationUpdate: { subject: 'x', object: 'y' } });

    assert.equal(parseDoorbellEvent(data, DEVICE_ID), null);
});

test('rejects malformed json without throwing', () => {
    assert.equal(parseDoorbellEvent('not json', DEVICE_ID), null);
});
