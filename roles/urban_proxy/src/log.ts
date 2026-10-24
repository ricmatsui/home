export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const DEFAULT_LEVEL: LogLevel = 'info';

function parseLevel(value: string | undefined): LogLevel {
    if (value && value in ORDER) return value as LogLevel;
    return DEFAULT_LEVEL;
}

// Read once at import: the level is a deploy-time decision, not a runtime one.
let threshold = ORDER[parseLevel(process.env.LOG_LEVEL)];

/** Exposed for tests, which need to drive the threshold without re-importing. */
export function setLogLevel(level: LogLevel): void {
    threshold = ORDER[level];
}

export function formatValue(value: unknown): string {
    if (value instanceof Error) return JSON.stringify(`${value.name}: ${value.message}`);
    if (value instanceof Date) return value.toISOString();
    if (typeof value === 'string') return /[\s"]/.test(value) ? JSON.stringify(value) : value;
    if (typeof value === 'number' || typeof value === 'boolean' || value === null) return String(value);
    if (value === undefined) return 'undefined';
    return JSON.stringify(value);
}

export function formatLine(level: LogLevel, scope: string, message: string, fields?: Record<string, unknown>): string {
    const parts = [new Date().toISOString(), level.padEnd(5), `[${scope}]`, message];
    for (const [key, value] of Object.entries(fields ?? {})) {
        if (value === undefined) continue;
        parts.push(`${key}=${formatValue(value)}`);
    }
    return parts.join(' ');
}

export interface Logger {
    debug(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
    error(message: string, fields?: Record<string, unknown>): void;
    /** True when debug output is on, for callers that must not pay to build fields otherwise. */
    readonly debugEnabled: boolean;
}

export function createLogger(scope: string): Logger {
    const emit = (level: LogLevel, write: (line: string) => void) =>
        (message: string, fields?: Record<string, unknown>): void => {
            if (ORDER[level] < threshold) return;
            write(formatLine(level, scope, message, fields));
        };

    return {
        debug: emit('debug', (line) => console.debug(line)),
        info: emit('info', (line) => console.log(line)),
        warn: emit('warn', (line) => console.warn(line)),
        error: emit('error', (line) => console.error(line)),
        get debugEnabled(): boolean {
            return ORDER.debug >= threshold;
        },
    };
}

/** Wall-clock milliseconds since `start`, rounded, for duration fields. */
export function elapsedMs(start: number): number {
    return Math.round(performance.now() - start);
}
