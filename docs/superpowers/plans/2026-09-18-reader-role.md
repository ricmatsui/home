# Reader Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the vimwiki notebook at `/mnt/gluster/resilio-sync/sync/Wiki` as a live, read-only, mobile-friendly website at `reader.{{ config.domain }}`.

**Architecture:** A single Node 24 + TypeScript process on `node:http` with one runtime dependency (`markdown-it`). Navigation is link-only, so a request reads exactly one file — no index, no watcher, no scan. An in-memory cache keyed on `mtime`+`size` avoids re-reading unchanged notes, and `Cache-Control: no-cache` plus a strong `ETag` gives cheap `304` revalidation on every load. Deployed as a Docker Swarm stack behind traefik, mounting the wiki read-only.

**Tech Stack:** Node 24, TypeScript (NodeNext), `markdown-it` 14, `node --test`, Docker, Ansible, Docker Swarm, traefik.

**Spec:** `docs/superpowers/specs/2026-09-18-reader-design.md`

## Global Constraints

- **Node version:** 24. `.node-version` contains `24`. Docker base image `node:24.14-trixie@sha256:81649592d9833d9220423561fc517b34e932b751873274024c2a969ff4a9bfc2` (copied verbatim from `roles/planner/Dockerfile`).
- **Package manager:** yarn, with `--frozen-lockfile` in Docker. Every role in this repo uses yarn.
- **Module system:** ESM. `package.json` has `"type": "module"`; `tsconfig.json` uses `"module": "NodeNext"`. Relative imports inside `src/` MUST carry a `.js` extension (e.g. `import { isValidId } from './ids.js'`) even though the source file is `.ts`.
- **Runtime dependencies:** exactly one — `markdown-it` `^14.1.0`. Everything else is a devDependency. Do not add a YAML parser, a sanitiser, a syntax highlighter, or a web framework.
- **Tests:** `node --test dist/*.test.js` after `tsc`, matching `roles/planner/package.json`. No vitest, no jest.
- **Indentation:** 4 spaces in all TypeScript, YAML, and JSON, matching the repo.
- **Checkbox states:** exactly four — `[ ]` open, `[X]` done, `[-]` dropped, `[.]` in progress. Lowercase `[x]` must also be accepted as done.
- **Colours** (from `jellybeans` via `~/synced/Projects/dotfiles/vim/config/vimwiki.vim`): background `#151515`, body `#e8e8d3`, resolved `#70b950`, links `#80a0ff`, code `#8fbfdc`, meta `#888888`, rules/rails `#33383a`.
- **Never write to the wiki.** The mount is `:ro`. This build is read-only end to end.
- **Do not `git add` or commit** unless the user asks — this repo's owner reviews and stages changes themselves. Where a task below says "Commit", stop and report instead, leaving changes in the working tree.

---

## File Structure

All paths relative to the repo root.

| file | responsibility |
|---|---|
| `roles/reader/package.json` | deps and scripts |
| `roles/reader/tsconfig.json` | NodeNext, strict, `outDir: dist` |
| `roles/reader/.node-version` | `24` |
| `roles/reader/.envrc` | fnm + `node_modules/.bin` on PATH |
| `roles/reader/.gitignore` | `dist/`, `node_modules/` |
| `roles/reader/.dockerignore` | `node_modules`, `dist`, `.git`, `.DS_Store` |
| `roles/reader/Dockerfile` | build and run the server |
| `roles/reader/src/ids.ts` | validate a URL id, resolve it to a file path |
| `roles/reader/src/frontmatter.ts` | split and parse the YAML-ish header |
| `roles/reader/src/markdown.ts` | `markdown-it` instance + the three custom rules |
| `roles/reader/src/styles.ts` | the inlined stylesheet, as a string constant |
| `roles/reader/src/render.ts` | note source → complete HTML document |
| `roles/reader/src/cache.ts` | bounded `path → {mtimeMs, size, etag, html}` map |
| `roles/reader/src/server.ts` | routing, conditional requests, status codes |
| `roles/reader/src/index.ts` | entrypoint: read env, start the server |
| `roles/reader/src/*.test.ts` | one test file per module |
| `roles/reader/tasks/main.yml` | DNS, image build, stack deploy |
| `playbook.yml` | register the role under the `deploy` play |

---

## Task 1: Scaffolding and id resolution

**Files:**
- Create: `roles/reader/package.json`, `roles/reader/tsconfig.json`, `roles/reader/.node-version`, `roles/reader/.envrc`, `roles/reader/.gitignore`, `roles/reader/.dockerignore`
- Create: `roles/reader/src/ids.ts`
- Test: `roles/reader/src/ids.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `isValidId(id: string): boolean`
  - `resolveNotePath(wikiPath: string, id: string): string | null` — returns an absolute path to `<id>.md`, or `null` if the id is unsafe.

- [ ] **Step 1: Create the scaffolding files**

`roles/reader/package.json`:

```json
{
    "name": "reader",
    "version": "1.0.0",
    "license": "MIT",
    "type": "module",
    "scripts": {
        "build": "tsc || exit 1",
        "test": "rm -rf dist && tsc && TZ=America/Los_Angeles node --test dist/*.test.js",
        "start": "node dist/index.js"
    },
    "dependencies": {
        "markdown-it": "^14.1.0"
    },
    "devDependencies": {
        "@types/markdown-it": "^14.1.2",
        "@types/node": "^26.2.0",
        "typescript": "^5.9.3"
    }
}
```

`roles/reader/tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "esnext",
        "module": "NodeNext",
        "moduleResolution": "NodeNext",
        "strict": true,
        "skipLibCheck": true,
        "esModuleInterop": true,
        "outDir": "dist"
    },
    "include": ["src"]
}
```

`roles/reader/.node-version`:

```
24
```

`roles/reader/.envrc`:

```bash
use_fnm() {
  fnm use --install-if-missing
}

use fnm
PATH_add node_modules/.bin
```

`roles/reader/.gitignore`:

```
dist/
node_modules/
```

`roles/reader/.dockerignore`:

```
node_modules
dist
.git
.DS_Store
```

- [ ] **Step 2: Install dependencies**

Run from `roles/reader/`:

```bash
yarn install
```

Expected: `yarn.lock` created, `node_modules/` populated.

- [ ] **Step 3: Write the failing test**

`roles/reader/src/ids.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { isValidId, resolveNotePath } from './ids.js';

