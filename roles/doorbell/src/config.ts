export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

function requireNumber(name: string, env: NodeJS.ProcessEnv): number {
    const value = Number(requireEnv(name, env));
    if (!Number.isFinite(value)) throw new Error(`${name} is not a number`);
    return value;
}

export interface GoogleCredentials {
    client_email: string;
    private_key: string;
    project_id: string;
}

export interface Config {
    pubsubSubscription: string;
    googleCredentials: GoogleCredentials;
    nestDeviceId: string;
    go2rtcUrl: string;
    go2rtcStream: string;
    lmStudioUrl: string;
    lmStudioModel: string;
    mqttUrl: string;
    frigateUrl: string;
    frigateCamera: string;
    windowMs: number;
    pollMs: number;
    offHeartbeatMs: number;
    missLimit: number;
    queueMax: number;
    framesPath: string;
}

/**
 * The service account arrives base64-encoded, not as raw JSON. Ansible converts a
 * templated string that parses as a dict literal into an actual dict, which
 * `docker stack deploy` then rejects with "must be a string, number or null".
 * Base64 cannot be mistaken for a dict, and it sidesteps quoting the private
 * key's newlines through YAML as well.
 */
function decodeCredentials(name: string, env: NodeJS.ProcessEnv): GoogleCredentials {
    const decoded = Buffer.from(requireEnv(name, env), 'base64').toString('utf-8');

    let credentials: GoogleCredentials;
    try {
        credentials = JSON.parse(decoded) as GoogleCredentials;
    } catch {
        throw new Error(`${name} is not valid base64-encoded JSON`);
    }
    if (typeof credentials !== 'object' || credentials === null) {
        throw new Error(`${name} is not valid base64-encoded JSON`);
    }

    return credentials;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    const googleCredentials = decodeCredentials('GOOGLE_CREDENTIALS_BASE64', env);
    if (!googleCredentials.client_email || !googleCredentials.private_key) {
        throw new Error('GOOGLE_CREDENTIALS_BASE64 is missing client_email or private_key');
    }

    return {
        pubsubSubscription: requireEnv('PUBSUB_SUBSCRIPTION', env),
        googleCredentials,
        nestDeviceId: requireEnv('NEST_DEVICE_ID', env),
        go2rtcUrl: requireEnv('GO2RTC_URL', env),
        go2rtcStream: requireEnv('GO2RTC_STREAM', env),
        lmStudioUrl: requireEnv('LM_STUDIO_URL', env),
        lmStudioModel: requireEnv('LM_STUDIO_MODEL', env),
        mqttUrl: requireEnv('MQTT_URL', env),
        frigateUrl: requireEnv('FRIGATE_URL', env),
        frigateCamera: requireEnv('FRIGATE_CAMERA', env),
        windowMs: requireNumber('WINDOW_MS', env),
        pollMs: requireNumber('POLL_MS', env),
        offHeartbeatMs: requireNumber('OFF_HEARTBEAT_MS', env),
        missLimit: requireNumber('MISS_LIMIT', env),
        queueMax: requireNumber('QUEUE_MAX', env),
        framesPath: requireEnv('FRAMES_PATH', env),
    };
}
