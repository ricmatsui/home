import { createLogger, elapsedMs } from './log.js';

const log = createLogger('frigate');

/**
 * Generous, because nothing waits on it: the window callbacks are fire-and-forget
 * and a slow Frigate delays only the next call in this module's own chain.
 */
const TIMEOUT_MS = 10_000;

const DEFAULT_LABEL = 'cat';

/**
 * Seconds of clip per event, fixed, and long enough to show a cat arriving and
 * settling without running to the end of the window.
 *
 * Frigate ends the event itself at this duration, which is the whole point. An
 * open-ended event has to be ended over the API, and that request loses a race it
 * cannot win: closing the window also switches the camera off, and Frigate's review
 * maintainer skips every update for a disabled camera. The end was dropped, the
 * review alert kept the "cannot end yet" sentinel it is given while an event is
 * open, and the UI showed an alert still in progress days later.
 */
const DURATION_S = 20;

function base(baseUrl: string): string {
    return baseUrl.replace(/\/$/, '');
}

export function createEventUrl(baseUrl: string, camera: string, label: string): string {
    return `${base(baseUrl)}/api/events/${encodeURIComponent(camera)}/${encodeURIComponent(label)}/create`;
}

export interface FrigateEvents {
    /** Arms the module for a new activity window. Makes no request. */
    openWindow(): void;
    /** Opens the window's event, if it has not been opened already. */
    recordCat(): void;
    /** Disarms. The event is already ending on its own. Makes no request. */
    closeWindow(): void;
    /** Resolves once everything queued so far has settled. */
    drain(): Promise<void>;
}

/**
 * One fixed-length Frigate event per activity window that saw a cat, opened by the
 * first sighting.
 *
 * The window is what arms this rather than the presence latch, because the camera
 * is enabled for exactly that span: an event opened outside it would be backed by
 * no footage at all. Within it, the first sighting is enough — a latch that flaps
 * still leaves one review item to look at.
 *
 * Nothing here throws. A Frigate that is down says nothing about the cat, and must
 * not reach the presence sensor or the camera gating.
 */
export function createFrigateEvents(options: {
    baseUrl: string;
    camera: string;
    label?: string;
    fetchImpl?: typeof fetch;
}): FrigateEvents {
    const label = options.label ?? DEFAULT_LABEL;
    const request = options.fetchImpl ?? fetch;

    let armed = false;
    /** Set synchronously, so two cats in one turn cannot both reach the create. */
    let requested = false;

    /**
     * Every request is appended here. `recordCat` is called from a synchronous
     * callback with nowhere to await, and a chain keeps a slow create from being
     * overlapped by the next window's.
     */
    let chain: Promise<void> = Promise.resolve();

    const enqueue = (work: () => Promise<void>): void => {
        // Caught rather than propagated: an unhandled rejection here would take the
        // process down over a camera event nobody is waiting on.
        chain = chain.then(work).catch((error: unknown) => log.error('unexpected failure', { error }));
    };

    const create = async (): Promise<void> => {
        const url = createEventUrl(options.baseUrl, options.camera, label);
        const started = performance.now();
        log.debug('creating event', { url });

        try {
            const response = await request(url, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ duration: DURATION_S, include_recording: true }),
                signal: AbortSignal.timeout(TIMEOUT_MS),
            });
            if (!response.ok) throw new Error(`frigate returned ${response.status}`);

            const body = (await response.json()) as { event_id?: string; message?: string };
            // Frigate answers 200 with success:false for a camera it does not know.
            if (!body?.event_id) throw new Error(`frigate returned no event_id: ${body?.message ?? 'no message'}`);

            log.info('event created', {
                event_id: body.event_id,
                camera: options.camera,
                label,
                duration_s: DURATION_S,
                ms: elapsedMs(started),
            });
        } catch (error) {
            // Left un-requested so the next sighting in this window tries again;
            // the poll interval is the only rate limit it needs.
            requested = false;
            log.error('failed to create event', { url, error });
        }
    };

    return {
        openWindow(): void {
            armed = true;
            requested = false;
            log.debug('armed', { camera: options.camera, label });
        },

        recordCat(): void {
            if (!armed) {
                // A frame that was still in the queue when the window closed. The
                // camera is off by now, so an event here would have no footage.
                log.debug('cat outside the window, ignored');
                return;
            }
            if (requested) return;

            requested = true;
            enqueue(create);
        },

        closeWindow(): void {
            if (!armed) return;
            armed = false;
            requested = false;
            log.debug('disarmed');
        },

        drain(): Promise<void> {
            return chain;
        },
    };
}
