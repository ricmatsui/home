import { createLogger } from './log.js';

const log = createLogger('window');

export interface WindowCallbacks {
    onOpen: () => void;
    onTick: (signal: AbortSignal) => Promise<void>;
    onClose: () => void;
}

/**
 * Resolves early when the window closes; the loop's own check is what ends it.
 *
 * Built on the global timer rather than node:timers/promises: node:test's mock
 * clock does not replace the latter, so a promise-timer sleep here would sleep for
 * real under a test that thinks it is skipping ahead.
 */
function pause(ms: number, signal: AbortSignal): Promise<void> {
    if (ms <= 0 || signal.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
        const done = (): void => {
            clearTimeout(timer);
            signal.removeEventListener('abort', done);
            resolve();
        };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', done, { once: true });
    });
}

/**
 * An activity window held open by incoming events. The first event opens it and
 * ticks immediately; every later event slides expiry out again. When it expires,
 * everything stops.
 */
export class ActivityWindow {
    readonly #windowMs: number;
    readonly #pollMs: number;
    readonly #callbacks: WindowCallbacks;

    #expiryTimer: NodeJS.Timeout | null = null;
    #controller: AbortController | null = null;
    #open = false;
    #events = 0;
    #ticks = 0;

    constructor(options: { windowMs: number; pollMs: number; callbacks: WindowCallbacks }) {
        this.#windowMs = options.windowMs;
        this.#pollMs = options.pollMs;
        this.#callbacks = options.callbacks;
    }

    get isOpen(): boolean {
        return this.#open;
    }

    onEvent(): void {
        if (!this.#open) {
            this.#open = true;
            this.#events = 1;
            this.#ticks = 0;
            this.#controller = new AbortController();
            log.debug('opening', { window_ms: this.#windowMs, poll_ms: this.#pollMs });
            this.#callbacks.onOpen();
            void this.#run(this.#controller.signal);
        } else {
            this.#events += 1;
            // Only visible here: a slid expiry produces no callback of its own.
            log.debug('extended', { events: this.#events, expires_in_ms: this.#windowMs });
        }

        if (this.#expiryTimer) clearTimeout(this.#expiryTimer);
        this.#expiryTimer = setTimeout(() => {
            log.debug('expired', { events: this.#events, ticks: this.#ticks });
            this.close();
        }, this.#windowMs);
    }

    /**
     * Ticks are awaited, not fired, so two can never overlap however slow one
     * turns out to be. Pacing runs from the start of a tick rather than its end,
     * which makes `pollMs` a floor on the gap between starts: a tick that overruns
     * it is followed immediately, and only the window's expiry cuts one short.
     */
    async #run(signal: AbortSignal): Promise<void> {
        while (!signal.aborted) {
            const started = Date.now();
            this.#ticks += 1;
            log.debug('tick', { tick: this.#ticks, events: this.#events });

            try {
                await this.#callbacks.onTick(signal);
            } catch (error) {
                // onTick owns its own failures; this is the backstop that keeps the
                // cadence alive when one escapes anyway.
                log.error('tick failed', { tick: this.#ticks, error });
            }

            if (signal.aborted) break;
            await pause(this.#pollMs - (Date.now() - started), signal);
        }
    }

    close(): void {
        if (!this.#open) return;
        this.#open = false;
        log.debug('closing', { events: this.#events, ticks: this.#ticks });

        if (this.#expiryTimer) {
            clearTimeout(this.#expiryTimer);
            this.#expiryTimer = null;
        }
        // Ends whatever the current tick is waiting on, and the loop with it.
        this.#controller?.abort();
        this.#controller = null;

        this.#callbacks.onClose();
    }
}