test('accepts the ids that actually appear in the wiki', () => {
    assert.equal(isValidId('index'), true);
    assert.equal(isValidId('260726-0000a'), true);
    assert.equal(isValidId('220306-0621'), true);
});

test('rejects ids containing a slash', () => {
    assert.equal(isValidId('a/b'), false);
    assert.equal(isValidId('../etc/passwd'), false);
    assert.equal(isValidId('.sync/Archive/x'), false);
});

test('rejects ids starting with a dot, which keeps .git and .sync unreachable', () => {
    assert.equal(isValidId('.git'), false);
    assert.equal(isValidId('.sync'), false);
    assert.equal(isValidId('.claude'), false);
    assert.equal(isValidId('..'), false);
});

test('rejects the empty id', () => {
    assert.equal(isValidId(''), false);
});

test('rejects ids with characters outside the allowed set', () => {
    assert.equal(isValidId('a b'), false);
    assert.equal(isValidId('a\0b'), false);
    assert.equal(isValidId('a%2fb'), false);
});

test('resolves a valid id to a direct child of the wiki root', () => {
    assert.equal(
        resolveNotePath('/wiki', '260726-0000a'),
        '/wiki/260726-0000a.md',
    );
});

test('resolves relative wiki roots to absolute paths', () => {
    const resolved = resolveNotePath('/wiki/../wiki', 'index');
    assert.equal(resolved, '/wiki/index.md');
});

