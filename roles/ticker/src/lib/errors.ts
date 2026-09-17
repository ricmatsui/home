// The forward-auth session lapsed. Traefik answered with a 307 toward the
// OIDC provider instead of proxying to Donetick. Recovering needs a
// top-level navigation, so this is not retryable in the background.
export class SessionExpiredError extends Error {
    constructor() {
        super('Your session expired. Reload to sign in again.');
        this.name = 'SessionExpiredError';
    }
}

// fetch rejected outright: no route to the server, DNS failure, VPN down.
export class NetworkError extends Error {
    constructor() {
        super("Can't reach the server.");
        this.name = 'NetworkError';
    }
}

/*
 * The chore's due date is no longer the one the board showed, so this tap came
 * from a page rendered before somebody else cleared the chore. Completing now
 * would tick off the cycle Donetick has already rolled forward to rather than
 * the one on screen. Not retryable by itself: the answer is to refresh and
 * look at the board again.
 */
export class ChoreChangedError extends Error {
    constructor() {
        super('Due date changed — refresh.');
        this.name = 'ChoreChangedError';
    }
}

// Donetick answered with a non-2xx status and (usually) a message.
export class ApiError extends Error {
    status: number;

    constructor(status: number, message: string) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}
