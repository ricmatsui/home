import { createLogger, elapsedMs } from './log.js';

const log = createLogger('queue');

export interface SerialQueueOptions<T> {
    max: number;
    worker: (item: T) => Promise<void>;
    onEvict?: (item: T) => void;
    onError?: (error: unknown, item: T) => void;
}

/**
 * A bounded FIFO worked one item at a time. When full, the oldest item is dropped
 * rather than the newest.
 */
export class SerialQueue<T> {
    readonly #options: SerialQueueOptions<T>;
    readonly #items: T[] = [];
    readonly #idle: (() => void)[] = [];
    #running = false;

    constructor(options: SerialQueueOptions<T>) {
        this.#options = options;
    }

    get size(): number {
        return this.#items.length;
    }

    push(item: T): void {
        if (this.#items.length >= this.#options.max) {
            const evicted = this.#items.shift() as T;
            this.#options.onEvict?.(evicted);
        }
        this.#items.push(item);
        log.debug('push', { depth: this.#items.length, max: this.#options.max, running: this.#running });
        void this.#pump();
    }

    async drain(): Promise<void> {
        log.debug('draining', { depth: this.#items.length, running: this.#running });
        if (!this.#running && this.#items.length === 0) return;
        // The pump wakes every waiter once it has emptied the queue, so an idle
        // drain resolves immediately and a busy one costs nothing while it waits.
        await new Promise<void>((resolve) => {
            this.#idle.push(resolve);
        });
    }

    async #pump(): Promise<void> {
        if (this.#running) return;
        this.#running = true;

        try {
            while (this.#items.length > 0) {
                const item = this.#items.shift() as T;
                const started = performance.now();
                try {
                    await this.#options.worker(item);
                    log.debug('worked', { ms: elapsedMs(started), depth: this.#items.length });
                } catch (error) {
                    log.debug('worker failed', { ms: elapsedMs(started), depth: this.#items.length });
                    this.#options.onError?.(error, item);
                }
            }
        } finally {
            this.#running = false;
            for (const resolve of this.#idle.splice(0)) resolve();
        }
    }
}
