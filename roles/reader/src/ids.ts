import path from 'node:path';

// The wiki is flat: every note is a direct child of the root. Rejecting
// slashes outright removes path traversal by construction rather than by
// sanitisation. Rejecting a leading dot keeps .git, .sync and .claude
// unreachable.
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function isValidId(id: string): boolean {
    return ID_PATTERN.test(id);
}

export function resolveNotePath(wikiPath: string, id: string): string | null {
    if (!isValidId(id)) {
        return null;
    }

    const root = path.resolve(wikiPath);
    const file = path.resolve(root, `${id}.md`);

    // Belt and braces: the pattern already forbids separators, but assert
    // the resolved file really is a direct child of the root.
    if (path.dirname(file) !== root) {
        return null;
    }

    return file;
}
