import { Submission } from './submission.js';

const SERIES_URL = 'https://api.datadoghq.com/api/v2/series';
const GAUGE = 3;
const TIMEOUT_MS = 10_000;

export interface Series {
    metric: string;
    type: number;
    points: Array<{ timestamp: number; value: number }>;
    resources: Array<{ name: string; type: string }>;
}

export function toSeries({ submission, host }: { submission: Submission; host: string }): Series[] {
    const timestamp = Math.floor(submission.at.getTime() / 1000);
    return Object.entries(submission.readings).map(([key, value]) => ({
        metric: `urban.${key}`,
        type: GAUGE,
        points: [{ timestamp, value }],
        resources: [{ name: host, type: 'host' }],
    }));
}

export interface Datadog {
    submit(submission: Submission): Promise<void>;
}

export function createDatadog(options: {
    apiKey: string;
    host: string;
    fetch?: typeof fetch;
}): Datadog {
    const send = options.fetch ?? fetch;

    return {
        async submit(submission: Submission): Promise<void> {
            const series = toSeries({ submission, host: options.host });
            if (series.length === 0) return;

            const response = await send(SERIES_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'DD-API-KEY': options.apiKey },
                body: JSON.stringify({ series }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!response.ok) {
                throw new Error(`datadog rejected series: ${response.status} ${await response.text()}`);
            }
        },
    };
}
