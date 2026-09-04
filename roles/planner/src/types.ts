export type Status = 'incomplete' | 'started' | 'completed' | 'rejected' | 'note';

export interface TodoItem {
    status: Status;
    text: string;
    children: TodoItem[];
}

export interface Section {
    name: string;
    items: TodoItem[];
}

export interface AddItemAction {
    kind: 'addItem';
    targetDate: string;
    sectionName: string;
    item: TodoItem;
}

export type Action = AddItemAction;

export interface DailyForecast {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_probability_max: number[];
    wind_speed_10m_max: number[];
    wind_direction_10m_dominant: number[];
    wind_gusts_10m_max: number[];
    uv_index_max: number[];
    sunshine_duration: number[];
    precipitation_sum: number[];
    sunrise: string[];
    sunset: string[];
}
