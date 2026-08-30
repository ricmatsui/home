import { useCallback, useEffect, useState } from 'react';

const KEY = 'ticker.public-only';

/*
 * Both ends are guarded. A kiosk profile — which is exactly what a wall tablet
 * runs — can refuse storage outright, and losing the preference across a
 * reload is survivable where taking the board down with it is not.
 */
function read(): boolean {
    try {
        return localStorage.getItem(KEY) === 'true';
    } catch {
        return false;
    }
}

function write(publicOnly: boolean): void {
    try {
        localStorage.setItem(KEY, String(publicOnly));
    } catch {
        // The filter still works for this visit; it just will not be
        // remembered for the next one.
    }
}

export function usePublicOnly() {
    // Read once, on the way in: the value is only ever written by this tab, so
    // there is nothing to keep in sync afterwards.
    const [publicOnly, setPublicOnly] = useState(read);

    useEffect(() => {
        write(publicOnly);
    }, [publicOnly]);

    const togglePublicOnly = useCallback(() => setPublicOnly((current) => !current), []);

    return { publicOnly, togglePublicOnly };
}
