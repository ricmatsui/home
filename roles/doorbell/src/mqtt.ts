import mqtt, { MqttClient } from 'mqtt';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('mqtt');

export interface Topics {
    availability: string;
    cat: string;
    activity: string;
    image: string;
    lastDetection: string;
    frigateCommand: string;
}

export function topics(camera: string): Topics {
    return {
        availability: 'doorbell/availability',
        cat: 'doorbell/cat/state',
        activity: 'doorbell/activity/state',
        image: 'doorbell/detection/image',
        lastDetection: 'doorbell/detection/last/state',
        frigateCommand: `frigate/${camera}/enabled/set`,
    };
}

const DEVICE = {
    identifiers: ['doorbell'],
    name: 'Doorbell',
    manufacturer: 'home',
    model: 'doorbell vision',
};

export function discoveryPayloads(camera: string): Array<{ topic: string; payload: Record<string, unknown> }> {
    const topic = topics(camera);
    const base = { availability_topic: topic.availability, device: DEVICE };

    return [
        {
            topic: 'homeassistant/binary_sensor/doorbell/cat/config',
            payload: {
                ...base,
                name: 'Cat',
                unique_id: 'doorbell_cat',
                device_class: 'occupancy',
                state_topic: topic.cat,
                payload_on: 'ON',
                payload_off: 'OFF',
            },
        },
        {
            topic: 'homeassistant/binary_sensor/doorbell/activity/config',
            payload: {
                ...base,
                name: 'Activity',
                unique_id: 'doorbell_activity',
                device_class: 'running',
                state_topic: topic.activity,
                payload_on: 'ON',
                payload_off: 'OFF',
            },
        },
        {
            topic: 'homeassistant/image/doorbell/detection/config',
            payload: {
                ...base,
                name: 'Detection',
                unique_id: 'doorbell_detection',
                image_topic: topic.image,
                content_type: 'image/jpeg',
            },
        },
        {
            topic: 'homeassistant/sensor/doorbell/last_detection/config',
            payload: {
                ...base,
                name: 'Last detection',
                unique_id: 'doorbell_last_detection',
                device_class: 'timestamp',
                state_topic: topic.lastDetection,
            },
        },
    ];
}

export interface Heartbeat {
    start(): void;
    stop(): void;
}

/** Calls `publish` every `intervalMs` between a start() and the stop() that follows. */
export function createHeartbeat(options: { intervalMs: number; publish: () => void }): Heartbeat {
    let timer: NodeJS.Timeout | null = null;

    return {
        start(): void {
            // A reconnect starts an already-running heartbeat; a second timer would
            // double the rate and leak past the next stop().
            if (timer) return;
            timer = setInterval(options.publish, options.intervalMs);
        },

        stop(): void {
            if (!timer) return;
            clearInterval(timer);
            timer = null;
        },
    };
}

export interface DoorbellMqtt {
    /** Publishes both the activity state and the Frigate enable command. */
    setWindowOpen(open: boolean): void;
    setCatPresent(present: boolean): void;
    publishDetection(image: Buffer, at: Date): void;
    end(): Promise<void>;
}

export async function connectMqtt(options: {
    url: string;
    camera: string;
    offHeartbeatMs: number;
}): Promise<DoorbellMqtt> {
    const topic = topics(options.camera);
    const state = { windowOpen: false, catPresent: false };
    const clientId = `doorbell-${process.pid}`;

    const started = performance.now();
    log.debug('connecting', {
        url: options.url,
        client_id: clientId,
        camera: options.camera,
        off_heartbeat_ms: options.offHeartbeatMs,
    });

    const client: MqttClient = await mqtt.connectAsync(options.url, {
        clientId,
        will: { topic: topic.availability, payload: Buffer.from('offline'), qos: 1, retain: true },
    });

    log.debug('connected', { url: options.url, ms: elapsedMs(started) });

    const publish = (target: string, payload: string | Buffer, retain = true): void => {
        log.debug('publish', {
            topic: target,
            // Images are the only binary payload, and their bytes say nothing.
            payload: Buffer.isBuffer(payload) ? `<${payload.length} bytes>` : payload,
            retain,
        });
        client.publish(target, payload, { qos: 1, retain });
    };

    const onOff = (value: boolean): string => (value ? 'ON' : 'OFF');

    // Frigate restores `enabled: true` from its own config when it restarts, and our
    // commands are never retained, so the OFF sent at the window's close is silently
    // undone with nothing to notice it. Only OFF needs re-asserting: a restart
    // mid-window already comes back on the state we want.
    const heartbeat = createHeartbeat({
        intervalMs: options.offHeartbeatMs,
        // Logged on its own so a re-assert is not mistaken for a window closing.
        publish: () => {
            log.debug('off heartbeat');
            publish(topic.frigateCommand, 'OFF', false);
        },
    });

    // The heartbeat runs exactly when the camera is meant to be off, which is also
    // the state a fresh process starts in.
    const syncHeartbeat = (): void => {
        if (state.windowOpen) heartbeat.stop();
        else heartbeat.start();
    };

    const reconcile = (): void => {
        log.debug('reconciling', { window_open: state.windowOpen, cat_present: state.catPresent });
        for (const entry of discoveryPayloads(options.camera)) {
            publish(entry.topic, JSON.stringify(entry.payload));
        }
        publish(topic.availability, 'online');
        publish(topic.activity, onOff(state.windowOpen));
        publish(topic.cat, onOff(state.catPresent));
        // Commands are never retained: a retained command replays itself at every
        // broker or Frigate restart.
        publish(topic.frigateCommand, onOff(state.windowOpen), false);
        syncHeartbeat();
    };

    // connectAsync resolves after the first connect, so reconcile once here and
    // again on every reconnect.
    reconcile();
    client.on('connect', () => {
        log.info('reconnected', { window_open: state.windowOpen, cat_present: state.catPresent });
        reconcile();
    });

    client.on('reconnect', () => log.debug('reconnecting'));
    client.on('offline', () => log.warn('offline'));
    client.on('close', () => log.debug('connection closed'));
    client.on('error', (error) => log.error('client error', { error }));

    return {
        setWindowOpen(open: boolean): void {
            state.windowOpen = open;
            publish(topic.activity, onOff(open));
            publish(topic.frigateCommand, onOff(open), false);
            syncHeartbeat();
        },

        setCatPresent(present: boolean): void {
            state.catPresent = present;
            publish(topic.cat, onOff(present));
        },

        publishDetection(image: Buffer, at: Date): void {
            publish(topic.image, image);
            publish(topic.lastDetection, at.toISOString());
        },

        async end(): Promise<void> {
            log.debug('ending');
            heartbeat.stop();
            await client.publishAsync(topic.availability, 'offline', { qos: 1, retain: true });
            await client.endAsync();
        },
    };
}
