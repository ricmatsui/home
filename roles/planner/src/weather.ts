import { Section, DailyForecast } from './types.js';
import { requireEnv } from './env.js';

export const WEATHER_SECTION = 'Weather';

const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const REQUEST_TIMEOUT_MS = 15_000;

const LOCATION = {
    get latitude() { return requireEnv('WEATHER_LATITUDE'); },
    get longitude() { return requireEnv('WEATHER_LONGITUDE'); },
};

const DAILY_FIELDS = [
    'weather_code',
    'temperature_2m_max',
    'temperature_2m_min',
    'precipitation_probability_max',
    'wind_speed_10m_max',
    'wind_direction_10m_dominant',
    'wind_gusts_10m_max',
    'uv_index_max',
    'sunshine_duration',
    'precipitation_sum',
    'sunrise',
    'sunset',
];

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

export function formatWeatherSection(daily: DailyForecast): Section {
    const text = [
        `${describeCode(daily.weather_code[0])} ${Math.round(daily.temperature_2m_max[0])}°/${Math.round(daily.temperature_2m_min[0])}°F`,
        `rain ${daily.precipitation_probability_max[0]}% (${daily.precipitation_sum[0].toFixed(2)} in)`,
        `wind ${compassPoint(daily.wind_direction_10m_dominant[0])} ${Math.round(daily.wind_speed_10m_max[0])} mph (gusts ${Math.round(daily.wind_gusts_10m_max[0])})`,
        `UV ${Math.round(daily.uv_index_max[0])}`,
        `sun ${(daily.sunshine_duration[0] / 3600).toFixed(1)}h (${clockTime(daily.sunrise[0])} to ${clockTime(daily.sunset[0])})`,
    ].join(' - ');

    return {
        name: WEATHER_SECTION,
        items: [{ status: 'note', text, children: [] }],
    };
}

export async function fetchDailyForecast(dateStr: string): Promise<DailyForecast> {
    const url = new URL(FORECAST_URL);
    url.search = new URLSearchParams({
        latitude: LOCATION.latitude,
        longitude: LOCATION.longitude,
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

    const body = await response.json() as { daily?: DailyForecast };
    if (body.daily?.time[0] !== dateStr) {
        throw new Error(`Forecast has no row for ${dateStr}`);
    }

    return body.daily;
}
