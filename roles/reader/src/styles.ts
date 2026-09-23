// Colours are taken from the jellybeans colourscheme plus the user's
// vimwiki override `hi! link VimwikiCheckBoxDone Title`, which deliberately
// makes done items prominent rather than grey. Nothing here is dimmed.
//
// Green means exactly one thing: resolved. Section headings are therefore
// plain with a hairline rule rather than Title-green as they are in vim.

// The tile and splash colour. An installed app paints this before the page
// loads, so the manifest and the theme-color meta have to agree with --bg or
// launching flashes one colour and settles on another.
export const BACKGROUND = '#151515';

export const STYLES = `
:root {
    --bg: ${BACKGROUND};
    --fg: #e8e8d3;
    --green: #70b950;
    --grey: #888888;
    --blue: #80a0ff;
    --code: #8fbfdc;
    --rule: #33383a;
    --gutter: 1.45rem;
    --rail: 0.725rem;
    --lh: 1.55em;
}

* { box-sizing: border-box; }

body {
    margin: 0;
    padding: 1.6rem 1.15rem 4rem;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    -webkit-text-size-adjust: 100%;
    /* Notes contain long unbroken urls. Without this the page itself scrolls
       sideways on a phone instead of the url wrapping. */
    overflow-wrap: anywhere;
}

/* A code fence is the one place a long line should scroll rather than wrap,
   so it opts back out and scrolls inside its own box. */
pre { overflow-wrap: normal; }

main { max-width: 46rem; margin: 0 auto; }

h1 {
    font-size: 1.4rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    margin: 0 0 0.2rem;
}

/* The chain out of a note reads at body size: it is navigation, not a
   caption, and on a phone it has to be a tap target. Grey applies to the
   separators and arrows only -- the links themselves stay --blue.
   em, not rem: the narrow-screen query steps body down to 15px, and a rem
   would ignore that and leave the nav a point larger than the text it sits
   above. */
.nav {
    font-size: 1em;
    color: var(--grey);
    margin: 0.35rem 0 0.15rem;
}

.meta {
    font-size: 0.78rem;
    color: var(--grey);
    font-style: italic;
    margin-bottom: 1.4rem;
}

.meta a { font-style: normal; }

h2, h3, h4, h5, h6 {
    font-size: 1rem;
    font-weight: 700;
    color: var(--fg);
    border-bottom: 1px solid var(--rule);
    padding-bottom: 0.25rem;
    margin: 1.9rem 0 0.7rem;
}

h3 { font-size: 0.95rem; border-bottom: none; padding-bottom: 0; }
h4, h5, h6 { font-size: 0.9rem; border-bottom: none; padding-bottom: 0; }

a { color: var(--blue); text-decoration: none; border-bottom: 1px solid rgba(128, 160, 255, 0.35); }
a:hover { border-bottom-color: var(--blue); }

p { margin: 0.5rem 0; }

code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.88em;
    color: var(--code);
}

pre {
    background: #1b1b1b;
    border: 1px solid var(--rule);
    border-radius: 6px;
    padding: 0.7rem 0.85rem;
    overflow-x: auto;
}

pre code { color: var(--code); }

blockquote {
    margin: 0.6rem 0;
    padding-left: 0.9rem;
    border-left: 2px solid var(--rule);
    color: var(--grey);
}

hr { border: none; border-top: 1px solid var(--rule); margin: 1.6rem 0; }

ul, ol { margin: 0.25rem 0; padding-left: 1.3rem; }

/* ---- checkbox lists ---- */

ul:has(> li.cb-item) { list-style: none; padding-left: 0; }

/* A list that mixes checkbox items with plain ones still needs bullets on
   the plain ones, since the rule above stripped the whole list. The colour
   and weight resets stop a resolved parent's styling leaking down. */
ul:has(> li.cb-item) > li:not(.cb-item) {
    list-style: disc;
    margin-left: 1.1rem;
    color: var(--fg);
    font-weight: 400;
}

li.cb-item {
    position: relative;
    padding-left: var(--gutter);
    padding-top: 2.5px;
    padding-bottom: 2.5px;
}

li.cb-item > p { margin: 0; }

/* Zero, not one gutter: the parent item's own padding-left already shifts
   its nested list right by exactly one gutter. Adding another here would
   double the indent at every level. */
li.cb-item > ul, li.cb-item > ol { padding-left: 0; margin-left: 0; }

/* The guide rail hangs from the item, not from the child list. A
   border-left on the child <ul> could only start where that list starts,
   which for an item whose text wraps to three lines is three lines too low.
   Anchoring to the item drops the rail from directly beneath its own
   checkbox and runs it alongside the wrapped text. */
li.cb-parent::before {
    content: "";
    position: absolute;
    left: calc(var(--rail) - 0.5px);
    top: calc(var(--lh) + 5px);
    bottom: 0.5em;
    width: 1px;
    background: var(--rule);
}

/* Drawn in css, not as a unicode glyph: box characters render hairline-thin
   at any size. A 1.6px border reads at the same weight as the text and
   scales with it. */
.cb {
    position: absolute;
    left: calc(var(--rail) - 0.475em);
    top: calc(2.5px + (var(--lh) - 0.95em) / 2);
    width: 0.95em;
    height: 0.95em;
    border: 1.6px solid currentColor;
    border-radius: 3px;
}

.cb-mark-done::after {
    content: "";
    position: absolute;
    left: 0.26em;
    top: 0.03em;
    width: 0.18em;
    height: 0.42em;
    border-right: 1.9px solid currentColor;
    border-bottom: 1.9px solid currentColor;
    transform: rotate(45deg);
}

.cb-mark-dropped::after {
    content: "";
    position: absolute;
    left: 50%;
    top: 50%;
    transform: translate(-50%, -50%);
    width: 0.52em;
    height: 1.9px;
    border-radius: 1px;
    background: currentColor;
}

/* In progress keeps a mark so it stays distinguishable from an open item;
   only its colour is plain, per the layout decision. */
.cb-mark-progress::after {
    content: "";
    position: absolute;
    inset: 0.16em;
    border-radius: 1px;
    background: currentColor;
}

/* Colour and weight are set on the item itself, not on a child <p>: the
   wiki's lists are tight, so markdown-it emits no paragraph wrapper and the
   text is a direct child of the <li>. Both properties are stated on every
   state so a resolved parent cannot bleed into its open children. */

/* Open and in-progress share a treatment: in vim, [.] receives no special
   highlight either. */
li.cb-open, li.cb-progress { color: var(--fg); font-weight: 400; }

/* Done and dropped are both resolved, and differ only by the mark inside
   the box. Neither is dimmed and neither is struck through. */
li.cb-done, li.cb-dropped { color: var(--green); font-weight: 600; }

@media (max-width: 420px) {
    body { padding: 1.2rem 0.85rem 3rem; font-size: 15px; }
    :root { --gutter: 1.3rem; --rail: 0.65rem; }
}
`;
