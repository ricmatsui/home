declare global {
    interface Window {
        // Written by nginx at request time out of TICKER_LOCKED_PUBLIC. A
        // string rather than a boolean because it is substituted into a
        // quoted literal; see nginx/default.conf.template.
        TICKER_LOCKED_PUBLIC?: string;
    }
}

/*
 * Whether this deployment is a public board and nothing else. One string means
 * locked and everything else means unlocked, so a misspelling in the deploy
 * leaves the ordinary board rather than half a kiosk.
 */
export function parseLockedPublic(raw: string): boolean {
    return raw === 'true';
}

export const LOCKED_PUBLIC = parseLockedPublic(window.TICKER_LOCKED_PUBLIC ?? '');
