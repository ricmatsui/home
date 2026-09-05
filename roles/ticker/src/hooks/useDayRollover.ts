import { useEffect, useRef } from 'react';

/*
 * Ten minutes. The board's whole time framing — the rolling 24-hour window,
 * "in 3 hours", the tomorrow badge — is anchored to the moment of the last
 * fetch, so a wall tablet nobody touches is reading yesterday's board until
 * something re-anchors it. Ten minutes of staleness at midnight costs nothing;
 * a tighter tick would only spend battery to be wrong for less of the night.
 */
export const TICK_MS = 10 * 60 * 1000;

function dateKey(date: Date): string {
    return date.toDateString();
}

/*
 * Watches the local calendar date rather than scheduling a timer for midnight.
 * A single long timer is wrong the moment the tablet sleeps, the clock steps,
 * or DST makes the day 23 or 25 hours long — and it is wrong silently, leaving
 * the board stale until someone notices. Comparing dates is self-correcting:
 * whatever happened overnight, the first tick that reports a different date
 * fires, and a date that has not changed never does.
 */
export function useDayRollover(onRollover: () => void, now: () => Date = () => new Date()): void {
    // Held in a ref so the interval survives re-renders. The board re-renders
    // on every row tap, and an effect that depended on these would tear the
    // timer down and restart the ten minutes each time — on a busy evening it
    // would never reach a tick.
    const latest = useRef({ onRollover, now });
    useEffect(() => {
        latest.current = { onRollover, now };
    });

    const keyRef = useRef('');

    useEffect(() => {
        keyRef.current = dateKey(latest.current.now());

        const id = setInterval(() => {
            const key = dateKey(latest.current.now());
            if (key === keyRef.current) {
                return;
            }
            keyRef.current = key;
            latest.current.onRollover();
        }, TICK_MS);

        return () => clearInterval(id);
    }, []);
}
