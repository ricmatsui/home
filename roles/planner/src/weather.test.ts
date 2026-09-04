import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWeatherSection, fetchDailyForecast } from './weather.js';
import { DailyForecast } from './types.js';

const daily: DailyForecast = {
    time: ['2026-09-04'],
    weather_code: [3],
    temperature_2m_max: [74.3],
    temperature_2m_min: [58.0],
    precipitation_probability_max: [16],
    wind_speed_10m_max: [13.7],
    wind_direction_10m_dominant: [355],
    wind_gusts_10m_max: [20.6],
    uv_index_max: [7.15],
    sunshine_duration: [43200],
    precipitation_sum: [0],
    sunrise: ['2026-09-04T06:46'],
    sunset: ['2026-09-04T19:38'],
};

describe('formatWeatherSection', () => {
    it('renders a forecast as a single note item', () => {
        assert.deepEqual(formatWeatherSection(daily), {
            name: 'Weather',
            items: [{
                status: 'note',
                text: 'Overcast 74°/58°F - rain 16% (0.00 in) - wind N 14 mph (gusts 21) - UV 7 - sun 12.0h (6:46am to 7:38pm)',
                children: [],
            }],
        });
    });
});

describe('formatWeatherSection conditions', () => {
    function conditionFor(code: number): string {
        return formatWeatherSection({ ...daily, weather_code: [code] }).items[0].text.split(' - ')[0];
    }

    it('names every WMO code Open-Meteo reports', () => {
        const expected: Record<number, string> = {
            0: 'Clear', 1: 'Mainly clear', 2: 'Partly cloudy', 3: 'Overcast',
            45: 'Fog', 48: 'Rime fog',
            51: 'Light drizzle', 53: 'Drizzle', 55: 'Heavy drizzle',
            56: 'Light freezing drizzle', 57: 'Freezing drizzle',
            61: 'Light rain', 63: 'Rain', 65: 'Heavy rain',
            66: 'Light freezing rain', 67: 'Freezing rain',
            71: 'Light snow', 73: 'Snow', 75: 'Heavy snow', 77: 'Snow grains',
            80: 'Light showers', 81: 'Showers', 82: 'Heavy showers',
            85: 'Light snow showers', 86: 'Snow showers',
            95: 'Thunderstorm', 96: 'Thunderstorm with hail', 99: 'Thunderstorm with heavy hail',
        };

        for (const [code, name] of Object.entries(expected)) {
            assert.equal(conditionFor(Number(code)), `${name} 74°/58°F`);
        }
    });

    it('falls back to the raw code when unknown', () => {
        assert.equal(conditionFor(42), 'Unknown (code 42) 74°/58°F');
    });
});

describe('formatWeatherSection sun times', () => {
    function sunFor(sunrise: string, sunset: string): string {
        return formatWeatherSection({ ...daily, sunrise: [sunrise], sunset: [sunset] }).items[0].text.split(' - ')[4];
    }

    it('reads the times as the location reports them, without a timezone round-trip', () => {
        assert.equal(sunFor('2026-12-21T07:21', '2026-12-21T16:53'), 'sun 12.0h (7:21am to 4:53pm)');
    });

    it('renders midnight and noon as 12', () => {
        assert.equal(sunFor('2026-09-04T00:00', '2026-09-04T12:00'), 'sun 12.0h (12:00am to 12:00pm)');
    });
});

describe('formatWeatherSection wind', () => {
    function windFor(degrees: number): string {
        return formatWeatherSection({ ...daily, wind_direction_10m_dominant: [degrees] }).items[0].text.split(' - ')[2];
    }

    it('maps dominant direction to a 16-point compass', () => {
        assert.equal(windFor(0), 'wind N 14 mph (gusts 21)');
        assert.equal(windFor(90), 'wind E 14 mph (gusts 21)');
        assert.equal(windFor(180), 'wind S 14 mph (gusts 21)');
        assert.equal(windFor(247), 'wind WSW 14 mph (gusts 21)');
        assert.equal(windFor(359), 'wind N 14 mph (gusts 21)');
    });
});

describe('fetchDailyForecast', () => {
    const payload = { daily };

    beforeEach(() => {
        process.env.WEATHER_LATITUDE = '40.7128';
        process.env.WEATHER_LONGITUDE = '-74.0060';
    });

    afterEach(() => {
        delete process.env.WEATHER_LATITUDE;
        delete process.env.WEATHER_LONGITUDE;
    });

    function stubFetch(handler: (url: string) => Response | Promise<Response>) {
        const original = globalThis.fetch;
        const calls: string[] = [];
        globalThis.fetch = (async (input: string) => {
            calls.push(String(input));
            return handler(String(input));
        }) as typeof fetch;
        return { calls, restore: () => { globalThis.fetch = original; } };
    }

    function jsonResponse(body: unknown, status = 200): Response {
        return new Response(JSON.stringify(body), { status });
    }

    it('requests the location from the environment for a single day in local units', async () => {
        const stub = stubFetch(() => jsonResponse(payload));

        try {
            await fetchDailyForecast('2026-09-04');
        } finally {
            stub.restore();
        }

        const url = new URL(stub.calls[0]);
        assert.equal(`${url.origin}${url.pathname}`, 'https://api.open-meteo.com/v1/forecast');
        assert.equal(url.searchParams.get('latitude'), '40.7128');
        assert.equal(url.searchParams.get('longitude'), '-74.0060');
        // Day boundaries follow the coordinates, so they cannot drift from the location
        assert.equal(url.searchParams.get('timezone'), 'auto');
        assert.equal(url.searchParams.get('start_date'), '2026-09-04');
        assert.equal(url.searchParams.get('end_date'), '2026-09-04');
        assert.equal(url.searchParams.get('temperature_unit'), 'fahrenheit');
        assert.equal(url.searchParams.get('wind_speed_unit'), 'mph');
        assert.equal(url.searchParams.get('precipitation_unit'), 'inch');
        assert.deepEqual(url.searchParams.get('daily')?.split(','), Object.keys(daily).filter(k => k !== 'time'));
    });

    it('returns the daily forecast', async () => {
        const stub = stubFetch(() => jsonResponse(payload));

        try {
            assert.deepEqual(await fetchDailyForecast('2026-09-04'), daily);
        } finally {
            stub.restore();
        }
    });

    it('throws when the location is not configured', async () => {
        delete process.env.WEATHER_LATITUDE;

        await assert.rejects(fetchDailyForecast('2026-09-04'), /WEATHER_LATITUDE/);
    });

    it('throws on a non-ok response', async () => {
        const stub = stubFetch(() => jsonResponse({ error: true, reason: 'bad date' }, 400));

        try {
            await assert.rejects(fetchDailyForecast('2026-09-04'), /400/);
        } finally {
            stub.restore();
        }
    });

    it('throws when the response has no row for the requested date', async () => {
        const stub = stubFetch(() => jsonResponse({ daily: { ...daily, time: [] } }));

        try {
            await assert.rejects(fetchDailyForecast('2026-09-04'), /2026-09-04/);
        } finally {
            stub.restore();
        }
    });
});
