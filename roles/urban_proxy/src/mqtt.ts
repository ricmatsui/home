import mqtt, { MqttClient } from 'mqtt';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('mqtt');

/** The proxy's own connection, held by its last will. The device going quiet is expire_after's job. */
export const AVAILABILITY_TOPIC = 'urban/availability';

/** Long enough to ride out a few missed one-minute posts, short enough to flag a dead device. */
const EXPIRE_AFTER_SECONDS = 600;

export function stateTopic(key: string): string {
    return `urban/${key}/state`;
}

const DEVICE = {
    identifiers: ['urban'],
    name: 'Urban',
    manufacturer: 'Pimoroni',
    model: 'Enviro Urban',
};

interface Sensor {
    key: string;
    name: string;
    deviceClass?: string;
    unit: string;
}

// Units are what the Enviro Urban firmware and the SGP30 report. `ec02` is spelled
// as the device sends it, since the Datadog metric names come from the same keys.
const SENSORS: Sensor[] = [
    { key: 'temperature', name: 'Temperature', deviceClass: 'temperature', unit: '°C' },
    { key: 'humidity', name: 'Humidity', deviceClass: 'humidity', unit: '%' },
    { key: 'pressure', name: 'Pressure', deviceClass: 'atmospheric_pressure', unit: 'hPa' },
    { key: 'pm1', name: 'PM1', deviceClass: 'pm1', unit: 'µg/m³' },
    { key: 'pm2_5', name: 'PM2.5', deviceClass: 'pm25', unit: 'µg/m³' },
    { key: 'pm10', name: 'PM10', deviceClass: 'pm10', unit: 'µg/m³' },
    { key: 'ec02', name: 'eCO2', deviceClass: 'carbon_dioxide', unit: 'ppm' },
    { key: 'tvoc', name: 'TVOC', deviceClass: 'volatile_organic_compounds_parts', unit: 'ppb' },
    // Peak-to-peak microphone voltage. A voltage device class would file it with
    // electrical readings, so it gets none.
    { key: 'noise', name: 'Noise', unit: 'V' },
];

export function discoveryPayloads(): Array<{ topic: string; payload: Record<string, unknown> }> {
    return SENSORS.map((sensor) => ({
        topic: `homeassistant/sensor/urban/${sensor.key}/config`,
        payload: {
            name: sensor.name,
            unique_id: `urban_${sensor.key}`,
            device: DEVICE,
            availability_topic: AVAILABILITY_TOPIC,
            state_topic: stateTopic(sensor.key),
            device_class: sensor.deviceClass,
            unit_of_measurement: sensor.unit,
            state_class: 'measurement',
            expire_after: EXPIRE_AFTER_SECONDS,
        },
    }));
}

export interface UrbanMqtt {
    publishReadings(readings: Record<string, number>): void;
    end(): Promise<void>;
}

export async function connectMqtt(options: { url: string }): Promise<UrbanMqtt> {
    const clientId = `urban-proxy-${process.pid}`;

    const started = performance.now();
    log.debug('connecting', { url: options.url, client_id: clientId });

    const client: MqttClient = await mqtt.connectAsync(options.url, {
        clientId,
        will: { topic: AVAILABILITY_TOPIC, payload: Buffer.from('offline'), qos: 1, retain: true },
    });

    log.debug('connected', { url: options.url, ms: elapsedMs(started) });

    const publish = (topic: string, payload: string): void => {
        log.debug('publish', { topic, payload });
        client.publish(topic, payload, { qos: 1, retain: true });
    };

    const announce = (): void => {
        for (const entry of discoveryPayloads()) {
            publish(entry.topic, JSON.stringify(entry.payload));
        }
        publish(AVAILABILITY_TOPIC, 'online');
    };

    // connectAsync resolves after the first connect, so announce once here and
    // again on every reconnect.
    announce();
    client.on('connect', () => {
        log.info('reconnected');
        announce();
    });

    client.on('reconnect', () => log.debug('reconnecting'));
    client.on('offline', () => log.warn('offline'));
    client.on('close', () => log.debug('connection closed'));
    client.on('error', (error) => log.error('client error', { error }));

    return {
        publishReadings(readings: Record<string, number>): void {
            for (const [key, value] of Object.entries(readings)) {
                publish(stateTopic(key), String(value));
            }
        },

        async end(): Promise<void> {
            log.debug('ending');
            await client.publishAsync(AVAILABILITY_TOPIC, 'offline', { qos: 1, retain: true });
            await client.endAsync();
        },
    };
}
