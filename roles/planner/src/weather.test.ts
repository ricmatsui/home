import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { formatWeatherLine, formatWeatherUnavailable, fetchDailyForecast, summarizeDaytime } from './weather.js';
import { DailyForecast, HourlyForecast, SunTimes } from './types.js';

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
    precipitation_sum: [0],
    sunrise: ['2026-09-04T06:46'],
    sunset: ['2026-09-04T19:38'],
};

const sunTimes: SunTimes = {
    time: ['2026-09-04'],
    sunrise: ['2026-09-04T06:46'],
    sunset: ['2026-09-04T19:38'],
};

// Every hour is calm and dry except where a test overrides it
function hourlyWith(overrides: Partial<Record<keyof Omit<HourlyForecast, 'time'>, Record<number, number>>> = {}): HourlyForecast {
    const base = {
        weather_code: 1,
        temperature_2m: 65,
        precipitation_probability: 0,
        wind_speed_10m: 5,
        wind_direction_10m: 180,
        wind_gusts_10m: 8,
        uv_index: 0,
        precipitation: 0,
    };
    const hours = Array.from({ length: 24 }, (_, h) => h);
    const series = Object.fromEntries(Object.entries(base).map(([field, value]) => [
        field,
        hours.map(h => overrides[field as keyof typeof base]?.[h] ?? value),
    ]));

    return { time: hours.map(h => `2026-09-04T${String(h).padStart(2, '0')}:00`), ...series } as HourlyForecast;
}

describe('summarizeDaytime', () => {
    it('ignores the hours before 6am', () => {
        const summary = summarizeDaytime(hourlyWith({
            weather_code: { 2: 95 },
            temperature_2m: { 4: 40, 5: 90 },
            precipitation_probability: { 3: 80 },
            wind_speed_10m: { 1: 30 },
            wind_gusts_10m: { 1: 45 },
            precipitation: { 3: 0.5 },
        }), sunTimes);

        assert.equal(summary.weather_code[0], 1);
        assert.equal(summary.temperature_2m_max[0], 65);
        assert.equal(summary.temperature_2m_min[0], 65);
        assert.equal(summary.precipitation_probability_max[0], 0);
        assert.equal(summary.wind_speed_10m_max[0], 5);
        assert.equal(summary.wind_gusts_10m_max[0], 8);
        assert.equal(summary.precipitation_sum[0], 0);
    });

    it('summarizes the hours from 6am through 11pm', () => {
        const summary = summarizeDaytime(hourlyWith({
            weather_code: { 6: 3, 15: 63 },
            temperature_2m: { 6: 52, 23: 80 },
            precipitation_probability: { 15: 70 },
            wind_speed_10m: { 12: 14 },
            wind_gusts_10m: { 12: 22 },
            uv_index: { 13: 7.2 },
            precipitation: { 15: 0.25, 16: 0.5 },
        }), sunTimes);

        assert.equal(summary.weather_code[0], 63);
        assert.equal(summary.temperature_2m_max[0], 80);
        assert.equal(summary.temperature_2m_min[0], 52);
        assert.equal(summary.precipitation_probability_max[0], 70);
        assert.equal(summary.wind_speed_10m_max[0], 14);
        assert.equal(summary.wind_gusts_10m_max[0], 22);
        assert.equal(summary.uv_index_max[0], 7.2);
        assert.equal(summary.precipitation_sum[0], 0.75);
    });

    it('keeps the sun times as reported', () => {
        const summary = summarizeDaytime(hourlyWith(), sunTimes);

        assert.deepEqual(
            { time: summary.time, sunrise: summary.sunrise, sunset: summary.sunset },
            sunTimes,
        );
    });

    it('takes the dominant wind direction across north without averaging to south', () => {
        const direction = { ...Object.fromEntries(Array.from({ length: 18 }, (_, i) => [i + 6, i % 2 === 0 ? 350 : 10])) };
        const summary = summarizeDaytime(hourlyWith({ wind_direction_10m: direction }), sunTimes);

        assert.ok(Math.min(summary.wind_direction_10m_dominant[0], 360 - summary.wind_direction_10m_dominant[0]) < 1);
    });

    it('weights the dominant wind direction by speed', () => {
        const summary = summarizeDaytime(hourlyWith({
            wind_direction_10m: { 10: 270 },
            wind_speed_10m: { 10: 200 },
        }), sunTimes);

        assert.ok(summary.wind_direction_10m_dominant[0] > 225 && summary.wind_direction_10m_dominant[0] < 270);
    });
});

