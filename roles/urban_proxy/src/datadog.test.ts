import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatadog, toSeries } from './datadog.js';

const submission = {
    at: new Date('2025-09-20T07:32:29Z'),
    readings: { temperature: 25.95, ec02: 400 },
    dropped: [],
};

test('makes one gauge series per reading, at the device timestamp, on the given host', () => {
    assert.deepEqual(toSeries({ submission, host: 'example-host' }), [
        {
            metric: 'urban.temperature',
            type: 3,
            points: [{ timestamp: 1758353549, value: 25.95 }],
            resources: [{ name: 'example-host', type: 'host' }],
        },
        {
            metric: 'urban.ec02',
            type: 3,
            points: [{ timestamp: 1758353549, value: 400 }],
            resources: [{ name: 'example-host', type: 'host' }],
        },
    ]);
});

test('makes no series for a submission without readings', () => {
    assert.deepEqual(toSeries({ submission: { ...submission, readings: {} }, host: 'example-host' }), []);
});

function fakeFetch(response: Response) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
        calls.push({ url: String(url), init: init ?? {} });
        return response;
    };
    return { calls, fetch };
}

test('posts the series to the v2 API with the API key', async () => {
    const { calls, fetch } = fakeFetch(new Response('{}', { status: 202 }));
    const datadog = createDatadog({ apiKey: 'example-key', host: 'example-host', fetch });

    await datadog.submit(submission);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.datadoghq.com/api/v2/series');
    assert.equal(calls[0].init.method, 'POST');
    assert.equal(new Headers(calls[0].init.headers).get('DD-API-KEY'), 'example-key');
    assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
        series: toSeries({ submission, host: 'example-host' }),
    });
});

test('fails with the status and body when the API rejects the series', async () => {
    const { fetch } = fakeFetch(new Response('{"errors":["Forbidden"]}', { status: 403 }));
    const datadog = createDatadog({ apiKey: 'example-key', host: 'example-host', fetch });

    await assert.rejects(datadog.submit(submission), /403.*Forbidden/);
});

test('posts nothing for a submission without readings', async () => {
    const { calls, fetch } = fakeFetch(new Response('{}', { status: 202 }));
    const datadog = createDatadog({ apiKey: 'example-key', host: 'example-host', fetch });

    await datadog.submit({ ...submission, readings: {} });

    assert.equal(calls.length, 0);
});
