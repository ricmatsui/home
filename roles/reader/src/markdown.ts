import MarkdownIt from 'markdown-it';
import type { StateCore, StateInline } from 'markdown-it';

const SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const OPEN_BRACKET = 0x5b; // [

export interface NormalizedHref {
    href: string;
    external: boolean;
}

export function normalizeHref(href: string): NormalizedHref {
    if (SCHEME.test(href) || href.startsWith('//')) {
        return { href, external: true };
    }

    if (href.startsWith('#') || href.startsWith('/')) {
        return { href, external: false };
    }

    const hashAt = href.indexOf('#');
    const target = hashAt === -1 ? href : href.slice(0, hashAt);
    const hash = hashAt === -1 ? '' : href.slice(hashAt);
    const withoutExtension = target.endsWith('.md')
        ? target.slice(0, -3)
        : target;

    return { href: `/${withoutExtension}${hash}`, external: false };
}

// vimwiki's [[target]] and [[target|label]]. The href is pushed raw and
// normalised by the link_open renderer below, so both link forms share one
// code path.
function wikilink(state: StateInline, silent: boolean): boolean {
    const start = state.pos;

    if (state.src.charCodeAt(start) !== OPEN_BRACKET) {
        return false;
    }
    if (state.src.charCodeAt(start + 1) !== OPEN_BRACKET) {
        return false;
    }

    const end = state.src.indexOf(']]', start + 2);
    if (end === -1) {
        return false;
    }

    const inner = state.src.slice(start + 2, end);
    if (inner.length === 0 || inner.includes('[') || inner.includes('\n')) {
        return false;
    }

    const pipeAt = inner.indexOf('|');
    const target = (pipeAt === -1 ? inner : inner.slice(0, pipeAt)).trim();
    const label = (pipeAt === -1 ? inner : inner.slice(pipeAt + 1)).trim();

    if (target.length === 0) {
        return false;
    }

    if (!silent) {
        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', target);

        const text = state.push('text', '', 0);
        text.content = label.length > 0 ? label : target;

        state.push('link_close', 'a', -1);
    }

    state.pos = end + 2;
    return true;
}

export type CheckboxState = 'open' | 'done' | 'dropped' | 'progress';

const MARKERS = new Map<string, CheckboxState>([
    [' ', 'open'],
    ['x', 'done'],
    ['X', 'done'],
    ['-', 'dropped'],
    ['.', 'progress'],
]);

const MARKER_PATTERN = /^\[(.)\][ \t]+/;

// The wiki uses '#' for section headings almost exclusively -- 988 '#'
// against 14 '##' and 3 '###' across the corpus -- so body headings arrive
// as h1 and would collide with the note title. Demoting one level leaves a
// single h1 per page and lets the h2..h6 styling apply where intended.
function demoteHeadings(state: StateCore): void {
    for (const token of state.tokens) {
        if (token.type !== 'heading_open' && token.type !== 'heading_close') {
            continue;
        }

        const level = Number(token.tag.slice(1));
        if (Number.isNaN(level)) {
            continue;
        }

        token.tag = `h${Math.min(level + 1, 6)}`;
    }
}

// Runs on the core ruler BEFORE 'inline'. At this point the inline token
// still holds a plain content string with null children, so the marker can
// be stripped by editing content. After inline parsing it could not.
//
// markdown-it emits paragraph_open/inline/paragraph_close for both tight and
// loose lists -- for tight lists the paragraph tokens simply carry
// hidden = true -- so the lookahead below holds for every list in the corpus.
function createCheckboxRule(bodyOffset: number) {
    return function checkboxes(state: StateCore): void {
        const tokens = state.tokens;

        for (let i = 0; i < tokens.length; i++) {
            const itemOpen = tokens[i];
            if (itemOpen.type !== 'list_item_open') {
                continue;
            }

            const paragraphOpen = tokens[i + 1];
            const inline = tokens[i + 2];
            if (paragraphOpen === undefined || inline === undefined) {
                continue;
            }
            if (paragraphOpen.type !== 'paragraph_open') {
                continue;
            }
            if (inline.type !== 'inline') {
                continue;
            }

            const match = MARKER_PATTERN.exec(inline.content);
            if (match === null) {
                continue;
            }

            const checkboxState = MARKERS.get(match[1]);
            if (checkboxState === undefined) {
                continue;
            }

            inline.content = inline.content.slice(match[0].length);

            itemOpen.attrJoin('class', 'cb-item');
            itemOpen.attrJoin('class', `cb-${checkboxState}`);
            itemOpen.attrSet('data-state', checkboxState);
            itemOpen.attrSet(
                'data-line',
                String((itemOpen.map !== null ? itemOpen.map[0] : 0) + bodyOffset),
            );
        }
    };
}

export function createMarkdown(bodyOffset = 0): MarkdownIt {
    const md = new MarkdownIt({
        // The corpus contains no HTML, and disabling it removes the
        // injection question entirely.
        html: false,
        // Notes contain bare urls.
        linkify: true,
        typographer: false,
    });

    md.inline.ruler.before('link', 'wikilink', wikilink);
    md.core.ruler.before(
        'inline',
        'vimwiki_checkbox',
        createCheckboxRule(bodyOffset),
    );
    md.core.ruler.before('inline', 'demote_headings', demoteHeadings);

    const defaultLinkOpen = md.renderer.rules.link_open;

    md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const href = token.attrGet('href');

        if (href !== null) {
            const normalized = normalizeHref(href);
            token.attrSet('href', normalized.href);

            if (normalized.external) {
                token.attrSet('target', '_blank');
                token.attrSet('rel', 'noreferrer');
            }
        }

        return defaultLinkOpen !== undefined
            ? defaultLinkOpen(tokens, idx, options, env, self)
            : self.renderToken(tokens, idx, options);
    };

    const defaultListItemOpen = md.renderer.rules.list_item_open;

    md.renderer.rules.list_item_open = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const open =
            defaultListItemOpen !== undefined
                ? defaultListItemOpen(tokens, idx, options, env, self)
                : self.renderToken(tokens, idx, options);

        const checkboxState = token.attrGet('data-state');
        if (checkboxState === null) {
            return open;
        }

        // The mark is drawn entirely in css, so this is an empty element.
        return `${open}<span class="cb cb-mark-${checkboxState}" aria-hidden="true"></span>`;
    };

    return md;
}
