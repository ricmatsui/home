import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseLockedPublic } from './config';

describe('parseLockedPublic', () => {
    it('locks the board on the one string the deploy writes', () => {
        expect(parseLockedPublic('true')).toBe(true);
    });

    /*
     * Never throws and never guesses. A flag that cannot be read leaves the
     * board the way it has always worked — filter off, toggle offered — which
     * is a far better answer to a typo in the deploy than a kitchen board
     * quietly showing the household's private chores.
     */
    it('leaves the board unlocked on anything else', () => {
        expect(parseLockedPublic('')).toBe(false);
        expect(parseLockedPublic('false')).toBe(false);
        expect(parseLockedPublic('TRUE')).toBe(false);
        expect(parseLockedPublic('1')).toBe(false);
    });
});

/*
 * The flag is the only configuration that arrives at runtime rather than being
 * built in, and it travels through three files no other test reads. Each one
 * fails silently in its own way: an unlocked kitchen board, a board with no
 * flag to read, or an nginx that will not start.
 */
describe('how the flag reaches the browser', () => {
    const root = resolve(import.meta.dirname, '../..');
    const text = (path: string) => readFileSync(resolve(root, path), 'utf8');

    /*
     * A classic script, and that is what orders it: it runs while the document
     * is still parsing, where the app's module script is deferred until after.
     * The build hoists that module into the head, so which tag sits above the
     * other decides nothing.
     */
    it('runs before the app that reads it', () => {
        expect(text('index.html')).toContain('<script src="/config.js"></script>');
    });

    it('is written by nginx out of its environment', () => {
        expect(text('nginx/default.conf.template')).toContain(
            "window.TICKER_LOCKED_PUBLIC='${TICKER_LOCKED_PUBLIC}';",
        );
    });

    /*
     * envsubst only substitutes variables that are actually set, and leaves
     * the rest as literal text — which nginx then reads as a variable of its
     * own and refuses to start over. The image default is what lets a service
     * deploy without mentioning the flag at all.
     */
    it('has a default in the image, so an unflagged service still starts', () => {
        expect(text('Dockerfile')).toContain('ENV TICKER_LOCKED_PUBLIC=false');
    });
});