test('returns null for an unsafe id rather than throwing', () => {
    assert.equal(resolveNotePath('/wiki', '../secret'), null);
    assert.equal(resolveNotePath('/wiki', '.git'), null);
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run from `roles/reader/`:

```bash
yarn test
```

Expected: FAIL — `Cannot find module './ids.js'`.

- [ ] **Step 5: Write the implementation**

`roles/reader/src/ids.ts`:

```typescript
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
```

- [ ] **Step 6: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 8 tests.

- [ ] **Step 7: Commit**

```bash
git add roles/reader/package.json roles/reader/tsconfig.json roles/reader/yarn.lock \
    roles/reader/.node-version roles/reader/.envrc roles/reader/.gitignore \
    roles/reader/.dockerignore roles/reader/src/ids.ts roles/reader/src/ids.test.ts
git commit -m "Add reader role scaffolding and note id resolution"
```

Per Global Constraints, do not run this — report the change and leave it staged for review.

---

## Task 2: Frontmatter parsing

**Files:**
- Create: `roles/reader/src/frontmatter.ts`
- Test: `roles/reader/src/frontmatter.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface Frontmatter { title?: string; tags?: string; date?: string; parent?: string; }`
  - `interface ParsedNote { frontmatter: Frontmatter; body: string; bodyOffset: number; }`
  - `parseFrontmatter(source: string): ParsedNote`

`bodyOffset` is the count of source lines consumed by the frontmatter block. It exists because `markdown-it` reports token line numbers relative to the string it was given. Task 4 emits `data-line` attributes that must point at lines in the *original file*, so it adds `bodyOffset` to every token line. Getting this wrong silently breaks the future checkbox toggle.

- [ ] **Step 1: Write the failing test**

`roles/reader/src/frontmatter.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontmatter } from './frontmatter.js';

const NOTE = [
    '---',
    'title: 2026-09-18',
    'tags: :zettel:',
    'date: 2026-07-26 00:00',
    'parent: [Parent note](220306-0621)',
    '---',
    '',
    '# Section',
    '',
    '- a plain item',
    '',
].join('\n');

test('parses the frontmatter fields of a note', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.frontmatter.title, '2026-09-18');
    assert.equal(parsed.frontmatter.tags, ':zettel:');
    assert.equal(parsed.frontmatter.date, '2026-07-26 00:00');
});

test('keeps a markdown link in a value intact', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.frontmatter.parent, '[Parent note](220306-0621)');
});

test('body excludes the frontmatter block', () => {
    const parsed = parseFrontmatter(NOTE);

    assert.equal(parsed.body.startsWith('\n# Section'), true);
    assert.equal(parsed.body.includes('title:'), false);
});

test('bodyOffset counts the lines the frontmatter consumed', () => {
    const parsed = parseFrontmatter(NOTE);

    // Lines 0-5 are the block including both --- delimiters, so the body
    // starts at source line 6.
    assert.equal(parsed.bodyOffset, 6);
    assert.equal(NOTE.split('\n')[parsed.bodyOffset + 1], '# Section');
});

test('a note with no frontmatter is all body at offset zero', () => {
    const parsed = parseFrontmatter('# Just a heading\n\ntext\n');

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, '# Just a heading\n\ntext\n');
    assert.equal(parsed.bodyOffset, 0);
});

test('an unterminated frontmatter block is treated as body, not swallowed', () => {
    const source = '---\ntitle: broken\n\n# Heading\n';
    const parsed = parseFrontmatter(source);

    assert.deepEqual(parsed.frontmatter, {});
    assert.equal(parsed.body, source);
    assert.equal(parsed.bodyOffset, 0);
});

test('ignores lines inside the block that are not key: value', () => {
    const parsed = parseFrontmatter('---\ntitle: X\nnot a pair\n---\nbody\n');

    assert.deepEqual(parsed.frontmatter, { title: 'X' });
});

test('handles CRLF line endings', () => {
    const parsed = parseFrontmatter('---\r\ntitle: X\r\n---\r\nbody\r\n');

    assert.equal(parsed.frontmatter.title, 'X');
    assert.equal(parsed.bodyOffset, 3);
});

test('an empty value yields an empty string, not undefined', () => {
    const parsed = parseFrontmatter('---\ntitle:\n---\nbody\n');

    assert.equal(parsed.frontmatter.title, '');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `Cannot find module './frontmatter.js'`.

- [ ] **Step 3: Write the implementation**

`roles/reader/src/frontmatter.ts`:

```typescript
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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 9 tests in this file.

- [ ] **Step 5: Commit**

```bash
git add roles/reader/src/frontmatter.ts roles/reader/src/frontmatter.test.ts
git commit -m "Parse wiki note frontmatter and track the body line offset"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 3: Link normalization and wikilinks

**Files:**
- Create: `roles/reader/src/markdown.ts`
- Test: `roles/reader/src/markdown.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `normalizeHref(href: string): { href: string; external: boolean }`
  - `createMarkdown(): MarkdownIt` — a configured instance. Task 4 extends this same file; Task 5 calls `createMarkdown()`.

Reference for the two link forms, measured across the corpus: 4,758 links of the form `[Text](260415-0000a)` and 197 of the form `[[260415-0000a|Text]]`.

- [ ] **Step 1: Write the failing test**

`roles/reader/src/markdown.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown, normalizeHref } from './markdown.js';

test('an extensionless relative link becomes a root-relative note link', () => {
    assert.deepEqual(normalizeHref('260415-0000a'), {
        href: '/260415-0000a',
        external: false,
    });
});

test('a .md extension is stripped', () => {
    assert.deepEqual(normalizeHref('220306-0621.md'), {
        href: '/220306-0621',
        external: false,
    });
});

test('an anchor on a note link is preserved', () => {
    assert.deepEqual(normalizeHref('220306-0621#weather'), {
        href: '/220306-0621#weather',
        external: false,
    });
});

test('a bare anchor is left alone', () => {
    assert.deepEqual(normalizeHref('#weather'), {
        href: '#weather',
        external: false,
    });
});

test('absolute and scheme-bearing hrefs are left alone and marked external', () => {
    assert.deepEqual(normalizeHref('https://example.com'), {
        href: 'https://example.com',
        external: true,
    });
    assert.deepEqual(normalizeHref('mailto:x@example.com'), {
        href: 'mailto:x@example.com',
        external: true,
    });
    assert.deepEqual(normalizeHref('//example.com/x'), {
        href: '//example.com/x',
        external: true,
    });
});

test('an already root-relative href is left alone and is not external', () => {
    assert.deepEqual(normalizeHref('/index'), {
        href: '/index',
        external: false,
    });
});

test('renders a markdown note link as a root-relative anchor', () => {
    const html = createMarkdown().render('See [another note](220306-0621) today.');

    assert.match(html, /<a href="\/220306-0621">another note<\/a>/);
});

test('renders an external link with target and rel', () => {
    const html = createMarkdown().render('[t](https://example.com)');

    assert.match(html, /href="https:\/\/example\.com"/);
    assert.match(html, /target="_blank"/);
    assert.match(html, /rel="noreferrer"/);
});

test('linkifies a bare url, since notes contain them unbracketed', () => {
    const html = createMarkdown().render('Follow https://example.com');

    assert.match(html, /<a href="https:\/\/example\.com"/);
});

test('renders a labelled wikilink', () => {
    const html = createMarkdown().render('- [[251129-1242|A label]]');

    assert.match(html, /<a href="\/251129-1242">A label<\/a>/);
});

test('renders an unlabelled wikilink using the target as the label', () => {
    const html = createMarkdown().render('[[251129-1242]]');

    assert.match(html, /<a href="\/251129-1242">251129-1242<\/a>/);
});

test('leaves an unterminated double bracket as literal text', () => {
    const html = createMarkdown().render('[[not closed');

    assert.match(html, /\[\[not closed/);
});

test('does not emit raw html from note content', () => {
    const html = createMarkdown().render('<script>alert(1)</script>');

    assert.equal(html.includes('<script>'), false);
});

test('renders a code fence without a highlighter', () => {
    const html = createMarkdown().render('```\nconst x = 1;\n```');

    assert.match(html, /<pre><code>const x = 1;/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `Cannot find module './markdown.js'`.

- [ ] **Step 3: Write the implementation**

`roles/reader/src/markdown.ts`:

```typescript
import MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';

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

    if (!silent) {
        const pipeAt = inner.indexOf('|');
        const target = (pipeAt === -1 ? inner : inner.slice(0, pipeAt)).trim();
        const label = (pipeAt === -1 ? inner : inner.slice(pipeAt + 1)).trim();

        if (target.length === 0) {
            return false;
        }

        const open = state.push('link_open', 'a', 1);
        open.attrSet('href', target);

        const text = state.push('text', '', 0);
        text.content = label.length > 0 ? label : target;

        state.push('link_close', 'a', -1);
    }

    state.pos = end + 2;
    return true;
}

export function createMarkdown(): MarkdownIt {
    const md = new MarkdownIt({
        // The corpus contains no HTML, and disabling it removes the
        // injection question entirely.
        html: false,
        // Notes contain bare urls.
        linkify: true,
        typographer: false,
    });

    md.inline.ruler.before('link', 'wikilink', wikilink);

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

    return md;
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 14 tests in this file.

If `tsc` cannot resolve `markdown-it/lib/rules_inline/state_inline.mjs`, check the installed `@types/markdown-it` version — v14 ships that path. Do not work around it with `any`.

- [ ] **Step 5: Commit**

```bash
git add roles/reader/src/markdown.ts roles/reader/src/markdown.test.ts
git commit -m "Render vimwiki note links and wikilinks as site links"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 4: Four-state checkboxes with source line numbers

**Files:**
- Modify: `roles/reader/src/markdown.ts`
- Test: `roles/reader/src/checkbox.test.ts`

**Interfaces:**
- Consumes: `createMarkdown()` from Task 3.
- Produces:
  - `type CheckboxState = 'open' | 'done' | 'dropped' | 'progress'`
  - `createMarkdown(bodyOffset?: number): MarkdownIt` — the signature gains an optional line offset, defaulting to `0`. Task 5 passes the `bodyOffset` from `parseFrontmatter`.

Why this is custom: GFM task lists and `markdown-it-task-lists` both handle only `[ ]` and `[x]`. This corpus has four states — 20,510 `[X]`, 8,123 `[ ]`, 2,629 `[-]`, 161 `[.]`.

Two implementation details that are easy to get wrong:

1. The rule runs on the **core ruler before `inline`**. At that point a list item's inline token still has a plain `.content` string and a null `.children`, so the marker can be stripped by editing `.content`. If it ran after `inline`, editing `.content` would have no effect on the output because rendering walks `.children`.
2. The checkbox element is emitted by a `list_item_open` renderer override rather than as a token. The mark itself is drawn purely in CSS, so the markup is one empty `<span>`.
3. `markdown-it` emits `paragraph_open`/`inline`/`paragraph_close` for **both** tight and loose lists — for tight lists the paragraph tokens simply carry `hidden = true`. So the `tokens[i + 1].type === 'paragraph_open'` lookahead below holds for every list in the corpus, not just the loose ones. Do not "fix" it by special-casing tight lists.

- [ ] **Step 1: Write the failing test**

`roles/reader/src/checkbox.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarkdown } from './markdown.js';

test('renders each of the four checkbox states with its own class', () => {
    const html = createMarkdown().render(
        [
            '- [ ] open item',
            '- [X] done item',
            '- [-] dropped item',
            '- [.] in progress item',
        ].join('\n'),
    );

    assert.match(html, /<li class="cb-item cb-open"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-done"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-dropped"[^>]*>/);
    assert.match(html, /<li class="cb-item cb-progress"[^>]*>/);
});

test('accepts a lowercase x as done', () => {
    const html = createMarkdown().render('- [x] done item');

    assert.match(html, /cb-done/);
});

test('strips the marker from the rendered text', () => {
    const html = createMarkdown().render('- [X] done item');

    assert.equal(html.includes('[X]'), false);
    assert.match(html, /done item/);
});

test('emits an empty span for the box, which css draws', () => {
    const html = createMarkdown().render('- [X] done item');

    assert.match(html, /<span class="cb cb-mark-done" aria-hidden="true"><\/span>/);
});

test('records the zero-based source line of each item', () => {
    const html = createMarkdown().render(
        ['- [ ] first', '- [ ] second', '- [ ] third'].join('\n'),
    );

    assert.match(html, /data-line="0"/);
    assert.match(html, /data-line="1"/);
    assert.match(html, /data-line="2"/);
});

test('offsets source lines by the frontmatter length', () => {
    const html = createMarkdown(6).render('- [ ] first\n- [ ] second');

    assert.match(html, /data-line="6"/);
    assert.match(html, /data-line="7"/);
});

test('marks an item that has a nested list so css can draw its rail', () => {
    const html = createMarkdown().render(
        ['- [ ] parent', '    - [ ] child'].join('\n'),
    );

    assert.match(html, /<li class="cb-item cb-open cb-parent"[^>]*>/);
});

test('does not mark a leaf item as a parent', () => {
    const html = createMarkdown().render('- [ ] leaf');

    assert.equal(html.includes('cb-parent'), false);
});

test('parses four levels of four-space indentation as nested lists', () => {
    const html = createMarkdown().render(
        [
            '- [.] level one',
            '    - [X] level two',
            '        - [X] level three',
            '            - [X] level four',
        ].join('\n'),
    );

    // Four <ul> means the deepest item really is a list item and not an
    // indented code block.
    assert.equal(html.split('<ul>').length - 1, 4);
    assert.equal(html.includes('<pre>'), false);
    assert.match(html, /level four/);
});

test('leaves a bracket expression in prose alone', () => {
    const html = createMarkdown().render('The flag [x] is set in the config.');

    assert.equal(html.includes('cb-item'), false);
    assert.match(html, /\[x\] is set/);
});

test('leaves an unknown marker alone', () => {
    const html = createMarkdown().render('- [?] not a state');

    assert.equal(html.includes('cb-item'), false);
    assert.match(html, /\[\?\] not a state/);
});

test('leaves a plain list item alone', () => {
    const html = createMarkdown().render('- a plain item');

    assert.equal(html.includes('cb-item'), false);
});

test('keeps links inside a checkbox item working', () => {
    const html = createMarkdown().render('- [ ] [2027-01-05](260415-0000a)');

    assert.match(html, /cb-open/);
    assert.match(html, /<a href="\/260415-0000a">2027-01-05<\/a>/);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `createMarkdown` takes no argument and emits no `cb-item` classes.

- [ ] **Step 3: Extend the implementation**

Add these imports at the top of `roles/reader/src/markdown.ts`:

```typescript
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
```

Add this above `createMarkdown`:

```typescript
export type CheckboxState = 'open' | 'done' | 'dropped' | 'progress';

const MARKERS = new Map<string, CheckboxState>([
    [' ', 'open'],
    ['x', 'done'],
    ['X', 'done'],
    ['-', 'dropped'],
    ['.', 'progress'],
]);

const MARKER_PATTERN = /^\[(.)\][ \t]+/;

// Runs on the core ruler BEFORE 'inline'. At this point the inline token
// still holds a plain content string with null children, so the marker can
// be stripped by editing content. After inline parsing it could not.
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
            if (hasNestedList(tokens, i)) {
                itemOpen.attrJoin('class', 'cb-parent');
            }
            itemOpen.attrSet('data-state', checkboxState);
            itemOpen.attrSet(
                'data-line',
                String((itemOpen.map !== null ? itemOpen.map[0] : 0) + bodyOffset),
            );
        }
    };
}

// True when the item at openIndex contains a nested list before its own
// close token. The class drives the css guide rail, which is only drawn for
// items that actually have children.
function hasNestedList(
    tokens: StateCore['tokens'],
    openIndex: number,
): boolean {
    let depth = 0;

    for (let i = openIndex + 1; i < tokens.length; i++) {
        const type = tokens[i].type;

        if (type === 'list_item_open') {
            depth++;
        } else if (type === 'list_item_close') {
            if (depth === 0) {
                return false;
            }
            depth--;
        } else if (
            depth === 0 &&
            (type === 'bullet_list_open' || type === 'ordered_list_open')
        ) {
            return true;
        }
    }

    return false;
}
```

Change the `createMarkdown` signature and add the rule plus the renderer override. The function body is otherwise unchanged from Task 3:

```typescript
export function createMarkdown(bodyOffset = 0): MarkdownIt {
    const md = new MarkdownIt({
        html: false,
        linkify: true,
        typographer: false,
    });

    md.inline.ruler.before('link', 'wikilink', wikilink);
    md.core.ruler.before('inline', 'vimwiki_checkbox', createCheckboxRule(bodyOffset));

    // ... the existing link_open override from Task 3 stays exactly as it is ...

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
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 13 tests in `checkbox.test.js` and the 14 from Task 3 still green.

- [ ] **Step 5: Commit**

```bash
git add roles/reader/src/markdown.ts roles/reader/src/checkbox.test.ts
git commit -m "Render the four vimwiki checkbox states with source line numbers"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 5: Stylesheet and full-document rendering

**Files:**
- Create: `roles/reader/src/styles.ts`
- Create: `roles/reader/src/render.ts`
- Test: `roles/reader/src/render.test.ts`

**Interfaces:**
- Consumes: `parseFrontmatter` (Task 2), `createMarkdown` (Tasks 3-4).
- Produces:
  - `STYLES: string` from `styles.ts`
  - `renderNote(source: string, id: string): string` — a complete HTML document
  - `renderNotFound(id: string): string` — a complete HTML document

The css is inlined into the page rather than served as an asset: it is a few KB, it means one request per page on mobile, and it removes any asset cache-invalidation story because the page ETag already covers style changes.

- [ ] **Step 1: Write the stylesheet**

`roles/reader/src/styles.ts`:

```typescript
// Colours are taken from the jellybeans colourscheme plus the user's
// vimwiki override `hi! link VimwikiCheckBoxDone Title`, which deliberately
// makes done items prominent rather than grey. Nothing here is dimmed.
//
// Green means exactly one thing: resolved. Section headings are therefore
// plain with a hairline rule rather than Title-green as they are in vim.
export const STYLES = `
:root {
    --bg: #151515;
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
}

main { max-width: 46rem; margin: 0 auto; }

h1 {
    font-size: 1.4rem;
    font-weight: 650;
    letter-spacing: -0.01em;
    margin: 0 0 0.2rem;
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
   the plain ones, since the rule above stripped the whole list. */
ul:has(> li.cb-item) > li:not(.cb-item) { list-style: disc; margin-left: 1.1rem; }

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

/* Open and in-progress share a treatment: in vim, [.] receives no special
   highlight either. */
li.cb-open, li.cb-progress { color: var(--fg); }

/* Done and dropped are both resolved, and differ only by the mark inside
   the box. Neither is dimmed and neither is struck through. */
li.cb-done, li.cb-dropped { color: var(--green); }
li.cb-done > p, li.cb-dropped > p { font-weight: 600; }

@media (max-width: 420px) {
    body { padding: 1.2rem 0.85rem 3rem; font-size: 15px; }
    :root { --gutter: 1.3rem; --rail: 0.65rem; }
}
`;
```

- [ ] **Step 2: Write the failing test**

`roles/reader/src/render.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { renderNote, renderNotFound } from './render.js';

const NOTE = [
    '---',
    'title: 2026-09-18',
    'tags: :zettel:',
    'date: 2026-07-26 00:00',
    'parent: [Parent note](220306-0621)',
    '---',
    '',
    '# Section',
    '',
    '- [X] Follow https://example.com',
    '- [.] A parent item',
    '    - [ ] A nested item',
    '',
].join('\n');

test('produces a complete html document', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /<html lang="en">/);
    assert.match(html, /<meta name="viewport" content="width=device-width, initial-scale=1">/);
    assert.match(html, /<\/html>\s*$/);
});

test('uses the frontmatter title for the document title and heading', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<title>2026-09-18<\/title>/);
    assert.match(html, /<h1>2026-09-18<\/h1>/);
});

test('falls back to the id when the note has no title', () => {
    const html = renderNote('just body text\n', '221126-1938');

    assert.match(html, /<title>221126-1938<\/title>/);
    assert.match(html, /<h1>221126-1938<\/h1>/);
});

test('renders the parent frontmatter as a working breadcrumb link', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<a href="\/220306-0621">another note<\/a>/);
});

test('shows the tags', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /:zettel:/);
});

test('inlines the stylesheet rather than linking an asset', () => {
    const html = renderNote(NOTE, '260726-0000a');

    assert.match(html, /<style>/);
    assert.equal(html.includes('<link rel="stylesheet"'), false);
});

test('offsets checkbox line numbers past the frontmatter', () => {
    const html = renderNote(NOTE, '260726-0000a');

    // The '- [X] Follow ...' line is line 9 of the source file.
    assert.equal(NOTE.split('\n')[9].startsWith('- [X] Follow'), true);
    assert.match(html, /data-line="9"/);
});

test('escapes a title that contains html-significant characters', () => {
    const html = renderNote('---\ntitle: a < b & c\n---\nbody\n', 'x');

    assert.match(html, /<title>a &lt; b &amp; c<\/title>/);
    assert.equal(html.includes('<title>a < b'), false);
});

test('the not found page is a complete document naming the id', () => {
    const html = renderNotFound('nope');

    assert.match(html, /^<!doctype html>/i);
    assert.match(html, /nope/);
    assert.match(html, /<a href="\/">/);
});

test('escapes the id on the not found page', () => {
    const html = renderNotFound('<script>x</script>');

    assert.equal(html.includes('<script>x</script>'), false);
    assert.match(html, /&lt;script&gt;/);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `Cannot find module './render.js'`.

- [ ] **Step 4: Write the implementation**

`roles/reader/src/render.ts`:

```typescript
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
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 10 tests in this file.

- [ ] **Step 6: Commit**

```bash
git add roles/reader/src/styles.ts roles/reader/src/render.ts roles/reader/src/render.test.ts
git commit -m "Render a note as a complete styled html document"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 6: Render cache

**Files:**
- Create: `roles/reader/src/cache.ts`
- Test: `roles/reader/src/cache.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface CacheEntry { mtimeMs: number; size: number; etag: string; html: string; }`
  - `class RenderCache { constructor(max?: number); get(key: string, mtimeMs: number, size: number): CacheEntry | undefined; set(key: string, entry: CacheEntry): void; get size(): number; }`
  - `computeEtag(html: string): string` — a quoted strong ETag.

`get` returns `undefined` when the entry is absent **or** when `mtimeMs`/`size` do not match, so the caller never has to compare freshness itself.

Why a content hash rather than an mtime token: mtime across three gluster bricks is not something correctness should depend on. The hash is only computed when `stat` says the file changed, so the common path never pays for it.

Cap is 2,500, above the 2,034 notes at the wiki root — in steady state nothing is evicted. The cap bounds worst-case memory rather than managing it.

- [ ] **Step 1: Write the failing test**

`roles/reader/src/cache.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import { RenderCache, computeEtag } from './cache.js';

function entry(html: string, mtimeMs: number, size: number) {
    return { mtimeMs, size, etag: computeEtag(html), html };
}

test('an etag is a quoted strong validator', () => {
    const etag = computeEtag('<p>x</p>');

    assert.match(etag, /^"[0-9a-f]+"$/);
});

test('identical html yields an identical etag', () => {
    assert.equal(computeEtag('<p>x</p>'), computeEtag('<p>x</p>'));
});

test('different html yields a different etag', () => {
    assert.notEqual(computeEtag('<p>x</p>'), computeEtag('<p>y</p>'));
});

test('returns a stored entry when mtime and size both match', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    const found = cache.get('/wiki/a.md', 100, 10);

    assert.notEqual(found, undefined);
    assert.equal(found?.html, '<p>a</p>');
});

test('returns undefined when the mtime has moved', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    assert.equal(cache.get('/wiki/a.md', 200, 10), undefined);
});

test('returns undefined when the size has changed', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));

    assert.equal(cache.get('/wiki/a.md', 100, 11), undefined);
});

