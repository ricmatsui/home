import { loadConfig } from './config.js';
import { connectMqtt } from './mqtt.js';
import { createDatadog } from './datadog.js';
import { parseSubmission } from './submission.js';
import { createSubmitServer } from './server.js';
import { createLogger, elapsedMs } from './log.js';

const log = createLogger('urban-proxy');

const config = loadConfig();

// The API key is never printed.
log.info('starting', {
    log_level: process.env.LOG_LEVEL ?? 'info',
    node: process.version,
    port: config.port,
    mqtt_url: config.mqttUrl,
    datadog_metrics_host: config.datadogMetricsHost,
});

const broker = await connectMqtt({ url: config.mqttUrl });
const datadog = createDatadog({ apiKey: config.datadogApiKey, host: config.datadogMetricsHost });

/** Datadog posts still in flight, so shutdown can let them land. */
const inFlight = new Set<Promise<void>>();

function handle(body: unknown): void {
    let submission;
    try {
        submission = parseSubmission(body);
    } catch (error) {
        log.warn('submission rejected', { error, body });
        return;
    }

    if (submission.dropped.length > 0) log.warn('readings dropped', { keys: submission.dropped, body });

    broker.publishReadings(submission.readings);

    const started = performance.now();
    const post = datadog.submit(submission)
        .then(() => log.info('submitted', {
            at: submission.at,
            readings: Object.keys(submission.readings).length,
            ms: elapsedMs(started),
        }))
        .catch((error) => log.error('datadog submit failed', { at: submission.at, error }))
        .finally(() => inFlight.delete(post));
    inFlight.add(post);
}

const server = createSubmitServer({ onBody: handle });
server.listen(config.port, () => log.info('listening', { port: config.port }));

let shuttingDown = false;

async function shutdown(code: number): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;

    log.info('shutting down', { code, in_flight: inFlight.size });

    try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.all(inFlight);
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
