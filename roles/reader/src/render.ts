import { parseFrontmatter } from './frontmatter.js';
import { createMarkdown } from './markdown.js';
import { STYLES } from './styles.js';

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
<title>${escapeHtml(title)}</title>
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

export function renderNote(source: string, id: string): string {
    const parsed = parseFrontmatter(source);
    const md = createMarkdown(parsed.bodyOffset);
    const title = parsed.frontmatter.title ?? id;

    const metaParts: string[] = [];
    if (parsed.frontmatter.parent !== undefined && parsed.frontmatter.parent !== '') {
        metaParts.push(`&uarr; ${md.renderInline(parsed.frontmatter.parent)}`);
    }
    if (parsed.frontmatter.tags !== undefined && parsed.frontmatter.tags !== '') {
        metaParts.push(escapeHtml(parsed.frontmatter.tags));
    }
    if (id !== 'index') {
        metaParts.push('<a href="/">index</a>');
    }

    const meta =
        metaParts.length > 0
            ? `<div class="meta">${metaParts.join(' &middot; ')}</div>`
            : '';

    return document(
        title,
        `<h1>${escapeHtml(title)}</h1>\n${meta}\n${md.render(parsed.body)}`,
    );
}

export function renderNotFound(id: string): string {
    return document(
        'Not found',
        `<h1>Not found</h1>\n<div class="meta"><a href="/">index</a></div>\n` +
            `<p>No note named <code>${escapeHtml(id)}</code>.</p>`,
    );
}
