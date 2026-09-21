import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHeartbeat, discoveryPayloads, topics } from './mqtt.js';

test('topics derive the frigate command from the camera name', () => {
    assert.equal(topics('example_camera').frigateCommand, 'frigate/example_camera/enabled/set');
    assert.equal(topics('side_gate').frigateCommand, 'frigate/side_gate/enabled/set');
});

test('topics are stable', () => {
    assert.deepEqual(topics('example_camera'), {
        availability: 'doorbell/availability',
        cat: 'doorbell/cat/state',
        activity: 'doorbell/activity/state',
        image: 'doorbell/detection/image',
        lastDetection: 'doorbell/detection/last/state',
        frigateCommand: 'frigate/example_camera/enabled/set',
    });
});

test('publishes four discovery configs on homeassistant topics', () => {
    const payloads = discoveryPayloads('example_camera');

    assert.deepEqual(payloads.map((entry) => entry.topic), [
        'homeassistant/binary_sensor/doorbell/cat/config',
        'homeassistant/binary_sensor/doorbell/activity/config',
        'homeassistant/image/doorbell/detection/config',
        'homeassistant/sensor/doorbell/last_detection/config',
    ]);
});

test('every entity has a unique id, availability, and the shared device', () => {
    const uniqueIds = new Set<string>();

    for (const { payload } of discoveryPayloads('example_camera')) {
        assert.equal(payload.availability_topic, 'doorbell/availability');
        assert.deepEqual((payload.device as { identifiers: string[] }).identifiers, ['doorbell']);
        uniqueIds.add(payload.unique_id as string);
    }

    assert.equal(uniqueIds.size, 4);
});

test('the cat sensor is an occupancy binary sensor on the cat topic', () => {
    const { payload } = discoveryPayloads('example_camera')[0];

    assert.equal(payload.device_class, 'occupancy');
    assert.equal(payload.state_topic, 'doorbell/cat/state');
    assert.equal(payload.payload_on, 'ON');
    assert.equal(payload.payload_off, 'OFF');
});

test('the activity sensor uses the running device class', () => {
    const { payload } = discoveryPayloads('example_camera')[1];

    assert.equal(payload.device_class, 'running');
    assert.equal(payload.state_topic, 'doorbell/activity/state');
});

test('the image entity points at the image topic', () => {
    const { payload } = discoveryPayloads('example_camera')[2];

    assert.equal(payload.image_topic, 'doorbell/detection/image');
    assert.equal(payload.content_type, 'image/jpeg');
});

test('the last detection sensor is a timestamp', () => {
    const { payload } = discoveryPayloads('example_camera')[3];

    assert.equal(payload.device_class, 'timestamp');
    assert.equal(payload.state_topic, 'doorbell/detection/last/state');
});

function makeHeartbeat(intervalMs = 30_000) {
    const calls = { published: 0 };
    const heartbeat = createHeartbeat({ intervalMs, publish: () => { calls.published += 1; } });
    return { calls, heartbeat };
}

test('the heartbeat publishes nothing before the first interval elapses', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.start();
    t.mock.timers.tick(29_999);

    assert.equal(calls.published, 0);
});

test('the heartbeat publishes once per interval while started', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.start();
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);
    t.mock.timers.tick(30_000);

    assert.equal(calls.published, 3);
});

test('stopping the heartbeat halts it', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.start();
    t.mock.timers.tick(30_000);
    heartbeat.stop();
    t.mock.timers.tick(90_000);

    assert.equal(calls.published, 1);
});

// A reconnect calls start() on an already-running heartbeat; a second timer would
// double the publish rate and never be cleared.
test('starting the heartbeat twice does not stack timers', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.start();
    heartbeat.start();
    t.mock.timers.tick(30_000);

    assert.equal(calls.published, 1);
});

test('the heartbeat can be restarted after stopping', (t) => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.start();
    heartbeat.stop();
    heartbeat.start();
    t.mock.timers.tick(30_000);

    assert.equal(calls.published, 1);
});

test('stopping a heartbeat that never started is harmless', () => {
    const { calls, heartbeat } = makeHeartbeat();

    heartbeat.stop();

    assert.equal(calls.published, 0);
});
