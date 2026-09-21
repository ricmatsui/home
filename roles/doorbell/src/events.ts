import { PubSub } from '@google-cloud/pubsub';
import { GoogleCredentials } from './config.js';
import { createLogger } from './log.js';

const log = createLogger('events');

/**
 * Pub/Sub holds this many messages in flight. Well above what a doorbell produces,
 * so it never throttles a real burst, and low enough that a backlog replayed after
 * a restart cannot arrive all at once.
 */
const MAX_MESSAGES = 20;

export const DOORBELL_EVENT_TYPES: readonly string[] = [
    'sdm.devices.events.DoorbellChime.Chime',
    'sdm.devices.events.CameraMotion.Motion',
    'sdm.devices.events.CameraPerson.Person',
    'sdm.devices.events.CameraSound.Sound',
];

export interface DoorbellEvent {
    eventId: string;
    timestamp: string;
    types: string[];
}

export function parseDoorbellEvent(data: string, deviceId: string): DoorbellEvent | null {
    let message: Record<string, any>;
    try {
        message = JSON.parse(data);
    } catch {
        return null;
    }
    if (typeof message !== 'object' || message === null) return null;

    const name: unknown = message.resourceUpdate?.name;
    if (typeof name !== 'string' || !name.endsWith(`/${deviceId}`)) return null;

    const events: unknown = message.resourceUpdate?.events;
    if (typeof events !== 'object' || events === null) return null;

    const types = Object.keys(events).filter((type) => DOORBELL_EVENT_TYPES.includes(type));
    if (types.length === 0) return null;

    return {
        eventId: String(message.eventId ?? ''),
        timestamp: String(message.timestamp ?? ''),
        types,
    };
}

export interface EventSubscription {
    close(): Promise<void>;
}

export function subscribeToDoorbellEvents(options: {
    subscription: string;
    credentials: GoogleCredentials;
    deviceId: string;
    onEvent: (event: DoorbellEvent) => void;
    onFatal: (error: Error) => void;
}): EventSubscription {
    const pubsub = new PubSub({
        projectId: options.credentials.project_id,
        credentials: options.credentials,
    });

    const subscription = pubsub.subscription(options.subscription, {
        flowControl: { maxMessages: MAX_MESSAGES },
    });

    log.debug('subscribing', {
        subscription: options.subscription,
        project: options.credentials.project_id,
        client_email: options.credentials.client_email,
        device_id: options.deviceId,
        max_messages: MAX_MESSAGES,
    });

    subscription.on('message', (message) => {
        const data = message.data.toString();
        log.debug('message', {
            id: message.id,
            bytes: data.length,
            published: message.publishTime,
            delivery_attempt: message.deliveryAttempt,
        });

        try {
            const event = parseDoorbellEvent(data, options.deviceId);
            if (event) {
                log.info('event', {
                    id: event.eventId,
                    types: event.types.join(','),
                    timestamp: event.timestamp,
                });
                options.onEvent(event);
            } else {
                // The subscription carries every device in the project, so most
                // messages are meant to be dropped; at debug you can see which,
                // in full — a truncated payload is exactly the one you can't read.
                log.debug('ignored', { id: message.id, payload: data });
            }
        } catch (error) {
            log.error('failed to handle message', { id: message.id, error });
        } finally {
            // Ack unconditionally: these are notifications, and a poison message
            // must not wedge the subscription.
            message.ack();
            log.debug('acked', { id: message.id });
        }
    });

    subscription.on('error', (error: Error) => {
        log.error('subscription error', { error });
        options.onFatal(error);
    });

    subscription.on('close', () => log.debug('subscription closed'));

    return {
        async close(): Promise<void> {
            log.debug('closing subscription');
            await subscription.close();
            await pubsub.close();
        },
    };
}
