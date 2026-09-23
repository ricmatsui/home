import { parseFrontmatter } from './frontmatter.js';
import { createMarkdown } from './markdown.js';
import { BACKGROUND, STYLES } from './styles.js';

function escapeHtml(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function document(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<meta name="theme-color" content="${BACKGROUND}">
<title>${escapeHtml(title)}</title>
<link rel="manifest" href="/manifest.webmanifest">
<link rel="icon" type="image/svg+xml" href="/icon.svg">
<!-- Safari ignores an svg here, so the raster icon earns its place. -->
<link rel="apple-touch-icon" href="/icon-192.png">
<meta name="apple-mobile-web-app-title" content="Reader">
<style>${STYLES}</style>
</head>
<body>
<main>
${body}
</main>
</body>
</html>
`;
}

function present(value: string | undefined): value is string {
    return value !== undefined && value !== '';
}

function line(className: string, parts: string[]): string {
    return parts.length > 0
        ? `<div class="${className}">${parts.join(' &middot; ')}</div>\n`
        : '';
}

export function renderNote(source: string, id: string): string {
    const parsed = parseFrontmatter(source);
    const md = createMarkdown(parsed.bodyOffset);
    const { title, tags, date, parent, previous, next } = parsed.frontmatter;
    const heading = title ?? id;

    // The order a day is walked, matching the order the planner writes the
    // keys in: up to the list it belongs to, then back, then forward. Each
    // arrow leads the link it points at, except next, which follows it.
    const navParts: string[] = [];
    if (present(parent)) {
        navParts.push(`&uarr; ${md.renderInline(parent)}`);
    }
    if (present(previous)) {
        navParts.push(`&larr; ${md.renderInline(previous)}`);
    }
    if (present(next)) {
        navParts.push(`${md.renderInline(next)} &rarr;`);
    }

    const metaParts: string[] = [];
    if (present(date)) {
        metaParts.push(escapeHtml(date));
    }
    if (present(tags)) {
        metaParts.push(escapeHtml(tags));
    }

    return document(
        heading,
        `<h1>${escapeHtml(heading)}</h1>\n` +
            line('nav', navParts) +
            line('meta', metaParts) +
            md.render(parsed.body),
    );
}

export function renderNotFound(id: string): string {
    return document(
        'Not found',
        `<h1>Not found</h1>\n<div class="meta"><a href="/">index</a></div>\n` +
            `<p>No note named <code>${escapeHtml(id)}</code>.</p>`,
    );
}
