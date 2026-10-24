export function requireEnv(name: string, env: NodeJS.ProcessEnv = process.env): string {
    const value = env[name];
    if (!value) throw new Error(`${name} is not set`);
    return value;
}

function requireNumber(name: string, env: NodeJS.ProcessEnv): number {
    const value = Number(requireEnv(name, env));
    if (!Number.isFinite(value)) throw new Error(`${name} is not a number`);
    return value;
}

export interface Config {
    port: number;
    mqttUrl: string;
    datadogApiKey: string;
    /** The host the `urban.*` series are tagged with. */
    datadogMetricsHost: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
    return {
        port: requireNumber('PORT', env),
        mqttUrl: requireEnv('MQTT_URL', env),
        datadogApiKey: requireEnv('DATADOG_API_KEY', env),
        datadogMetricsHost: requireEnv('DATADOG_METRICS_HOST', env),
    };
}
