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
    --fs: 18px;
    --gutter: 1.7rem;
    --rail: 0.7rem;
    --lh: 1.55em;
    --item-gap: 1.4rem;
}

* { box-sizing: border-box; }

html { font-size: var(--fs); }

body {
    margin: 0;
    padding: 1.6rem 1.15rem 4rem;
    background: var(--bg);
    color: var(--fg);
    font: 1rem/1.55 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
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
   separators and arrows only -- the links themselves stay --blue. */
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

/* ---- lists ---- */

/* Every bullet list works one way, whether or not it holds any checkboxes:
   the list contributes no indent of its own, and each item reserves a gutter
   and hangs its own marker -- a drawn box or a drawn dot -- on the rail
   inside it. Drawn, because a native list marker sits outside the content
   box and so cannot share a column with an absolutely positioned checkbox
   beside it. Once one item in a list needs drawing they all do, and one
   system throughout is easier to keep true than two meeting in the middle.

   Zero padding on a nested list, not one gutter: the parent item's gutter
   has already shifted it right by exactly that much, and adding another here
   would double the indent at every level. */
ul { margin: 0.25rem 0; padding-left: 0; list-style: none; }

ul > li {
    position: relative;
    padding-left: var(--gutter);
    padding-top: 2.5px;
    padding-bottom: 2.5px;
}

/* A numbered list keeps its numbers, and takes the gutter as padding so they
   land near the rail rather than hanging off the left of the item. */
ol { margin: 0.25rem 0; padding-left: var(--gutter); }

/* The bullet, sharing the checkbox's column and centred on the same rail.
   ::after, because ::before is the guide rail every item draws. */
ul > li:not(.cb-item)::after {
    content: "";
    position: absolute;
    left: calc(var(--rail) - 0.145em);
    top: calc(2.5px + (var(--lh) - 0.29em) / 2);
    width: 0.29em;
    height: 0.29em;
    border-radius: 50%;
    background: currentColor;
}

/* The guide rail hangs from the item, not from the list beneath it. A
   border-left on the child list could only start where that list starts,
   which for an item whose text wraps to three lines is three lines too low.
   Anchoring to the item drops the rail from directly beneath the item's own
   marker and runs it alongside the wrapped text as well as the children --
   so an item with no children still earns one the moment it wraps, and a
   single unwrapped line collapses it to nothing. */
ul > li::before {
    content: "";
    position: absolute;
    left: calc(var(--rail) - 0.5px);
    top: calc(var(--lh) + 5px);
    bottom: 0.5em;
    width: 1px;
    background: var(--rule);
}

/* markdown-it records the blank lines the wiki puts between items by making
   the list loose, which wraps every item in a <p>; a list written without
   them stays tight and has none. That <p> is the only surviving trace of the
   spacing the author typed, so read it back here.

   The gap lands on the following item rather than inside the paragraph: .cb
   is positioned against the item, so a margin above an item's first line
   would slide the text off its own checkbox. A second paragraph within one
   item keeps its margin -- there is no marker beside it to desync. */
li > p:first-of-type { margin-top: 0; }
li > p:last-of-type { margin-bottom: 0; }
li:has(> p) + li { margin-top: var(--item-gap); }

/* ---- checkbox lists ---- */

/* The colour and weight resets stop a resolved parent's styling leaking into
   plain children. */
ul > li:not(.cb-item) { color: var(--fg); font-weight: 400; }

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

/* Only the page padding narrows here. The gutter and rail are rem, so they
   already follow whatever --fs is set to and need no step of their own. */
@media (max-width: 420px) {
    body { padding: 1.2rem 0.85rem 3rem; }
}
`;
