import type { User } from '../types';

function isUser(value: unknown): value is User {
    if (typeof value !== 'object' || value === null) {
        return false;
    }
    const { name, id } = value as Record<string, unknown>;
    // Integer rather than merely numeric: Donetick's completedBy is a user id,
    // and a string "3" or a 3.5 is a misconfiguration, not a person.
    return typeof name === 'string' && name.length > 0 && Number.isInteger(id);
}

/*
 * The roster, read from VITE_TICKER_USERS at build time. Never throws: a
 * variable that cannot be parsed leaves the board with no people, which the
 * UI already handles by keeping its old single Done button. A blank screen
 * would be a much worse answer to a typo in the deploy.
 */
export function parseUsers(raw: string): User[] {
    let parsed: unknown;

    try {
        parsed = JSON.parse(raw);
    } catch {
        return [];
    }

    if (!Array.isArray(parsed)) {
        return [];
    }

    return parsed.filter(isUser).map(({ name, id }) => ({ name, id }));
}

export const USERS = parseUsers(import.meta.env.VITE_TICKER_USERS ?? '');
