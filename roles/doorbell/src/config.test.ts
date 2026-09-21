import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, requireEnv } from './config.js';

const credentialsJson = JSON.stringify({
    client_email: 'doorbell@example-project.iam.gserviceaccount.com',
    private_key: '-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----\n',
    project_id: 'example-project',
});

const credentials = Buffer.from(credentialsJson, 'utf-8').toString('base64');

const validEnv = {
    GOOGLE_CREDENTIALS_BASE64: credentials,
    PUBSUB_SUBSCRIPTION: 'projects/example-project/subscriptions/nest-events-doorbell',
    NEST_DEVICE_ID: 'DEVICE',
    GO2RTC_URL: 'http://go2rtc:1984',
    GO2RTC_STREAM: 'example_camera',
    LM_STUDIO_URL: 'ws://lm-studio.example.com:1234',
    LM_STUDIO_MODEL: 'gemma-3-12b-it-qat',
    MQTT_URL: 'mqtt://mosquitto:1883',
    FRIGATE_URL: 'http://frigate:5000',
    FRIGATE_CAMERA: 'example_camera',
    WINDOW_MS: '120000',
    POLL_MS: '30000',
    OFF_HEARTBEAT_MS: '30000',
    MISS_LIMIT: '3',
    QUEUE_MAX: '4',
    FRAMES_PATH: '/frames',
};

test('requireEnv returns the value', () => {
    assert.equal(requireEnv('A', { A: 'b' }), 'b');
});

test('requireEnv throws when unset', () => {
    assert.throws(() => requireEnv('A', {}), /A is not set/);
});

test('loadConfig parses numbers and credentials', () => {
    const config = loadConfig(validEnv);

    assert.equal(config.windowMs, 120000);
    assert.equal(config.pollMs, 30000);
    assert.equal(config.offHeartbeatMs, 30000);
    assert.equal(config.missLimit, 3);
    assert.equal(config.queueMax, 4);
    assert.equal(config.googleCredentials.project_id, 'example-project');
    assert.equal(config.frigateUrl, 'http://frigate:5000');
    assert.equal(config.frigateCamera, 'example_camera');
});

test('loadConfig rejects credentials without a private key', () => {
    const partial = Buffer.from(JSON.stringify({ client_email: 'a@b.c' }), 'utf-8').toString('base64');
    const env = { ...validEnv, GOOGLE_CREDENTIALS_BASE64: partial };

    assert.throws(() => loadConfig(env), /client_email or private_key/);
});

// Ansible converts a templated string that parses as a dict literal into a real
// dict, which docker stack then rejects. Base64 cannot be mistaken for one.
test('loadConfig rejects credentials that are not base64-encoded json', () => {
    const env = { ...validEnv, GOOGLE_CREDENTIALS_BASE64: credentialsJson };

    assert.throws(() => loadConfig(env), /GOOGLE_CREDENTIALS_BASE64 is not valid base64-encoded JSON/);
});

test('loadConfig rejects a non-numeric interval', () => {
    const env = { ...validEnv, POLL_MS: 'soon' };

    assert.throws(() => loadConfig(env), /POLL_MS is not a number/);
});
