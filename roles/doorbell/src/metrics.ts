import { StatsD } from 'hot-shots';
import { createLogger } from './log.js';

const log = createLogger('metrics');

export const metrics = new StatsD({
    prefix: 'doorbell.',
    protocol: 'uds',
    path: '/opt/datadog-agent/run/dogstatsd.sock',
    errorHandler: (error) => log.warn('statsd send failed', { error }),
});
