# Ticker — Design

**Date:** 2026-08-15
**Branch:** `add-ticker-role`
**Status:** Approved (pending user re-review of written spec)

## Goal

A small, fast web app for clearing overdue Donetick chores. It shows the chores that are past due and gives each one a Done button; pressing it calls the Donetick API and, on success, crosses the row off in place. Reachable at `ticker.{config.domain}`, deployed to the home Swarm cluster as its own Ansible role.

The point is speed of use: open it, see what's late, tap through the list. It is deliberately not a second Donetick UI.

## Scope

In scope:

- New Ansible role `roles/ticker` containing a React + Vite + TypeScript app and its `Dockerfile`, following the `planner` (build-and-push a local Dockerfile) and `impression` (nginx + config template) patterns.
- nginx serves the built SPA and reverse-proxies `/api/*` to Donetick, injecting the API key server-side.
- Two Donetick endpoints only: `GET /api/v1/chores` and `POST /api/v1/chores/{id}/do`.
- Cloudflare DNS record, Traefik ingress behind `traefik-internal` + `traefik-forward-auth`.
- Responsive layout tuned for phone, wall tablet, and desktop.
- Vitest + Testing Library test suite, written test-first.
- Wire into `playbook.yml` under the `deploy` play; homepage entry; README entry.

Out of scope (YAGNI — easy to add later):

- Undo of a completion (`POST /chores/{id}/undo`). Explicitly deferred.
- Creating, editing, snoozing, skipping, or rescheduling chores.
- Anything due today-or-later; only strictly past-due items appear.
- Auto-refresh, polling, and Donetick's SSE realtime stream. Refresh is manual only.
- Per-user identity. A single shared API key is used; forward-auth is the gate, and `X-Forwarded-User` is not read.
- Offline support, service worker, installability.
- Notifications.

## Architecture

Single Docker Swarm stack named `ticker` with one service, joined to the existing external `traefik_traefik` network.

```
browser ──https──> traefik ──> ticker (nginx)
                    │            ├─ /        → /usr/share/nginx/html  (Vite build)
                    │            └─ /api/*   → http://donetick_donetick:2021/api/*
                    │                          + secretkey: <injected>
                    └─ middlewares: traefik-internal, traefik-forward-auth
```

Because nginx proxies Donetick under the app's own origin, there is **no CORS involved and no change to `roles/donetick`**. The `secretkey` header is added by nginx, so the API key never reaches the browser.

The container reaches Donetick by Swarm service DNS on the shared `traefik_traefik` overlay network rather than looping back out through Traefik. This avoids the public hostname, TLS termination, and the `traefik-internal` IP allowlist entirely for internal traffic.

## Docker image

Multi-stage build, `Dockerfile` at the role root (built by `community.docker.docker_image_build`, `delegate_to: localhost`, pushed to `gitea.{domain}/{username}/ticker`, deployed by digest via `build_result.image.RepoDigests[0]` — exactly the `planner` idiom):

```
FROM node:24.x  AS build
  WORKDIR /app
  COPY package.json yarn.lock ./
  RUN yarn install --frozen-lockfile
  COPY . .
  RUN yarn build              # -> /app/dist

FROM nginx:1.29.x
  COPY --from=build /app/dist /usr/share/nginx/html
  COPY nginx/default.conf.template /etc/nginx/templates/
```

Both base images pinned by sha256, matching the convention in `planner` and `impression`.

## Key injection

The Donetick API key is stored in the sops-encrypted env submodule as `config.ticker.donetick_api_key` (already added by the user) and passed to the container as a plain environment variable:

```yaml
environment:
  DONETICK_API_KEY: "{{ config.ticker.donetick_api_key }}"
  DONETICK_URL: http://donetick_donetick:2021
```

nginx's stock entrypoint runs `envsubst` over `/etc/nginx/templates/*.template` at startup, so the value lands in the generated config with no custom entrypoint script and no Docker secret. This matches how `planner` passes `DBOS_SYSTEM_DATABASE_URL`.

Rotating the key is a sops edit plus `task deploy --tags ticker` — no image rebuild, because the key is not baked into the bundle.