describe('formatWeatherLine', () => {
    it('renders a forecast as a single line', () => {
        assert.equal(
            formatWeatherLine(daily),
            'Overcast 74°/58°F, N 14/21 mph, 6:46am - 7:38pm UV 7, rain 16% 0.00 in',
        );
    });

    it('drops the rain segment when none is expected', () => {
        const dry = { ...daily, precipitation_probability_max: [0], precipitation_sum: [0] };

        assert.equal(formatWeatherLine(dry), 'Overcast 74°/58°F, N 14/21 mph, 6:46am - 7:38pm UV 7');
    });

    it('keeps the rain segment when only the amount is zero', () => {
        const chance = { ...daily, precipitation_probability_max: [20], precipitation_sum: [0] };

        assert.match(formatWeatherLine(chance), /, rain 20% 0\.00 in$/);
    });
});

describe('formatWeatherUnavailable', () => {
    it('records the failure where the forecast would have gone', () => {
        assert.equal(
            formatWeatherUnavailable(new Error('Forecast request failed (503)')),
            'Weather unavailable: Forecast request failed (503)',
        );
    });

    it('keeps a failure that spans lines on one line', () => {
        assert.equal(
            formatWeatherUnavailable(new Error('fetch failed\n  cause: ECONNREFUSED')),
            'Weather unavailable: fetch failed cause: ECONNREFUSED',
        );
    });
});

describe('formatWeatherLine conditions', () => {
    function conditionFor(code: number): string {
        return formatWeatherLine({ ...daily, weather_code: [code] }).split(', ')[0];
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

describe('formatWeatherLine sun times', () => {
    function sunFor(sunrise: string, sunset: string): string {
        return formatWeatherLine({ ...daily, sunrise: [sunrise], sunset: [sunset] }).split(', ')[2];
    }

    it('reads the times as the location reports them, without a timezone round-trip', () => {
        assert.equal(sunFor('2026-12-21T07:21', '2026-12-21T16:53'), '7:21am - 4:53pm UV 7');
    });

    it('renders midnight and noon as 12', () => {
        assert.equal(sunFor('2026-09-04T00:00', '2026-09-04T12:00'), '12:00am - 12:00pm UV 7');
    });
});

describe('formatWeatherLine wind', () => {
    function windFor(degrees: number): string {
        return formatWeatherLine({ ...daily, wind_direction_10m_dominant: [degrees] }).split(', ')[1];
    }

    it('maps dominant direction to a 16-point compass', () => {
        assert.equal(windFor(0), 'N 14/21 mph');
        assert.equal(windFor(90), 'E 14/21 mph');
        assert.equal(windFor(180), 'S 14/21 mph');
        assert.equal(windFor(247), 'WSW 14/21 mph');
        assert.equal(windFor(359), 'N 14/21 mph');
    });
});

describe('fetchDailyForecast', () => {
    const hourly = hourlyWith({ temperature_2m: { 3: 40 } });
    const payload = { hourly, daily: sunTimes };

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
        assert.deepEqual(url.searchParams.get('hourly')?.split(','), Object.keys(hourly).filter(k => k !== 'time'));
        assert.deepEqual(url.searchParams.get('daily')?.split(','), ['sunrise', 'sunset']);
    });

    it('returns the forecast summarized over the daytime hours', async () => {
        const stub = stubFetch(() => jsonResponse(payload));

        try {
            assert.deepEqual(await fetchDailyForecast('2026-09-04'), summarizeDaytime(hourly, sunTimes));
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
        const stub = stubFetch(() => jsonResponse({ ...payload, daily: { ...sunTimes, time: [] } }));

        try {
            await assert.rejects(fetchDailyForecast('2026-09-04'), /2026-09-04/);
        } finally {
            stub.restore();
        }
    });

    it('throws when the response has no hours for the requested date', async () => {
        const stub = stubFetch(() => jsonResponse({ ...payload, hourly: { ...hourly, time: [] } }));

        try {
            await assert.rejects(fetchDailyForecast('2026-09-04'), /2026-09-04/);
        } finally {
            stub.restore();
        }
    });
});
