# Reader — live read-only web view of the Wiki

**Date:** 2026-09-18
**Role:** `reader`
**Status:** design approved, not yet implemented

## Purpose

Serve the vimwiki notebook at `/mnt/gluster/resilio-sync/sync/Wiki` as a
read-only website that is legible on a phone and on a desktop. The site reads
files on demand, so an edit made in vim is visible on the next page load. No
static build step, no export.

A later iteration will make `- [ ]` checkboxes clickable and write the toggled
state back to the file. That is out of scope here, but the design leaves an
explicit seam for it (see [Future: checkbox toggling](#future-checkbox-toggling)).

## The corpus

Measured on 2026-09-18:

| property | value |
|---|---|
| notes at the wiki root | 2,034 `.md` |
| archived under `.sync/Archive` | 1,299 `.md` (excluded) |
| total size | 46 MB, mostly `.git` |
| internal links `](260415-0000a)` | 4,758 |
| wikilinks `[[id\|Label]]` | 197 |
| `- [X]` done | 20,510 |
| `- [ ]` open | 8,123 |
| `- [-]` dropped | 2,629 |
| `- [.]` in progress | 161 |
| files containing code fences | 146 |
| tables / images / external links | 0 / 0 / 1 |

Three facts drive the design:

1. **The tree is flat.** Every note lives directly at the wiki root. Nothing is
   nested. This makes routing and path safety trivial.
2. **There are four checkbox states, not two.** GFM task lists and
   `markdown-it-task-lists` both handle only `[ ]` and `[x]`, so the checkbox
   handling must be custom.
3. **The content is overwhelmingly deep nested task trees.** Legibility of
   4-level nesting at 375 px is the layout problem, not prose typography.

Notes carry YAML frontmatter:

```
---
title: 2026-09-18
tags: :zettel:
date: 2026-07-26 00:00
parent: [Parent note](220306-0621)
---
```

`parent` holds a markdown link, so the frontmatter parser must tolerate markdown
syntax in values.

## Scope

In scope:

- Render any note at the wiki root as HTML.
- `/` renders `index.md`.
- Both link styles resolve to other notes.
- All four checkbox states are parsed and carry their own mark. Note that
  `[ ]` and `[.]` share the same colour treatment by design — see
  [Reading layout](#decisions).
- Freshness on every load, with `ETag`/`304` revalidation.
- Mobile and desktop reading layout.

Explicitly out of scope (decided, not deferred by accident):

- Search, backlinks, tag pages, an all-notes index. Navigation is by following
  links from `index.md`, the same way the wiki is navigated in vim.
- Push-based live updates (SSE, websockets, file watching). "Live" means fresh
  on load.
- Rendering `.sync/Archive`, `.git`, or any non-`.md` file.
- Syntax highlighting in code fences.
- Editing of any kind.

## Architecture

A single Node 24 + TypeScript process using `node:http`. One runtime
dependency: `markdown-it`. Frontmatter is parsed by hand (the shape is fixed and
small) rather than adding a YAML dependency.

Because navigation is link-only, **a request touches exactly one file**. There
is no index to build, no tree to walk, no watcher to run.

### Modules

Each is independently testable and has no knowledge of HTTP except `server`.

| module | responsibility |
|---|---|
| `ids.ts` | validate and resolve a URL id to an absolute file path |
| `frontmatter.ts` | split and parse the YAML-ish header |
| `markdown.ts` | configure `markdown-it`; wikilink, link-normalization and checkbox rules |
| `render.ts` | note → complete HTML document (frontmatter + body + shell) |
| `cache.ts` | `path → {mtimeMs, size, etag, html}`, bounded |
| `server.ts` | routing, conditional-request handling, status codes |

### Routes

| route | behaviour |
|---|---|
| `GET /` | renders `index.md` |
| `GET /:id` | renders `<id>.md` |
| anything else | styled 404 |

### Path safety

`:id` must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.

- **No slashes are accepted at all.** The wiki is flat, so this eliminates path
  traversal by construction rather than by sanitisation.
- A leading `.` is rejected, which keeps `.git`, `.sync`, and `.claude`
  unreachable.
- As a second layer, the resolved absolute path is asserted to be a direct child
  of `WIKI_PATH`.

## Rendering pipeline

1. **Frontmatter** — split on the leading `---` block, parse `^(\w+):\s*(.*)$`.
   `title` drives `<title>` and the `<h1>`. `parent` renders as a breadcrumb and
   goes through the same link rules as body content. `tags` render as a small
   meta line.
2. **markdown-it** configured `html: false`, `linkify: true`, `typographer:
   false`. Disabling raw HTML removes the injection question entirely; the
   corpus contains no HTML. `linkify` is on because bare URLs appear in notes.
3. **Wikilink rule** — an inline rule for `[[target]]` and `[[target|label]]`
   producing `<a href="/target">label</a>`.
4. **Link normalization** — a `renderer.rules.link_open` override:
   - href with no scheme, no slash, no extension → `/<href>`
   - href ending in `.md` → extension stripped
   - `http(s)://` → untouched, plus `target="_blank" rel="noreferrer"`
   - `#anchor` → untouched
5. **Checkbox rule** — a core rule that detects `[ ]`, `[X]`, `[-]`, `[.]` at the
   head of a list item's inline content, strips the marker from the text, and
   emits a state class on the `<li>` plus **`data-line="<n>"`** taken from
   `token.map[0]`. The marker itself is drawn in CSS, not emitted as a glyph.
   A literal `[x]` in prose that is not at the head of a list item must remain
   plain text.
6. **Code fences** render as plain `<pre><code>`, monospace, horizontally
   scrollable. No highlighter.
7. **Heading demotion** — body headings are demoted one level, clamped at `h6`.
   Measured after implementation: the corpus uses `#` for section headings
   almost exclusively (988 `#` against 14 `##` and 3 `###`), so without this
   every section heading is an `<h1>` competing with the note title, and the
   `h2`–`h6` styling never applies. Demoting leaves exactly one `<h1>` per page.

## Caching and conditional requests

An in-memory `Map<path, {mtimeMs, size, etag, html}>`.

Per request:

1. `stat` the file — one metadata call, no read.
2. If `mtimeMs` and `size` match the cache entry, reuse the cached HTML and
   ETag. **No file read occurs.**
3. Otherwise read, render, and compute `etag = sha256(html)` truncated.
4. If `If-None-Match` matches the ETag, respond `304` with `ETag`,
   `Cache-Control`, and `Last-Modified`, empty body (~200 bytes).
5. Otherwise respond `200` with the rendered HTML and the same headers.

Decisions and why:

- **`Cache-Control: no-cache`** on notes — the browser may store the response but
  must revalidate every time. This is exactly the required behaviour: an
  unchanged note costs one `stat` and a `304`; a changed note is visible
  immediately. `no-store` would forfeit the 304; a `max-age` would break
  freshness.
- **Strong ETag from the content hash, not from mtime.** mtime across three
  gluster bricks is not something correctness should depend on. The hash is only
  computed when `stat` says the file actually changed, so the common path never
  pays for it.
- **`Last-Modified`/`If-Modified-Since`** are sent as well, as a fallback for
  clients that ignore ETags.
- **Bounded cache** — insertion-ordered, evicting past 100 entries.

  The cap was originally 2,500, sized to sit above the 2,034 notes at the wiki
  root so that nothing would ever be evicted. Measuring after implementation
  made that too expensive to be worth it: the whole corpus rendered is **19.6
  MB**, not the 6 MB originally estimated. Roughly half of that — 9.6 MB — is
  the 4.8 KB inlined stylesheet repeated across every cached page, which the
  inlining decision above pays for and the first estimate did not count. The
  median page is 6.9 KB; one outlier note is 1.8 MB because it contains a large
  pasted log in a code fence.

  Holding the whole corpus was never the point. Navigation is link-only and a
  single reader follows a handful of notes at a time, so 100 entries — a few
  hundred KB at the median page size — covers the working set, and the cap
  exists to bound worst-case memory rather than to manage it. A miss costs one
  read and one render, not a correctness problem.

  If memory ever needs to come down further, the cheapest lever is caching the
  body HTML rather than the assembled document and concatenating the shell per
  response, which would remove the repeated stylesheet. Not worth doing at this
  size.
- **CSS is inlined into the page**, not served as a separate asset. It is a few
  KB; inlining means one request per page (better on mobile), no asset cache
  invalidation to reason about, and the page ETag automatically covers style
  changes.

## Reading layout

Single column, comfortable measure, dark, derived from the user's actual
`jellybeans` + vimwiki configuration in
`~/synced/Projects/dotfiles/vim/config/vimwiki.vim`. That config contains:

```vim
hi! link VimwikiCheckBoxDone Title   " vimwiki's default is Comment (grey)
let g:vimwiki_hl_cb_checked = 1      " highlight the whole done line
```

The done state is deliberately *prominent*, not dimmed. The web view matches.

### Palette

| role | jellybeans group | hex |
|---|---|---|
| background | — | `#151515` |
| body text | `Normal` | `#e8e8d3` |
| resolved item (done and dropped) | `Title` | `#70b950` |
| links | `Underlined` | `#80a0ff` |
| code | `PreProc` | `#8fbfdc` |
| meta / frontmatter line | `Comment` | `#888888` |
| rails and rules | — | `#33383a` |

### Decisions

- **Nothing is faded.** Open items render at full strength; done items render in
  green at semibold.
- **Green means exactly one thing: resolved.** Section headings are therefore
  plain text with a hairline rule beneath them, rather than Title-green as they
  are in vim. This was chosen over the faithful-vim rendering so that colour
  carries state and nothing else.
- **`[X]` done and `[-]` dropped are deliberately near-identical** — same green,
  same weight, differing only by the mark inside the box (tick vs. bar). Both
  mean "resolved"; which kind is a detail.
- **`[.]` in progress renders plain** in the body colour, matching vim where it
  receives no special highlight. It does keep its own mark — a filled inner
  square — so it stays distinguishable from an open item; only the colour is
  plain.
- **Checkboxes are drawn in CSS**, not as unicode glyphs: `0.95em` box with a
  `1.6px` border, so stroke weight matches the surrounding text and scales with
  it. Unicode box characters render hairline-thin and were rejected for that
  reason. *The exact mark shapes are an open item for a later pass.*

### Nesting

The row is a two-column grid: a `1.45rem` gutter holding the centred checkbox,
then the content column.

Guide rails are **absolutely positioned on the list item**, at `left:
gutter/2`, from `top: 1.55em + 5px` down to `bottom: 0.5em`. They are not a
`border-left` on the child `<ul>`. This matters: with a border on the child
list, a rail can only begin where the child list begins, which for an item whose
text wraps to three lines means the rail starts three lines too low. Anchoring
to the item makes the rail drop from directly beneath its own checkbox and run
alongside the wrapped text, which is the correct reading.

Because the box is centred in a fixed gutter and each nesting level indents by
exactly one gutter, rails align under checkbox centres at every depth.

Two further points settled during implementation:

- Colour and weight are set on the `<li>` itself, not on a child `<p>`. The
  wiki's lists are tight, so markdown-it emits no paragraph wrapper and the text
  is a direct child of the item. Every state states both properties explicitly
  so a resolved parent cannot bleed into its open children.
- `overflow-wrap: anywhere` on the body, with `pre` opting back out. Notes
  contain long unbroken URLs which otherwise scroll the whole page sideways on a
  phone; a code fence is the one place a long line should scroll inside its own
  box instead of wrapping.

## Testing

Run as `rm -rf dist && tsc && node --test dist/*.test.js`, matching `planner`.

Unit tests over pure functions:

- Frontmatter: `parent:` containing a markdown link; absent block; malformed block.
- Link normalization: each of the four cases above.
- Wikilinks: `[[id]]` and `[[id|Label]]`.
- Checkboxes: all four states; nesting; `data-line` correctness against the
  source; the negative case of a literal `[x]` in prose.
- Id validation: rejects `/`, `..`, leading `.`, empty; accepts `index` and
  `260726-0000a`.
- Cache: unchanged `mtime`+`size` serves without re-reading (fs spy); changed
  content yields a different ETag; eviction past the cap.

One integration test: start the real server on port 0 over a temporary fixture
directory and drive it with `fetch`, asserting `200`/`304`/`404` and the
`ETag`, `Cache-Control`, and `Last-Modified` headers end to end.

The suite has no dependency on gluster or on the real wiki.

## Deployment

A new `roles/reader/` registered in `playbook.yml` under the `deploy` play with
tag `reader`, following `ticker` and `planner`.

- **DNS** — Cloudflare A record `reader.{{ config.domain }}` → `{{ config.ip }}`.
- **Image** — `gitea.{{ config.domain }}/{{ config.gitea.username }}/reader`,
  `linux/amd64`, built and pushed from localhost via
  `community.docker.docker_image_build`.
- **Stack** — `reader`, on the `traefik_traefik` external network.
- **Volume** — `/mnt/gluster/resilio-sync/sync/Wiki:/wiki:ro`. The read-only
  guarantee is enforced by the mount, not only by application code.
- **Environment** — `WIKI_PATH=/wiki`, `PORT=8080`, `TZ=America/Los_Angeles`.
- **Traefik labels** — a ``Host(`reader.{{ config.domain }}`)`` rule, middlewares
  `traefik-internal,traefik-forward-auth`, entrypoint `websecure`, certresolver
  `letsencrypt`, service port `8080`.
- **Placement** — `node.labels.home.instance_type == mbp`, matching `planner`,
  which already mounts this exact path.
- **Scheduler labels** — `home.scheduler.replicas=1`, `home.scheduler.priority=50`.
- **Resources** — limits `0.25` cpu, `150M` memory (see the cache sizing above).
- **Restart** — `delay: 30s`; `update_config: order: stop-first`.

## Future: checkbox toggling

Not built now. The design accommodates it as follows, recorded so the seam is
not lost:

- Every checkbox `<li>` already carries `data-line`, the zero-based source line
  of that item. A future `PATCH /:id/toggle` can rewrite exactly that one line —
  replacing the marker character between `[` and `]` — without reparsing the
  document or rewriting the file wholesale.
- The `:ro` on the volume mount becomes `rw`. That is a deliberate, reviewable
  change rather than something latent.
- **Interaction with `planner`.** The `planner` role commits and pushes this
  wiki daily using `simple-git` (`roles/planner/src/lib.ts`). A single-line
  toggle written to disk is compatible — planner commits whatever is on disk at
  run time — but the two writers are not coordinated. If toggling ever becomes
  heavily used, revisit whether reader should write through git rather than
  straight to the file.
- Concurrency with vim is the other unaddressed case: reader would need to
  re-`stat` immediately before writing and reject the toggle if the file changed
  since the page was rendered, so a stale tab cannot clobber an edit. The ETag
  already sent to the browser is the natural precondition token for this
  (`If-Match`).

## Open items

- Checkbox mark shapes (tick, bar, in-progress) are placeholders pending a
  dedicated pass.
- Hostname is `reader.{{ config.domain }}` to match the role name; `wiki.` was
  noted as an alternative and not chosen.
- No light-mode variant. The design follows jellybeans, which is dark-only.