## nginx configuration

```
server {
    listen 80 default_server;

    location /api/ {
        proxy_set_header secretkey ${DONETICK_API_KEY};
        proxy_set_header Host $host;
        proxy_pass ${DONETICK_URL}/api/;
    }

    location / {
        root /usr/share/nginx/html;
        try_files $uri /index.html;
    }
}
```

`try_files … /index.html` is present for robustness; the app is a single view and does not use client-side routing.

## Ingress

- **DNS:** Cloudflare A record `ticker.{config.domain}` → `{config.ip}`, via `community.general.cloudflare_dns`, `delegate_to: localhost`.
- **Traefik labels:** mirror the other app roles, with

  ```
  traefik.http.routers.ticker.middlewares=traefik-internal,traefik-forward-auth
  traefik.http.services.ticker.loadbalancer.server.port=80
  ```

Both middlewares apply, so the page and its `/api/*` calls are gated identically. Because the API calls are same-origin, the forward-auth cookie is sent automatically.

## Authentication and session expiry

`traefik-forward-auth` is the only user-facing auth. There is no per-user mapping: every completion is attributed to the single API key's Donetick user.

Verified behavior against the running Traefik: an unauthenticated request returns `307` with `location: https://accounts.google.com/o/oauth2/auth?…`, regardless of `Accept: application/json` or `X-Requested-With`. There is no XHR-aware branch returning a clean 401.

With fetch's default `redirect: "follow"`, the browser would chase that redirect to Google, which sends no `Access-Control-Allow-Origin`, producing a bare `TypeError: Failed to fetch` — indistinguishable from Donetick being down, and unfixable by retrying.

Therefore every request uses `redirect: 'manual'`, and the response is classified:

| Signal | Meaning | UI |
|---|---|---|
| `response.type === 'opaqueredirect'` (`status === 0`) | forward-auth session expired | "Session expired" banner + Reload button |
| `fetch` throws `TypeError` | Donetick unreachable / VPN down | "Can't reach server" + Retry |
| non-OK status with JSON body | Donetick API error | surface Donetick's own message |

Nothing under `/api/*` legitimately returns a 3xx — Donetick answers with JSON for success, error, and auth failure alike — so an opaque redirect unambiguously means forward-auth intercepted the call.

Recovery is `window.location.reload()`, not a background retry: the Google OIDC round-trip requires a top-level navigation. This case matters most on the wall tablet, where a page can sit open long enough for the cookie to lapse.

## Donetick API contract

Confirmed against the live instance's swagger (`v0.1.76`, basePath `/api/v1`):

- `GET /chores` → `200 {"res": Chore[]}`. Relevant `model.Chore` fields: `id`, `name`, `nextDueDate` (string), `isActive`, `priority` (int), `status`, `frequencyType`, `assignedTo`, `labelsV2`.
- `POST /chores/{id}/do` with an empty JSON body → `200 {"res": Chore}` (the chore with its next due date). Documented failures: `400` (invalid id/date, not assigned, outside completion window), `401`, `403`, `500`.
- Auth accepts `secretkey: <api key>` as a header (`APIKeyAuth` in the swagger security definitions).

The `400 … Chore is out of completion window` case is real and per-row: a chore with a `completionWindow` can refuse completion. It surfaces as that row's error, not a global one.

## Application structure

```
roles/ticker/
  src/
    api/donetick.ts       fetch wrappers, redirect:'manual', error classification
    lib/chores.ts         filterOverdue(), sortChores(), formatOverdue()  — pure
    lib/errors.ts         SessionExpiredError, NetworkError, ApiError
    hooks/useChores.ts    { chores, status, loading, error, refresh, complete }
    components/
      ChoreList.tsx
      ChoreRow.tsx
      RefreshButton.tsx
      ErrorBanner.tsx
    App.tsx
    main.tsx
    styles.css
```

All filtering, sorting, and date formatting live in pure functions in `lib/chores.ts` that take `now` as a parameter, so tests never depend on the wall clock.

## Behavior

