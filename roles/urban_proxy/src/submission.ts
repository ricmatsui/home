export interface Submission {
    /** When the device took the readings, not when they arrived. */
    at: Date;
    readings: Record<string, number>;
    /** Reading keys whose values were not finite numbers. */
    dropped: string[];
}

const FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** The device sends UTC to the second, e.g. `2026-10-24T22:44:31Z`, and nothing else. */
export function parseTimestamp(value: string): Date {
    const at = new Date(value);
    if (!FORMAT.test(value) || Number.isNaN(at.getTime())) throw new Error(`timestamp is not YYYY-MM-DDTHH:MM:SSZ: ${value}`);
    return at;
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseSubmission(body: unknown): Submission {
    if (!isObject(body)) throw new Error('submission is not an object');
    if (typeof body.timestamp !== 'string') throw new Error('submission has no timestamp');
    if (!isObject(body.readings)) throw new Error('submission has no readings');

    const readings: Record<string, number> = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(body.readings)) {
        if (typeof value === 'number' && Number.isFinite(value)) readings[key] = value;
        else dropped.push(key);
    }

    return { at: parseTimestamp(body.timestamp), readings, dropped };
}
