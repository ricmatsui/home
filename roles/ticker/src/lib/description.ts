/*
 * Donetick stores a chore's description as rich HTML from its Quill editor,
 * so putting one on the board means rendering markup rather than text. This
 * is the only thing standing between that markup and dangerouslySetInnerHTML
 * in ChoreRow — treat it accordingly.
 *
 * An allowlist, never a denylist: anything not named here is unwrapped or
 * dropped. A tag that Quill starts emitting tomorrow degrades to its own text
 * rather than arriving on the page unexamined.
 */

// What Quill actually produces. Notably absent: span, which Quill uses only
// for its own editor chrome (`ql-ui`) and which carries nothing to read.
const ALLOWED_TAGS = new Set([
    'p',
    'br',
    'strong',
    'em',
    'u',
    's',
    'ol',
    'ul',
    'li',
    'a',
    'blockquote',
    'h1',
    'h2',
    'h3',
    'table',
    'thead',
    'tbody',
    'tr',
    'td',
    'th',
]);

// Unwrapping these would turn their source into visible text — the script body
// printed on the row — so they go entirely, children and all.
const DROPPED_TAGS = new Set(['script', 'style']);

/*
 * Quill writes every list as an <ol> and records which kind it is on each item
 * as data-list="bullet" / "ordered". Its own stylesheet then draws the markers,
 * and the board does not load that stylesheet — so an <ol> stripped of the
 * attribute renders a list the author wrote as bullets with 1. 2. 3. down the
 * side. Reading the attribute before it is discarded, and swapping the element
 * to <ul>, is what keeps the list saying what it was written to say.
 */
function correctListType(list: Element): Element {
    const first = list.querySelector(':scope > li');
    if (first?.getAttribute('data-list') !== 'bullet') {
        return list;
    }

    const bulleted = list.ownerDocument.createElement('ul');
    bulleted.append(...Array.from(list.childNodes));
    list.replaceWith(bulleted);
    return bulleted;
}

function safeHref(href: string): string | null {
    const trimmed = href.trim();
    const lower = trimmed.toLowerCase();
    // Prefix allowlist rather than a `javascript:` check: schemes that do not
    // appear here (data:, vbscript:, anything invented later) are rejected
    // without anyone having to think of them first.
    if (lower.startsWith('http://') || lower.startsWith('https://')) {
        return trimmed;
    }
    return null;
}

// Replaces an element with its own children, so its text survives but the
// element itself never reaches the page.
function unwrap(element: Element): void {
    element.replaceWith(...Array.from(element.childNodes));
}

function clean(node: Node): void {
    // Snapshotted first: the loop below removes and replaces children, and a
    // live NodeList would skip nodes as it went.
    for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === Node.TEXT_NODE) {
            continue;
        }

        if (child.nodeType !== Node.ELEMENT_NODE) {
            // Comments and anything else with no business being on the board.
            child.remove();
            continue;
        }

        let element = child as Element;
        let tag = element.tagName.toLowerCase();

        if (DROPPED_TAGS.has(tag)) {
            element.remove();
            continue;
        }

        // Ahead of the recursion below, which is what strips the data-list
        // attribute this has to read.
        if (tag === 'ol') {
            element = correctListType(element);
            tag = element.tagName.toLowerCase();
        }

        // Depth first, so an element is already clean by the time it is either
        // kept or unwrapped into its parent.
        clean(element);

        if (!ALLOWED_TAGS.has(tag)) {
            unwrap(element);
            continue;
        }

        // Every attribute goes, including the class and data-* Quill leaves
        // behind and any on* handler riding along with them. href is the sole
        // exception, and only after it has been vouched for.
        const href = tag === 'a' ? element.getAttribute('href') : null;
        for (const name of element.getAttributeNames()) {
            element.removeAttribute(name);
        }

        if (tag === 'a') {
            const safe = href === null ? null : safeHref(href);
            if (safe === null) {
                // A link that cannot be followed safely is still text worth
                // reading, so it degrades rather than disappearing.
                unwrap(element);
                continue;
            }
            element.setAttribute('href', safe);
            // The board is often an installed app; a link should not navigate
            // the board itself away from the list.
            element.setAttribute('target', '_blank');
            element.setAttribute('rel', 'noopener noreferrer');
        }
    }
}

export function sanitizeDescription(html: string): string {
    if (!html.trim()) {
        return '';
    }

    const { body } = new DOMParser().parseFromString(html, 'text/html');
    clean(body);

    // Quill leaves `<p><br></p>` behind whenever its editor has been opened and
    // emptied again, and Donetick stores that verbatim. Rendering it would give
    // the row a band with nothing in it.
    if (!body.textContent?.trim()) {
        return '';
    }

    return body.innerHTML;
}