test('returns undefined for a key that was never stored', () => {
    assert.equal(new RenderCache().get('/wiki/missing.md', 1, 1), undefined);
});

test('replacing a key does not grow the cache', () => {
    const cache = new RenderCache();
    cache.set('/wiki/a.md', entry('<p>a</p>', 100, 10));
    cache.set('/wiki/a.md', entry('<p>b</p>', 200, 10));

    assert.equal(cache.size, 1);
    assert.equal(cache.get('/wiki/a.md', 200, 10)?.html, '<p>b</p>');
});

test('evicts the oldest entry past the cap', () => {
    const cache = new RenderCache(2);
    cache.set('/wiki/a.md', entry('<p>a</p>', 1, 1));
    cache.set('/wiki/b.md', entry('<p>b</p>', 1, 1));
    cache.set('/wiki/c.md', entry('<p>c</p>', 1, 1));

    assert.equal(cache.size, 2);
    assert.equal(cache.get('/wiki/a.md', 1, 1), undefined);
    assert.notEqual(cache.get('/wiki/b.md', 1, 1), undefined);
    assert.notEqual(cache.get('/wiki/c.md', 1, 1), undefined);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `Cannot find module './cache.js'`.

- [ ] **Step 3: Write the implementation**

`roles/reader/src/cache.ts`:

```typescript
import { createHash } from 'node:crypto';

export interface CacheEntry {
    mtimeMs: number;
    size: number;
    etag: string;
    html: string;
}

export function computeEtag(html: string): string {
    return `"${createHash('sha256').update(html).digest('hex').slice(0, 16)}"`;
}

// Above the 2,034 notes at the wiki root, so in steady state nothing is
// evicted. The cap bounds worst-case memory rather than managing it.
const DEFAULT_MAX = 2500;

export class RenderCache {
    private readonly entries = new Map<string, CacheEntry>();

    constructor(private readonly max: number = DEFAULT_MAX) {}

    get size(): number {
        return this.entries.size;
    }

    // Returns undefined when absent or stale, so callers never compare
    // freshness themselves.
    get(key: string, mtimeMs: number, size: number): CacheEntry | undefined {
        const entry = this.entries.get(key);

        if (entry === undefined) {
            return undefined;
        }
        if (entry.mtimeMs !== mtimeMs || entry.size !== size) {
            return undefined;
        }

        return entry;
    }

    set(key: string, entry: CacheEntry): void {
        this.entries.delete(key);
        this.entries.set(key, entry);

        while (this.entries.size > this.max) {
            const oldest = this.entries.keys().next();
            if (oldest.done === true) {
                break;
            }
            this.entries.delete(oldest.value);
        }
    }
}
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 9 tests in this file.

- [ ] **Step 5: Commit**

```bash
git add roles/reader/src/cache.ts roles/reader/src/cache.test.ts
git commit -m "Add a bounded render cache keyed on mtime and size"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 7: HTTP server with conditional requests

**Files:**
- Create: `roles/reader/src/server.ts`
- Create: `roles/reader/src/index.ts`
- Test: `roles/reader/src/server.test.ts`

**Interfaces:**
- Consumes: `resolveNotePath` (Task 1), `renderNote`/`renderNotFound` (Task 5), `RenderCache`/`computeEtag` (Task 6).
- Produces:
  - `createServer(options: { wikiPath: string; cache?: RenderCache }): http.Server`

Response contract:

| condition | status | headers |
|---|---|---|
| note exists, no matching `If-None-Match` | `200` | `Content-Type`, `Cache-Control: no-cache`, `ETag`, `Last-Modified` |
| note exists, `If-None-Match` matches | `304` | `Cache-Control: no-cache`, `ETag`, `Last-Modified`, empty body |
| id invalid or file missing | `404` | `Content-Type`, `Cache-Control: no-cache` |
| method not `GET` or `HEAD` | `405` | `Allow: GET, HEAD` |

`Cache-Control: no-cache` means "store it, but revalidate every time". That is exactly the required behaviour: an unchanged note costs one `stat` and a `304`; a changed note is visible on the next load. `no-store` would forfeit the 304 and `max-age` would break freshness.

- [ ] **Step 1: Write the failing test**

`roles/reader/src/server.test.ts`:

```typescript
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createServer } from './server.js';

async function withServer(
    files: Record<string, string>,
    run: (base: string, dir: string) => Promise<void>,
): Promise<void> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'reader-'));

    for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(path.join(dir, name), content);
    }

    const server = createServer({ wikiPath: dir });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    try {
        await run(`http://127.0.0.1:${port}`, dir);
    } finally {
        await new Promise<void>(resolve => {
            server.close(() => resolve());
        });
        await fs.rm(dir, { recursive: true, force: true });
    }
}

