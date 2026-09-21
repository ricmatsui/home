import { loadConfig } from './config.js';
import { subscribeToDoorbellEvents } from './events.js';
import { ActivityWindow } from './window.js';
import { CatPresence } from './presence.js';
import { SerialQueue } from './queue.js';
import { createVisionClient, hasCat } from './vision.js';
import { Frame, grabFrame } from './frames.js';
import { annotate, writeResult } from './annotate.js';
import { connectMqtt } from './mqtt.js';
import { createFrigateEvents } from './frigate.js';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('doorbell');

const config = loadConfig();

// Everything the service was told at startup, so a surprising run can be read
// against its actual settings. The credentials are summarised, never printed.
log.info('starting', {
    log_level: process.env.LOG_LEVEL ?? 'info',
    node: process.version,
    tz: process.env.TZ,
    pubsub_subscription: config.pubsubSubscription,
    google_project: config.googleCredentials.project_id,
    google_client_email: config.googleCredentials.client_email,
    nest_device_id: config.nestDeviceId,
    go2rtc_url: config.go2rtcUrl,
    go2rtc_stream: config.go2rtcStream,
    lm_studio_url: config.lmStudioUrl,
    lm_studio_model: config.lmStudioModel,
    mqtt_url: config.mqttUrl,
    frigate_url: config.frigateUrl,
    frigate_camera: config.frigateCamera,
    window_ms: config.windowMs,
    poll_ms: config.pollMs,
    off_heartbeat_ms: config.offHeartbeatMs,
    miss_limit: config.missLimit,
    queue_max: config.queueMax,
    frames_path: config.framesPath,
});

const broker = await connectMqtt({
    url: config.mqttUrl,
    camera: config.frigateCamera,
    offHeartbeatMs: config.offHeartbeatMs,
});
const vision = createVisionClient({ baseUrl: config.lmStudioUrl, model: config.lmStudioModel });
const frigateEvents = createFrigateEvents({ baseUrl: config.frigateUrl, camera: config.frigateCamera });

const presence = new CatPresence({
    missLimit: config.missLimit,
    onChange: (present) => {
        log.info(`cat ${present ? 'present' : 'absent'}`);
        broker.setCatPresent(present);
        if (present) frigateEvents.recordCat();
    },
});

const queue = new SerialQueue<Frame>({
    max: config.queueMax,
    onEvict: (frame) => log.warn('evicted, queue is backed up', { path: frame.rawPath }),
    onError: (error, frame) => log.error('failed to process frame', { path: frame.rawPath, error }),
    worker: async (frame) => {
        const started = performance.now();
        log.debug('processing frame', { path: frame.rawPath, age_ms: Date.now() - frame.at.getTime() });

        let detections;
        try {
            detections = await vision.detect(frame.rawPath);
        } catch (error) {
            // An inference failure says nothing about the cat, so the miss counter
            // is deliberately left alone.
            await writeResult({
                framesPath: config.framesPath,
                at: frame.at,
                verdict: 'nocat',
                annotated: null,
                body: { error: String(error) },
            });
            throw error;
        }

        const { buffer, boxes } = await annotate(frame.raw, detections);
        const cat = hasCat(detections);

        await writeResult({
            framesPath: config.framesPath,
            at: frame.at,
            verdict: cat ? 'cat' : 'nocat',
            annotated: buffer,
            body: { detections, boxes },
        });

        broker.publishDetection(buffer, frame.at);
        presence.recordDetection(cat);

        log.info('frame processed', {
            path: frame.rawPath,
            verdict: cat ? 'cat' : 'nocat',
            detections: detections.length,
            ms: elapsedMs(started),
        });
    },
});

async function tick(signal: AbortSignal): Promise<void> {
    try {
        queue.push(await grabFrame({
            go2rtcUrl: config.go2rtcUrl,
            stream: config.go2rtcStream,
            framesPath: config.framesPath,
            signal,
        }));
    } catch (error) {
        // A grab cut short by the window expiring is how a quiet window ends, not
        // something to page about. Anything else: same reasoning as an inference
        // failure, no frame means no evidence.
        if (signal.aborted) log.debug('frame grab abandoned, window closed');
        else log.error('frame grab failed', { error });
    }
}

const activityWindow = new ActivityWindow({
    windowMs: config.windowMs,
    pollMs: config.pollMs,
    callbacks: {
        onOpen: () => {
            log.info('window open', { window_ms: config.windowMs, poll_ms: config.pollMs });
            broker.setWindowOpen(true);
            frigateEvents.openWindow();
        },
        onTick: (signal) => tick(signal),
        onClose: () => {
            log.info('window closed', { queue_depth: queue.size });
            frigateEvents.closeWindow();
            broker.setWindowOpen(false);
            presence.reset();
            // reset() only emits on a transition; publish unconditionally so the
            // retained topic is OFF whatever the latch thought.
            broker.setCatPresent(false);
        },
    },
});

const subscription = subscribeToDoorbellEvents({
    subscription: config.pubsubSubscription,
    credentials: config.googleCredentials,
    deviceId: config.nestDeviceId,
    onEvent: () => activityWindow.onEvent(),
    onFatal: (error) => {
        log.error('pubsub subscription failed', { error });
        void shutdown(1);
    },
});

log.info('subscribed', { subscription: config.pubsubSubscription });

let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('shutting down', { code, window_open: activityWindow.isOpen, queue_depth: queue.size });
    activityWindow.close();

    try {
        await subscription.close();
        await queue.drain();
        await frigateEvents.drain();
        await broker.end();
    } catch (error) {
        log.error('shutdown failed', { error });
    }

    log.info('stopped', { code });
    process.exit(code);
}

process.on('SIGTERM', () => {
    log.debug('signal', { signal: 'SIGTERM' });
    void shutdown(0);
});
process.on('SIGINT', () => {
    log.debug('signal', { signal: 'SIGINT' });
    void shutdown(0);
});

// Node would exit on both of these anyway; the handlers exist so the reason is in
// the log and the availability topic still goes offline on the way out.
process.on('unhandledRejection', (reason) => {
    log.error('unhandled rejection', { error: reason });
    void shutdown(1);
});
process.on('uncaughtException', (error) => {
    log.error('uncaught exception', { error });
    void shutdown(1);
});
