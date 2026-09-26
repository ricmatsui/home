import { useEffect, useState } from 'react';

export const HOURLY_MS = 60 * 60 * 1000;

/*
 * Re-renders the caller every hour and nothing more. The board already reads
 * the clock on each render, so "in 3 hours" is only stale when nothing has
 * re-rendered — which on a wall tablet nobody touches is all day. Forcing the
 * render, rather than handing back a clock held in state, keeps every other
 * render as current as it is today: a tap still redraws against the real time.
 */
export function useHourlyRender(): void {
    const [, setTick] = useState(0);

    useEffect(() => {
        const id = setInterval(() => setTick((tick) => tick + 1), HOURLY_MS);
        return () => clearInterval(id);
    }, []);
}