const INDEX = '---\ntitle: Index\n---\n\n[A note](220306-0621)\n';
const NOTE = '---\ntitle: A note\n---\n\n- [ ] 2027-01-23\n';

test('serves index.md at the root', async () => {
    await withServer({ 'index.md': INDEX, '220306-0621.md': NOTE }, async base => {
        const response = await fetch(`${base}/`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/html; charset=utf-8');
        assert.match(await response.text(), /<h1>Index<\/h1>/);
    });
});

test('serves a note by id', async () => {
    await withServer({ 'index.md': INDEX, '220306-0621.md': NOTE }, async base => {
        const response = await fetch(`${base}/220306-0621`);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /<h1>A note<\/h1>/);
    });
});

test('sends no-cache, an etag and a last-modified header', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`);

        assert.equal(response.headers.get('cache-control'), 'no-cache');
        assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
        assert.notEqual(response.headers.get('last-modified'), null);
    });
});

test('answers a matching if-none-match with an empty 304', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        const second = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });

        assert.equal(second.status, 304);
        assert.equal(second.headers.get('etag'), etag);
        assert.equal(second.headers.get('cache-control'), 'no-cache');
        assert.equal(await second.text(), '');
    });
});

test('handles a weak validator and a list of etags', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        const weak = await fetch(`${base}/`, {
            headers: { 'if-none-match': `W/${etag}` },
        });
        assert.equal(weak.status, 304);

        const list = await fetch(`${base}/`, {
            headers: { 'if-none-match': `"other", ${etag}` },
        });
        assert.equal(list.status, 304);
    });
});

test('serves 200 again once the file changes on disk', async () => {
    await withServer({ 'index.md': INDEX }, async (base, dir) => {
        const first = await fetch(`${base}/`);
        const etag = first.headers.get('etag') ?? '';
        await first.text();

        await fs.writeFile(
            path.join(dir, 'index.md'),
            '---\ntitle: Index\n---\n\nchanged\n',
        );

        const second = await fetch(`${base}/`, { headers: { 'if-none-match': etag } });

        assert.equal(second.status, 200);
        assert.notEqual(second.headers.get('etag'), etag);
        assert.match(await second.text(), /changed/);
    });
});

test('404s a note that does not exist', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/260101-0000`);

        assert.equal(response.status, 404);
        assert.match(await response.text(), /Not found/);
    });
});

