// Long enough to carry a request failure and its status, short enough that the
// day file still reads as a day file
const MAX_LENGTH = 200;

/*
 * A thrown value as a single line of day-file text. serializeItem writes
 * multiline item text out raw, so a message carrying a cause or a stack has to
 * be flattened here or it lands in the wiki as a broken code block.
 */
export function describeError(error: unknown): string {
    const raw = error instanceof Error ? error.message || String(error) : String(error);
    const line = raw.replace(/\s+/g, ' ').trim();

    if (!line) return 'Unknown error';
    if (line.length <= MAX_LENGTH) return line;

    return `${line.slice(0, MAX_LENGTH - 1)}…`;
}
