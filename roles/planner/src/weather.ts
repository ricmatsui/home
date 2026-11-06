import { DailyForecast, HourlyForecast, SunTimes } from './types.js';
import { requireEnv } from './env.js';
import { describeError } from './errors.js';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 15_000;

const LOCATION = {
    get latitude() { return requireEnv('WEATHER_LATITUDE'); },
    get longitude() { return requireEnv('WEATHER_LONGITUDE'); },
};

// Open-Meteo's daily aggregates span midnight to midnight, so the day is
// summarized from hourly values instead, leaving the overnight hours out
const DAYTIME_START_HOUR = 6;

const HOURLY_FIELDS = [
    'weather_code',
    'temperature_2m',
    'precipitation_probability',
    'wind_speed_10m',
    'wind_direction_10m',
    'wind_gusts_10m',
    'uv_index',
    'precipitation',
];

const DAILY_FIELDS = ['sunrise', 'sunset'];

const COMPASS = [
    'N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE',
    'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW',
];

const WEATHER_CODES: Record<number, string> = {
    0: 'Clear',
    1: 'Mainly clear',
    2: 'Partly cloudy',
    3: 'Overcast',
    45: 'Fog',
    48: 'Rime fog',
    51: 'Light drizzle',
    53: 'Drizzle',
    55: 'Heavy drizzle',
    56: 'Light freezing drizzle',
    57: 'Freezing drizzle',
    61: 'Light rain',
    63: 'Rain',
    65: 'Heavy rain',
    66: 'Light freezing rain',
    67: 'Freezing rain',
    71: 'Light snow',
    73: 'Snow',
    75: 'Heavy snow',
    77: 'Snow grains',
    80: 'Light showers',
    81: 'Showers',
    82: 'Heavy showers',
    85: 'Light snow showers',
    86: 'Snow showers',
    95: 'Thunderstorm',
    96: 'Thunderstorm with hail',
    99: 'Thunderstorm with heavy hail',
};

function describeCode(code: number): string {
    return WEATHER_CODES[code] ?? `Unknown (code ${code})`;
}

// Open-Meteo returns these as local wall-clock ISO strings, so the time is read
// straight off the string rather than through a Date that would re-zone it.
function clockTime(isoLocal: string): string {
    const [hours, minutes] = isoLocal.slice(11, 16).split(':');
    const hour = Number(hours);
    return `${hour % 12 === 0 ? 12 : hour % 12}:${minutes}${hour < 12 ? 'am' : 'pm'}`;
}

function compassPoint(degrees: number): string {
    return COMPASS[Math.round(degrees / 22.5) % 16];
}

// Speed-weighted vector mean, so a day swinging between 350° and 10° reads as
// north rather than averaging out to south
function dominantDirection(degrees: number[], speeds: number[]): number {
    const radians = degrees.map(d => d * Math.PI / 180);
    const east = radians.reduce((sum, r, i) => sum + speeds[i] * Math.sin(r), 0);
    const north = radians.reduce((sum, r, i) => sum + speeds[i] * Math.cos(r), 0);
    return (Math.atan2(east, north) * 180 / Math.PI + 360) % 360;
}

export function summarizeDaytime(hourly: HourlyForecast, daily: SunTimes): DailyForecast {
    const daytime = hourly.time.flatMap((t, i) => Number(t.slice(11, 13)) >= DAYTIME_START_HOUR ? [i] : []);
    const pick = (values: number[]) => daytime.map(i => values[i]);

    return {
        time: daily.time,
        // WMO codes rise with severity, matching how Open-Meteo picks the daily code
        weather_code: [Math.max(...pick(hourly.weather_code))],
        temperature_2m_max: [Math.max(...pick(hourly.temperature_2m))],
        temperature_2m_min: [Math.min(...pick(hourly.temperature_2m))],
        precipitation_probability_max: [Math.max(...pick(hourly.precipitation_probability))],
        wind_speed_10m_max: [Math.max(...pick(hourly.wind_speed_10m))],
        wind_direction_10m_dominant: [dominantDirection(pick(hourly.wind_direction_10m), pick(hourly.wind_speed_10m))],
        wind_gusts_10m_max: [Math.max(...pick(hourly.wind_gusts_10m))],
        uv_index_max: [Math.max(...pick(hourly.uv_index))],
        precipitation_sum: [pick(hourly.precipitation).reduce((sum, p) => sum + p, 0)],
        sunrise: daily.sunrise,
        sunset: daily.sunset,
    };
}

export function formatWeatherLine(daily: DailyForecast): string {
    const parts = [
        `${describeCode(daily.weather_code[0])} ${Math.round(daily.temperature_2m_max[0])}°/${Math.round(daily.temperature_2m_min[0])}°F`,
        `${compassPoint(daily.wind_direction_10m_dominant[0])} ${Math.round(daily.wind_speed_10m_max[0])}/${Math.round(daily.wind_gusts_10m_max[0])} mph`,
        `${clockTime(daily.sunrise[0])} - ${clockTime(daily.sunset[0])} UV ${Math.round(daily.uv_index_max[0])}`,
    ];

    // Dry days say nothing worth a segment
    if (daily.precipitation_probability_max[0] > 0 || daily.precipitation_sum[0] > 0) {
        parts.push(`rain ${daily.precipitation_probability_max[0]}% ${daily.precipitation_sum[0].toFixed(2)} in`);
    }

    return parts.join(', ');
}

// Written in the forecast's place rather than left out, so a day with no
// weather line says why, instead of reading as a day the forecast was never
// asked for
export function formatWeatherUnavailable(error: unknown): string {
    return `Weather unavailable: ${describeError(error)}`;
}

export async function fetchDailyForecast(dateStr: string): Promise<DailyForecast> {
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
        latitude: LOCATION.latitude,
        longitude: LOCATION.longitude,
        hourly: HOURLY_FIELDS.join(','),
        daily: DAILY_FIELDS.join(','),
        // Day boundaries follow the coordinates, so they cannot drift from the location
        timezone: 'auto',
        wind_speed_unit: 'mph',
        temperature_unit: 'fahrenheit',
        precipitation_unit: 'inch',
        start_date: dateStr,
        end_date: dateStr,
    }).toString();

    const response = await fetch(url, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    if (!response.ok) {
        throw new Error(`Forecast request failed (${response.status})`);
    }

    const body = await response.json() as { hourly?: HourlyForecast; daily?: SunTimes };
    if (body.daily?.time[0] !== dateStr || !body.hourly?.time.some(t => t.startsWith(dateStr))) {
        throw new Error(`Forecast has no row for ${dateStr}`);
    }

    return summarizeDaytime(body.hourly, body.daily);
}