test('404s a traversal attempt rather than reading outside the wiki', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/..%2F..%2Fetc%2Fpasswd`);
        await response.text();

        assert.equal(response.status, 404);
    });
});

test('404s a dotted path so .git and .sync stay unreachable', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/.git`);
        await response.text();

        assert.equal(response.status, 404);
    });
});

test('rejects a non-GET method', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`, { method: 'POST' });
        await response.text();

        assert.equal(response.status, 405);
        assert.equal(response.headers.get('allow'), 'GET, HEAD');
    });
});

test('a HEAD request carries the headers but no body', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/`, { method: 'HEAD' });

        assert.equal(response.status, 200);
        assert.match(response.headers.get('etag') ?? '', /^"[0-9a-f]+"$/);
        assert.equal(await response.text(), '');
    });
});

test('ignores a query string when resolving the note', async () => {
    await withServer({ 'index.md': INDEX }, async base => {
        const response = await fetch(`${base}/?v=1`);

        assert.equal(response.status, 200);
        assert.match(await response.text(), /<h1>Index<\/h1>/);
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
yarn test
```

Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 3: Write the implementation**

`roles/reader/src/server.ts`:

```typescript
import http from 'node:http';
import fs from 'node:fs/promises';
import { resolveNotePath } from './ids.js';
import { renderNote, renderNotFound } from './render.js';
import { RenderCache, computeEtag, type CacheEntry } from './cache.js';

export interface ServerOptions {
    wikiPath: string;
    cache?: RenderCache;
}

function etagMatches(header: string | undefined, etag: string): boolean {
    if (header === undefined) {
        return false;
    }

    return header
        .split(',')
        .map(candidate => candidate.trim())
        .map(candidate => (candidate.startsWith('W/') ? candidate.slice(2) : candidate))
        .some(candidate => candidate === etag || candidate === '*');
}

export function createServer(options: ServerOptions): http.Server {
    const cache = options.cache ?? new RenderCache();

    return http.createServer((request, response) => {
        void handle(request, response).catch(() => {
            if (!response.headersSent) {
                response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
            }
            response.end('Internal error');
        });
    });

    async function handle(
        request: http.IncomingMessage,
        response: http.ServerResponse,
    ): Promise<void> {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            response.writeHead(405, { allow: 'GET, HEAD' });
            response.end();
            return;
        }

        const url = new URL(request.url ?? '/', 'http://localhost');
        const pathname = decodeURIComponent(url.pathname);
        const id = pathname === '/' ? 'index' : pathname.slice(1);

        const file = resolveNotePath(options.wikiPath, id);
        if (file === null) {
            notFound(response, id);
            return;
        }

        let stats;
        try {
            stats = await fs.stat(file);
        } catch {
            notFound(response, id);
            return;
        }

        if (!stats.isFile()) {
            notFound(response, id);
            return;
        }

        let entry = cache.get(file, stats.mtimeMs, stats.size);

        if (entry === undefined) {
            const source = await fs.readFile(file, 'utf8');
            const html = renderNote(source, id);
            entry = {
                mtimeMs: stats.mtimeMs,
                size: stats.size,
                etag: computeEtag(html),
                html,
            } satisfies CacheEntry;
            cache.set(file, entry);
        }

        const headers: http.OutgoingHttpHeaders = {
            // Store it, but revalidate every time: an unchanged note costs a
            // stat and a 304, a changed note is visible on the next load.
            'cache-control': 'no-cache',
            etag: entry.etag,
            'last-modified': new Date(stats.mtimeMs).toUTCString(),
        };

        if (etagMatches(request.headers['if-none-match'], entry.etag)) {
            response.writeHead(304, headers);
            response.end();
            return;
        }

        response.writeHead(200, {
            ...headers,
            'content-type': 'text/html; charset=utf-8',
            'content-length': Buffer.byteLength(entry.html),
        });

        if (request.method === 'HEAD') {
            response.end();
            return;
        }

        response.end(entry.html);
    }

    function notFound(response: http.ServerResponse, id: string): void {
        const html = renderNotFound(id);
        response.writeHead(404, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-cache',
            'content-length': Buffer.byteLength(html),
        });
        response.end(html);
    }
}
```

`roles/reader/src/index.ts`:

```typescript
import { createServer } from './server.js';

const wikiPath = process.env.WIKI_PATH ?? '/wiki';
const port = Number(process.env.PORT ?? '8080');

createServer({ wikiPath }).listen(port, () => {
    console.log(`reader listening on ${port}, serving ${wikiPath}`);
});
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
yarn test
```

Expected: PASS, 12 tests in this file, and every earlier test file still green.

- [ ] **Step 5: Verify against the real wiki**

The local replica at `~/synced/Wiki` is a delayed copy of the gluster source of truth. It is fine to *read* for a smoke test — never write to it.

```bash
cd roles/reader
yarn build
WIKI_PATH=$HOME/synced/Wiki PORT=8080 node dist/index.js &
sleep 1
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
curl -s http://127.0.0.1:8080/260726-0000a | grep -c 'cb-item'
ETAG=$(curl -s -D - -o /dev/null http://127.0.0.1:8080/ | grep -i '^etag:' | cut -d' ' -f2 | tr -d '\r')
curl -s -o /dev/null -w '%{http_code}\n' -H "If-None-Match: $ETAG" http://127.0.0.1:8080/
kill %1
```

Expected: `200`, a non-zero count of checkbox items, then `304`.

- [ ] **Step 6: Commit**

```bash
git add roles/reader/src/server.ts roles/reader/src/index.ts roles/reader/src/server.test.ts
git commit -m "Serve wiki notes over http with etag revalidation"
```

Per Global Constraints, leave it staged rather than committing.

---

## Task 8: Docker image and Ansible role

**Files:**
- Create: `roles/reader/Dockerfile`
- Create: `roles/reader/tasks/main.yml`
- Modify: `playbook.yml` (the `deploy` play, alongside the other roles)

**Interfaces:**
- Consumes: the built server from Task 7.
- Produces: a running stack at `https://reader.{{ config.domain }}`.

- [ ] **Step 1: Write the Dockerfile**

`roles/reader/Dockerfile`:

```dockerfile
FROM node:24.14-trixie@sha256:81649592d9833d9220423561fc517b34e932b751873274024c2a969ff4a9bfc2

WORKDIR /home/node/app

COPY package.json yarn.lock ./
RUN yarn install --frozen-lockfile

COPY src ./src
COPY tsconfig.json ./

RUN yarn run build

USER node

CMD ["node", "dist/index.js"]
```

- [ ] **Step 2: Verify the image builds and runs**

```bash
cd roles/reader
docker build -t reader-local .
docker run --rm -d --name reader-local -p 8080:8080 \
    -v "$HOME/synced/Wiki:/wiki:ro" -e WIKI_PATH=/wiki reader-local
sleep 2
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8080/
docker rm -f reader-local
```

Expected: `200`.

- [ ] **Step 3: Write the Ansible role**

`roles/reader/tasks/main.yml`. The traefik labels, scheduler labels, network and interpreter override are copied from `roles/ticker/tasks/main.yml`; the volume mount and placement constraint from `roles/planner/tasks/main.yml`, which already mounts this exact path.

```yaml
---

- name: set dns record
  community.general.cloudflare_dns:
    zone: "{{ config.cloudflare.zone }}"
    record: "reader.{{ config.domain }}"
    type: A
    value: "{{ config.ip }}"
    api_token: "{{ config.cloudflare.api_key }}"
  delegate_to: localhost

- name: build
  community.docker.docker_image_build:
    name: "gitea.{{ config.domain }}/{{ config.gitea.username }}/reader"
    tag: latest
    path: "{{ role_path }}"
    rebuild: always
    platform:
      - linux/amd64
    outputs:
      - type: image
        push: true
  delegate_to: localhost
  register: build_result

- name: deploy stack
  community.general.docker_stack:
    name: reader
    prune: yes
    resolve_image: always
    compose:
      - version: '3.8'
        services:
          reader:
            image: "{{ build_result.image.RepoDigests[0] }}"
            networks:
              - traefik_traefik
            volumes:
              # Read-only: this build never writes to the wiki. A future
              # checkbox toggle would flip this deliberately.
              - /mnt/gluster/resilio-sync/sync/Wiki:/wiki:ro
            environment:
              WIKI_PATH: /wiki
              PORT: '8080'
              TZ: America/Los_Angeles
            deploy:
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=50"
                - "home.scheduler.restart=true"
                - "traefik.enable=true"
                - "traefik.http.routers.reader.rule=Host(`reader.{{ config.domain }}`)"
                - "traefik.http.routers.reader.middlewares=traefik-internal,traefik-forward-auth"
                - "traefik.http.routers.reader.entrypoints=websecure"
                - "traefik.http.routers.reader.tls.certresolver=letsencrypt"
                - "traefik.http.services.reader.loadbalancer.server.port=8080"
              placement:
                constraints:
                  - 'node.labels.home.instance_type == mbp'
              resources:
                limits:
                  cpus: '0.25'
                  memory: 128M
              restart_policy:
                delay: 30s
              update_config:
                order: stop-first
        networks:
          traefik_traefik:
            external: true
  vars:
    ansible_python_interpreter: /opt/docker_venv/bin/python
```

- [ ] **Step 4: Register the role in the playbook**

In `playbook.yml`, inside the `deploy` play's `roles:` list, add the following entry immediately after the `ticker` role entry:

```yaml
    - role: reader
      tags: reader
```

- [ ] **Step 5: Deploy**

From the repo root:

```bash
task deploy --tags reader
```

Expected: the DNS task reports `ok` or `changed`, the build pushes an image, and the stack deploys.

- [ ] **Step 6: Verify the deployment**

```bash
TERM=xterm /usr/bin/ssh pi 'docker service ls --filter name=reader'
curl -s -o /dev/null -w '%{http_code}\n' https://reader.<domain>/
```

Expected: the service shows `1/1`, and the site loads in a browser on the LAN or VPN. Confirm on a phone that a deep note such as `/260726-0000a` renders with rails hanging from beneath each checkbox.

If the service sits at `0/1`, consult `sudo scheduler-status.sh` on `pi` and allow restart backoff to settle before treating it as a failure.

- [ ] **Step 7: Commit**

```bash
git add roles/reader/Dockerfile roles/reader/tasks/main.yml playbook.yml
git commit -m "Deploy the reader role behind traefik"
```

Per Global Constraints, leave it staged rather than committing.

---

## Self-Review

**Spec coverage.** Every spec section maps to a task:

| spec section | task |
|---|---|
| Routes, path safety | 1, 7 |
| Frontmatter | 2 |
| Rendering pipeline steps 1-4 (markdown-it, wikilinks, link normalization) | 3 |
| Rendering pipeline step 5 (checkboxes, `data-line`) | 4 |
| Rendering pipeline step 6 (code fences) | 3 |
| Reading layout, palette, nesting, rails | 5 |
| Caching, ETag, `Cache-Control` | 6, 7 |
| Conditional requests, status codes | 7 |
| Testing | every task |
| Deployment | 8 |
| Future: checkbox toggling | 4 (`data-line`), 8 (`:ro` mount) |

**Type consistency.** `createMarkdown` is introduced in Task 3 with no parameters and widened in Task 4 to `createMarkdown(bodyOffset = 0)`; Task 4's test file exercises both forms and Task 5 passes `parsed.bodyOffset`. `CacheEntry` is defined in Task 6 and imported by name in Task 7. `resolveNotePath` returns `string | null` in Task 1 and Task 7 checks for `null`. `parseFrontmatter` returns `bodyOffset` in Task 2 and Task 5 consumes it.

**Known deferrals**, each an explicit decision recorded in the spec rather than an omission:

- Checkbox mark shapes are placeholders pending a dedicated pass.
- No light-mode variant; jellybeans is dark-only.
- No search, backlinks, or all-notes index.
- No write path.
