import { createLogger, elapsedMs } from './log.js';

const log = createLogger('queue');

export interface SerialQueueOptions<T> {
    worker: (item: T) => Promise<void>;
    /** Depth at which the backlog stops being normal. Without one, nothing is reported. */
    warnDepth?: number;
    onBacklog?: (depth: number) => void;
    onError?: (error: unknown, item: T) => void;
}

/**
 * An unbounded FIFO worked one item at a time. Nothing is ever dropped: a frame that
 * waited out a slow model is still worth looking at, and the alternative — evicting
 * the oldest — threw away exactly the frames a stall had made scarce.
 *
 * Unbounded means the backlog is the only signal that something is wrong, so crossing
 * `warnDepth` is reported. Once per excursion, not once per push: a queue two hundred
 * deep should say so once, not two hundred times.
 */
export class SerialQueue<T> {
    readonly #options: SerialQueueOptions<T>;
    readonly #items: T[] = [];
    readonly #idle: (() => void)[] = [];
    #running = false;
    #warned = false;

    constructor(options: SerialQueueOptions<T>) {
        this.#options = options;
    }

    get size(): number {
        return this.#items.length;
    }

    push(item: T): void {
        this.#items.push(item);
        log.debug('push', { depth: this.#items.length, running: this.#running });

        const { warnDepth, onBacklog } = this.#options;
        if (warnDepth !== undefined && this.#items.length >= warnDepth && !this.#warned) {
            this.#warned = true;
            onBacklog?.(this.#items.length);
        }

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
            // Re-armed only once the backlog has actually gone, so the next excursion
            // is reported and a queue hovering at the threshold is not.
            this.#warned = false;
            for (const resolve of this.#idle.splice(0)) resolve();
        }
    }
}
