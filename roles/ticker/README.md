# Ticker

A single-purpose web app for clearing [Donetick](https://donetick.com/) chores.
It lists what is overdue or due within the next 24 hours and gives each row a
Done button. Live at `https://ticker.<domain>`.

It is deliberately not a second Donetick UI. If you are about to add chore
creation, editing, snoozing, or a second axis of filtering, stop and
reconsider — Donetick already does all of that, and this app exists because
that UI is more than you want in your hand while walking around the house.

## Scope

In scope: list chores overdue or due within the next 24 hours, mark one done,
refresh manually, hide the chores Donetick marks private.

Out of scope, on purpose: undo, creating/editing chores, anything due further
out, auto-refresh or polling, per-user identity, offline support,
notifications.

The 24-hour window is rolling, and it is the whole time filter — no "due soon"
section, no grouping. Priority is the primary sort key and due time only breaks
ties, so a P1 due in twenty hours sits above an unprioritised chore that is
three months late. That is deliberate: the board answers "what should I do
next", not "what is most overdue". Donetick's priority `0` means *unset*, not
*urgent*, so it sorts last.

The one other filter is the **Public** toggle in the header, which drops the
chores Donetick marks `isPrivate`. The board gets read by whoever walks past
it, and that is the whole reason it exists: hand it to someone or hang it in
the hall without the private chores on show. It filters what has already been
fetched, so toggling it costs no round trip, and it never changes what a
completion does. The preference is kept in `localStorage` under
`ticker.public-only` — a wall tablet in a kiosk profile can refuse storage, so
both reads and writes are guarded and the filter simply forgets itself rather
than taking the board down.

The empty list has to say which filter emptied it: "Nothing due" and "Nothing
public due" are different facts, and only the second one is true when a private
chore is sitting hidden behind the toggle.

## How it fits together

```
browser ──https──> traefik ──> ticker (nginx, one container)
                    │            ├─ /        → /usr/share/nginx/html   (Vite build)
                    │            └─ /api/*   → ${DONETICK_URL}/api/*
                    │                          + secretkey: ${DONETICK_API_KEY}
                    └─ middlewares: traefik-internal, traefik-forward-auth
```

The single most important design point: **the Donetick API key never reaches
the browser.** nginx injects it as a `secretkey` request header at proxy time.
Because `/api/*` is served from the app's own origin, there is also no CORS
involved and `roles/donetick` needs no changes at all.

The container talks to Donetick over the shared `traefik_traefik` overlay
network by its Swarm service DNS name (`donetick_donetick:2021`), not back out
through Traefik. That skips TLS termination and the `traefik-internal` IP
allowlist for internal traffic.

Auth is `traefik-forward-auth` (Google OIDC) plus `traefik-internal` (VPN/LAN
IP allowlist). There is no per-user mapping — one shared API key, so every
completion is attributed to that key's Donetick user.

## File map

Abridged — the parts worth knowing before you go looking.

```
roles/ticker/
  Dockerfile                     multi-stage: node build → nginx
  nginx/default.conf.template    envsubst'd at container start
  tasks/main.yml                 DNS → build/push → docker_stack
  public/                        manifest + icons, copied to dist/ by Vite
  src/
    api/donetick.ts              fetch wrappers + error classification
    lib/chores.ts                filterDue / filterPublic / sortChores /
                                 formatDue (pure)
    lib/errors.ts                SessionExpiredError / NetworkError / ApiError
    lib/queue.ts                 serialises completions, one request at a time
    hooks/useChores.ts           chores, per-row state, loading, errors
    hooks/usePublicOnly.ts       the Public toggle, persisted to localStorage
    components/                  ChoreList, ChoreRow, RefreshButton,
                                 PublicFilterButton, ErrorBanner
    App.tsx                      composition only
    styles.css                   plain CSS, custom properties, no framework
```

All filtering, sorting, and date formatting are pure functions that take `now`
as an explicit parameter. No test depends on the wall clock. Keep it that way.

## Local development

`.envrc` (direnv + fnm) pins Node 24 and puts `node_modules/.bin` on PATH.

```bash
yarn install
yarn test          # vitest
yarn test:watch
yarn build         # tsc -b && vite build
yarn dev           # http://localhost:7926
```

The dev server has no Donetick behind it, so the app will show the
"Can't reach the server" banner — which is itself worth seeing. To develop
against real data, add a temporary proxy to `vite.config.ts`:

```ts
server: {
    port: 7926,
    proxy: {
        '/api': {
            target: 'https://donetick.<domain>',
            changeOrigin: true,
            headers: { secretkey: process.env.DONETICK_API_KEY ?? '' },
        },
    },
},
```

Pass the key by environment variable and never commit it. Both
`http://localhost:5173` and `http://localhost:7926` are already in Donetick's
`cors_allow_origins` (see `roles/donetick/tasks/main.yml`), though this proxy
path is server-side and does not need them.

## Traps

**Donetick's routes do not always match its swagger, and `fetch` hides the
difference.** The list route is `/api/v1/chores/` *with* a trailing slash;
without it Donetick answers `301` and a plain `fetch` follows the redirect
silently, so nothing looks wrong from the browser console — but the redirect
loses the auth context and the app reports a bogus "session expired". `POST
/chores/{id}/do` does not redirect. Check any new endpoint against the running
server, not the swagger page, and pin the exact path with a test.

**Every request uses `redirect: 'manual'`.** This is not a style choice.
`traefik-forward-auth` answers an expired session with `307 →
accounts.google.com` for every request, with no XHR-aware branch returning a
clean 401. Under the default `redirect: 'follow'` the browser chases that
cross-origin, Google sends no CORS headers, and `fetch` rejects with a bare
`TypeError` indistinguishable from the server being down — and retrying never
helps. `redirect: 'manual'` turns it into an `opaqueredirect` response we can
identify. Recovery requires `window.location.reload()`, because the OIDC
round-trip needs a top-level navigation.

That gives three failure classes, and they must stay separate — collapsing any
two of them produces an error message that sends you to fix the wrong thing:

| Signal | Meaning | UI |
|---|---|---|
| `response.type === 'opaqueredirect'` | forward-auth session expired | "Session expired" + Reload |
| `fetch` throws `TypeError` | Donetick unreachable / VPN down | "Can't reach server" + Retry |
| non-OK status with JSON body | Donetick API error | Donetick's own message, inline on the row |

**Completions go out one at a time.** Tapping four rows in four seconds is
ordinary use of the board, and Donetick is the only thing that knows whether
each chore is still completable, so the taps queue in `lib/queue.ts` and reach
the wire in the order they were made rather than racing each other. A tap
waiting its turn is indistinguishable from one in flight — the row is already
`pending` either way, which is why the queue needed no new row state. A failed
completion does not stop the ones behind it; the queue survives a rejection and
each tap reports its own outcome. Reads are deliberately not queued, because a
refresh has no reason to sit behind a slow completion.

**That queue is why every request has a deadline.** `REQUEST_TIMEOUT_MS` is 60s,
applied with an `AbortController` rather than `AbortSignal.timeout` so the timer
can be cleared as soon as the request is done with. Without it, one connection
that never answers holds up every tap behind it for as long as the browser is
willing to wait, which is minutes. The clock starts when the request is *sent*,
not when the row is tapped, so a queued tap does not burn its timeout waiting
its turn — `donetick.test.ts` pins that. A timed-out request surfaces as
`NetworkError`: from the row's side, no answer came back. The value is generous
on purpose. It is there to bound a dead connection, not to police how long a
healthy request may take.

**A 502 from this proxy means Donetick hung up, not that it is down.** Its
SQLite lives on GlusterFS and logs `SLOW SQL` at 200ms–1.1s a query, and a
completion makes dozens of them. Donetick's own `write_timeout` is Go's
`http.Server.WriteTimeout`, which does not answer with an error — it closes the
socket mid-handler, so nginx logs `upstream prematurely closed connection while
reading response header` and returns a bare 502 for work the server then goes
on to finish. The row shows an error and the chore is completed anyway. At 10s
this fired regularly; the three deadlines are now nested Donetick 30s < nginx
45s < browser 60s, innermost first, and they must stay in that order. Raising
only the proxy converts the 502 into a 504 and fixes nothing.

**Do not retry a failed completion automatically.** The failure above happens
*after* Donetick has begun the work, so a retry can double-complete a chore.
The Done button is deliberately the only thing that re-sends one.

**Never state what you have not confirmed.** An empty list mid-load is not the
same fact as "nothing is due", and neither is an empty list after a failed
load. Rendering any of them as the others is the bug this app is most prone to.
Per-row state is likewise cleared only *after* replacement data arrives, so a
completed row never un-strikes itself against a stale list. `App.test.tsx`
enforces this; extend those tests rather than working around them.

## What the UI is built on

The per-decision reasoning lives in comments in `styles.css`, next to the code
it explains. These are the rules those decisions come from — worth knowing
before changing any of it.

**Colour carries the whole signal.** Nothing on a row is labelled: not the
priority band, not the Done button. So states have to differ by *hue*, never by
brightness or opacity, and every distinction has to survive both colour
schemes. A pair that separates cleanly in light mode can collapse into one
colour in dark mode. Check both.

**State reaches the whole row, not just the button.** A 3rem glyph at the end
of a row is not readable at arm's length, so pending, done, and error each wash
the row in the same hue as their own button — the row amplifies its control
rather than adding a second signal to decode. Strength is one shared token,
`--wash`, and it is deliberately higher in dark mode (22% against 15%): the mix
that reads clearly over warm paper all but vanishes over a near-black board,
because there is so little light in the ground for it to shift. Three surfaces
carry the hue, each further up than the last: the ground at `--wash`, the bottom
rule at `--wash-rule`, the text at `--tint`. A run of rows in one state fuses
into a block rather than reading as separate stripes, and the type sits on the
ground instead of on top of it. Each state names its hue once as `--hue` and the
three surfaces are written against that, so a new state is a hue, not another
block of rules.

**A toggle that is on fills in.** `.control` is one button style for the whole
header, and the only state it adds is `[aria-pressed='true']` — the same
inversion hover already uses, made permanent. Outline reads as *available*,
solid as *in force*, and that distinction is load-bearing here: a filtered list
looks exactly like a short one, so the button is the only thing on screen
saying that chores are being held back. It fills with `--ink` rather than a
colour of its own, because every hue on this board already means a row state.

**The row never changes size, and nothing on it uses opacity.** A thumb may be
resting on it, and the list must not reflow under a finger mid-tap. In-flight is
shown by recolouring in place, not by fading — a dimmed control reads as
*unavailable*, the opposite of "working on it". Where something must recede — the
name on a completed row — it recedes by *colour*: muted ink plus the state hue,
never `opacity`. This is not stylistic. Fading text toward its own background is
the fastest way to lose contrast without noticing, and the done row is where it
bites hardest: at `opacity: 0.55` the name measured 3.2:1 against its own wash,
making the row you had just cleared the least readable one on the board.

**Check contrast against the wash, not against paper.** `--ink-soft` clears 5:1
on bare paper and fails on every washed row — the wash raises the ground under it
by about a point. That is what `--ink-muted` is for: secondary text on a washed
row, pulled halfway back to `--ink` to buy the margin back. Any new state colour
has to be measured over its own wash in *both* schemes; the floor is 4.5:1, and
everything currently on the board sits between 5.15:1 and 9.32:1. The name has
the most headroom and can afford the most hue, which is why `--tint` can be as
high as 35% without costing anything that matters.

**Meaning that is only visual is missing meaning.** An icon-only button needs
the chore name in `aria-label` — a screen reader hitting four identical "Done"
buttons has nothing to go on — and a state shown by swapping a glyph needs
`aria-busy` alongside it.

**The mark has to survive being tiny.** The app icon is flat — one tick, one
ground, no gradient and no shadow. Earlier drafts drew a split-flap tile
mid-turn, and every one of them lost the tick below about 40px, which is the
only size that decides whether the icon is any use. Same rule as the rest of
the board: it is read at a glance or it is not read.

## Installing it as an app

`public/manifest.json` makes the board installable to a home screen, so a phone
or a wall tablet opens it without browser chrome in the way.

**No service worker.** Offline support is out of scope, and installability has
not needed one for years — manifest, icons, HTTPS. This adds no JavaScript and
no runtime dependency; keep it that way.

**The icon ships twice.** Android may mask an adaptive icon to any shape inside
a circle of 80% of the canvas, and at full size the tick reaches 203px from
centre against a 204.8px safe radius — legal by under two pixels, which is not
a margin. `icon-maskable.svg` is the same mark at 0.82. Ship only the uncropped
one and Android pillarboxes it onto a white square.

**Safari reads almost none of the manifest.** It ignores the manifest's icons
for the home screen, and older versions ignore `display: standalone`, so the
`apple-*` tags in `index.html` duplicate it on purpose. The status bar is
`black-translucent`, which runs the page under the clock — survivable only
because `viewport-fit=cover` and `.header`'s `env(safe-area-inset-top)` were
already there, inert in a browser tab and load-bearing once installed.

**A session expiry drops you into the browser.** `scope` is `/`, so
forward-auth's `307 → accounts.google.com` leads out of scope and the OS hands
the OIDC round-trip to the real browser, where you then stay. Reopening the
installed app works. `display: minimal-ui` is the fallback if that stops being
rare enough to live with.

The PNGs are committed rather than built, so the image needs no rasteriser.
Regenerate them after any change to the mark, then let `src/manifest.test.ts`
confirm each one is present at the size the manifest claims:

```bash
cd public
rsvg-convert -w 192 -h 192 icon.svg          -o icon-192.png
rsvg-convert -w 512 -h 512 icon.svg          -o icon-512.png
rsvg-convert -w 180 -h 180 icon.svg          -o apple-touch-icon.png
rsvg-convert -w 512 -h 512 icon-maskable.svg -o icon-maskable-512.png
```

## Deployment

```bash
task deploy --tags ticker
```

That sets the Cloudflare DNS record, builds and pushes a multi-arch image to
the Gitea registry, and deploys the Swarm stack by digest.

The container takes three environment variables, all set in `tasks/main.yml`:

| Variable | Value |
|---|---|
| `DONETICK_API_KEY` | from sops (`config.ticker.donetick_api_key`) |
| `DONETICK_URL` | `http://donetick_donetick:2021` — Swarm service DNS |
| `TZ` | `America/Los_Angeles`, so due times read as local |

nginx's stock entrypoint runs `envsubst` over `/etc/nginx/templates/*.template`
at startup, which is what puts them into the config — no custom entrypoint, no
Docker secret. Rotating the key is a sops edit plus a redeploy; no image
rebuild, because the key is not in the bundle.

`update_config.order` is `stop-first` with one replica, so each deploy has a
few seconds where Traefik has no backend for the host and returns its
plain-text `404 page not found`. That is expected, not a broken deploy.

## Verifying a deployment

```bash
# Service is up
ssh pi 'sudo docker service ps ticker_ticker'

# Auth is actually attached — MUST be 307, not 200.
# A 200 means the middleware label is wrong and the app is open to the VPN.
curl -s -o /dev/null -w '%{http_code}\n' https://ticker.<domain>/

# The key is reaching Donetick (run on the node hosting the container)
ssh tart 'C=$(sudo docker ps --filter name=ticker_ticker -q | head -1);
          sudo docker exec "$C" curl -s -D - -o /dev/null http://127.0.0.1/api/v1/chores/'

# nginx access log — a 301 here means the trailing slash regressed
ssh pi 'sudo docker service logs ticker_ticker --tail 30'
```

The nginx container ships with `curl`, which makes in-cluster debugging much
easier than it sounds.

## Testing

Vitest + React Testing Library, `fetch` stubbed. Written test-first, and worth
keeping that way — the trailing-slash trap and every loading-state confusion
above was pinned by a failing test before the fix.

Three tests are guardrails rather than feature coverage, so do not "clean them
up":

- `useChores > does not fetch on its own after mounting` fails loudly if
  anyone adds a focus listener or an interval. Refresh is manual only.
- `donetick > requests the chores endpoint with a trailing slash` is the
  regression test for the 301 described above.
- `web app manifest > ships every icon it references, at the size it claims`
  reads the PNG headers off disk. Nothing else in the suite touches static
  files, so without it an icon can go missing and every test still passes.

## Reference

- Design: `docs/superpowers/specs/2026-08-15-ticker-design.md`
- Plan: `docs/superpowers/plans/2026-08-15-ticker.md`
- Donetick swagger: `https://donetick.<domain>/swagger/index.html`
