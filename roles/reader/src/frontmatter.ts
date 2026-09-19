export interface Frontmatter {
    title?: string;
    tags?: string;
    date?: string;
    parent?: string;
}

export interface ParsedNote {
    frontmatter: Frontmatter;
    body: string;
    // Number of source lines the frontmatter block consumed. markdown-it
    // reports token lines relative to the body, so this is added back to
    // produce line numbers that index the original file.
    bodyOffset: number;
}

const PAIR = /^([A-Za-z_][A-Za-z0-9_-]*):[ \t]*(.*)$/;
const KNOWN_KEYS = new Set(['title', 'tags', 'date', 'parent']);

function isDelimiter(line: string): boolean {
    return line.trimEnd() === '---';
}

export function parseFrontmatter(source: string): ParsedNote {
    const lines = source.split('\n');

    if (lines.length === 0 || !isDelimiter(lines[0])) {
        return { frontmatter: {}, body: source, bodyOffset: 0 };
    }

    let end = -1;
    for (let i = 1; i < lines.length; i++) {
        if (isDelimiter(lines[i])) {
            end = i;
            break;
        }
    }

    // An unterminated block is not frontmatter. Treat the whole file as body
    // rather than swallowing it.
    if (end === -1) {
        return { frontmatter: {}, body: source, bodyOffset: 0 };
    }

    const frontmatter: Frontmatter = {};
    for (const line of lines.slice(1, end)) {
        const match = PAIR.exec(line.trimEnd());
        if (match !== null && KNOWN_KEYS.has(match[1])) {
            frontmatter[match[1] as keyof Frontmatter] = match[2].trim();
        }
    }

    return {
        frontmatter,
        body: lines.slice(end + 1).join('\n'),
        bodyOffset: end + 1,
    };
}
