import { createLogger } from './log.js';

const log = createLogger('presence');

/**
 * Latches cat presence across event-driven samples. A single positive frame sets
 * it; it takes `missLimit` consecutive evaluated frames without a cat to clear it.
 *
 * Only evaluated frames belong here. A failed frame grab or a failed inference is
 * an absence of evidence, not evidence of absence, and must not be recorded.
 *
 * Frames only arrive while something is sampling, and nothing samples between
 * activity windows, so the miss counter alone would leave the latch set forever
 * after a quiet window. `holdMs` is the backstop: presence outlives its last cat
 * frame by that long and no longer, whether or not a frame ever contradicts it.
 */
export class CatPresence {
    readonly #missLimit: number;
    readonly #holdMs: number;
    readonly #onChange: (present: boolean) => void;

    #misses = 0;
    #present = false;
    #holdTimer: NodeJS.Timeout | null = null;

    constructor(options: { missLimit: number; holdMs: number; onChange: (present: boolean) => void }) {
        this.#missLimit = options.missLimit;
        this.#holdMs = options.holdMs;
        this.#onChange = options.onChange;
    }

    get present(): boolean {
        return this.#present;
    }

    recordDetection(hasCat: boolean): void {
        if (hasCat) {
            this.#misses = 0;
            log.debug('hit', { present: this.#present, hold_ms: this.#holdMs });
            this.#arm();
            this.#set(true);
            return;
        }

        this.#misses += 1;
        // The interesting part is the countdown, not just the flip at the end.
        log.debug('miss', { misses: this.#misses, miss_limit: this.#missLimit, present: this.#present });
        if (this.#misses >= this.#missLimit) this.#set(false);
    }

    #arm(): void {
        if (this.#holdTimer) clearTimeout(this.#holdTimer);
        this.#holdTimer = setTimeout(() => {
            this.#holdTimer = null;
            log.debug('hold expired', { hold_ms: this.#holdMs, misses: this.#misses });
            this.#set(false);
        }, this.#holdMs);
        // A pending hold is a backstop on a latch, not work the service owes
        // anyone: it must never be the reason the process refuses to exit.
        this.#holdTimer.unref();
    }

    #set(present: boolean): void {
        if (this.#present === present) return;
        // The hold only means anything while the latch is set, and every path to
        // absent comes through here.
        if (!present && this.#holdTimer) {
            clearTimeout(this.#holdTimer);
            this.#holdTimer = null;
        }
        this.#present = present;
        this.#onChange(present);
    }
}
