import { createLogger } from './log.js';

const log = createLogger('presence');

/**
 * Latches cat presence across event-driven samples. A single positive frame sets
 * it; it takes `missLimit` consecutive evaluated frames without a cat to clear it.
 *
 * Only evaluated frames belong here. A failed frame grab or a failed inference is
 * an absence of evidence, not evidence of absence, and must not be recorded.
 */
export class CatPresence {
    readonly #missLimit: number;
    readonly #onChange: (present: boolean) => void;

    #misses = 0;
    #present = false;

    constructor(options: { missLimit: number; onChange: (present: boolean) => void }) {
        this.#missLimit = options.missLimit;
        this.#onChange = options.onChange;
    }

    get present(): boolean {
        return this.#present;
    }

    recordDetection(hasCat: boolean): void {
        if (hasCat) {
            this.#misses = 0;
            log.debug('hit', { present: this.#present });
            this.#set(true);
            return;
        }

        this.#misses += 1;
        // The interesting part is the countdown, not just the flip at the end.
        log.debug('miss', { misses: this.#misses, miss_limit: this.#missLimit, present: this.#present });
        if (this.#misses >= this.#missLimit) this.#set(false);
    }

    reset(): void {
        log.debug('reset', { misses: this.#misses, present: this.#present });
        this.#misses = 0;
        this.#set(false);
    }

    #set(present: boolean): void {
        if (this.#present === present) return;
        this.#present = present;
        this.#onChange(present);
    }
}