**Overdue rule.** A chore is listed when `isActive && nextDueDate && new Date(nextDueDate) < now`. Archived chores are excluded (the default `GET /chores` response, with `includeArchived` unset). Nothing due later today appears.

**Ordering.** By `priority`, then most-overdue-first within each priority group. Donetick uses `1` = high through `4` = lowest, with `0` meaning unset; unset sorts **last**, not first. (Verify against real data during implementation.)

**Completion.** Not optimistic. Pressing Done moves that row to `pending` and disables its button; the row crosses off only after the `200`. Per-row state is a `Record<number, 'idle' | 'pending' | 'done' | 'error'>` held alongside the chore array.

**After completion.** The row stays in place, struck through and dimmed. It does not disappear, fade, or move to another section. Nothing re-sorts, so the next row never shifts under a finger mid-tap.

**Refresh.** Manual only, via a button at the top. No polling, no refetch on focus, no SSE. Refresh refetches and clears the per-row state map. A completed recurring chore drops off naturally, since it now has a future due date.

**Empty state.** When nothing is overdue, the list is replaced by a short confirmation ("Nothing overdue") plus the Refresh control, so the screen still reads as working rather than broken — this is the steady state on the wall tablet.

**Errors.** A failed completion sets that row to `error`, shows Donetick's message inline, and leaves the button enabled to retry. Session-expired and unreachable-server errors are global and render as a banner above the list.

## Layout

One responsive column, no separate device modes, tuned at each breakpoint:

- **Phone.** Full-bleed rows; Done right-aligned within the thumb arc; minimum 44px touch targets; `env(safe-area-inset-bottom)` so the last row clears the home indicator; Refresh top-right.
- **Wall tablet.** Type scaled with `clamp()` to read from across the room; high contrast; no hover-dependent affordances. Since refresh is manual-only, the Refresh control is prominent rather than a subtle icon.
- **Desktop.** Centered max-width column so rows do not stretch across a wide display; denser vertical rhythm; visible focus rings; Space/Enter activation.

Plain CSS with custom properties and a `prefers-color-scheme` dark variant. No CSS framework, keeping the bundle small for the tablet.

## Testing

Vitest + React Testing Library, with `fetch` stubbed. Written test-first.

Pure-function tests (table-driven):
- `filterOverdue` excludes future due dates, null due dates, and inactive chores.
- `sortChores` orders by priority then lateness, and sorts priority `0` last.
- `formatOverdue` renders hours/days/months consistently.

Component tests:
- Clicking Done issues `POST /api/v1/chores/{id}/do` and the row is struck through after success.
- A pending completion disables only that row's button.
- A `500` leaves the row actionable and shows the API's message.
- An opaque redirect raises the session-expired banner rather than the network error.
- Refresh refetches and clears completed-row state.

## Playbook wiring

```yaml
    - role: ticker
      tags: ticker
```

Added to the `deploy` play in `playbook.yml`, after `donetick`. Deployment is `task deploy --tags ticker`.

## Resource limits (starting point)

| service | cpu  | memory |
|---------|------|--------|
| ticker  | 0.15 | 20M    |

Matches `impression`, which is likewise a single nginx serving/proxying. No placement constraint is needed: the container is stateless and reaches Donetick over the overlay network.

## Other wiring

- `roles/homepage/files/public/index.html`: add a Ticker entry alongside the others, using the `<!--#echo var="domain"-->` idiom.
- `README.md`: add Ticker to the service list.
- Datadog HTTP check: added by the user in the sops env submodule.

## Open questions / verify during implementation

1. **Donetick service DNS name.** Expected to be `donetick_donetick` (stack `donetick`, service `donetick`) on the `traefik_traefik` overlay network. Confirm against the running swarm before committing the value.
2. **Priority semantics.** Confirm from live `GET /chores` data that `0` means unset and `1` is highest, so the sort places unset chores last.
3. **`nextDueDate` null-ability.** One-off chores may have no due date; confirm the field is nullable in practice and that the filter handles it.
4. **Base image digests.** Pin current `node:24.x` and `nginx:1.29.x` by sha256 at implementation time.
