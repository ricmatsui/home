# Vikunja Role — Design

**Date:** 2026-06-07
**Branch:** `add-vikunja-role`
**Status:** Approved (pending user re-review of written spec)

## Goal

Self-host [Vikunja](https://vikunja.io/) (task / project management) on the home Swarm cluster alongside the other apps. Reachable at `vikunja.{config.domain}`, fronted by Traefik, with Google OIDC as the only auth method and a dedicated Postgres backend that's backed up nightly to S3.

## Scope

In scope:

- New Ansible role `roles/vikunja` following the `temporal` / `dbos` pattern (app + dedicated `postgres:16.8` + `prodrigestivill/postgres-backup-local` sidecar).
- Cloudflare DNS record, Traefik HTTP ingress, mirrored images via `tasks/docker_mirror_image.yml`.
- Google OIDC as the sole login method (parallels `roles/actual`). Native Vikunja registration disabled.
- Daily Postgres dumps + monthly S3 archive; nightly rclone copy of the attachments volume to S3.
- Sops entries for postgres password, service secret, OIDC client id/secret.
- Wire into `playbook.yml` under the `deploy` play.

Out of scope (YAGNI — easy to add later if needed):

- Typesense search backend.
- SMTP / Pushover / Telegram notifiers.
- CalDAV integration with external calendar clients.
- Migrating from any prior task tool (assume fresh install).

## Architecture

Single Docker Swarm stack named `vikunja` with three services on an internal `vikunja` overlay network. The `vikunja` web service additionally joins the existing external `traefik_traefik` network for ingress.

```
vikunja            vikunja/vikunja:<pinned>             port 3456
  └─ depends on → vikunja-db (postgres)

vikunja-db         postgres:16.8                        port 5432 (internal only)
  └─ volume: /mnt/gluster/vikunja/db → /var/lib/postgresql/data

vikunja-db-backup  prodrigestivill/postgres-backup-local:16
  └─ volume: /mnt/gluster/vikunja/backups → /backups
```

Placement: all three services constrained to `node.labels.home.instance_type == mbp` (matches `temporal`, `dbos`, `actual`, `donetick`, `planner`). Scheduler priorities: `30` for `vikunja-db` and `vikunja-db-backup` (DB-tier, like temporal/dbos), `50` for the `vikunja` web service (app-tier, like actual/donetick). `home.scheduler.restart=true` only on the web service.

Images mirrored through `gitea.{domain}/{username}/...` via `include_tasks: tasks/docker_mirror_image.yml`, pinned by sha256 (same as actual/temporal/dbos).

## Storage layout

```
/mnt/gluster/vikunja/db       (uid 999, group pi)  — postgres data dir
/mnt/gluster/vikunja/files    (uid 1000, gid 1000) — task attachments, project backgrounds
/mnt/gluster/vikunja/backups  (uid 999, group pi)  — pg_dump output from sidecar
```

The two ownership schemes mirror what each container expects: Postgres runs as uid 999 inside the official image; Vikunja runs as uid 1000.

## Ingress

- **DNS:** Cloudflare A record `vikunja.{config.domain}` → `{config.ip}` (uses `community.general.cloudflare_dns`, same idiom as every other role).
- **Traefik:** HTTP router named `vikunja` with:
  - `Host(`vikunja.{domain}`)`
  - middleware `traefik-internal`
  - entrypoint `websecure`, `tls.certresolver=letsencrypt`
  - service backend port `3456`

## Authentication

Google OIDC, configured natively in Vikunja (no external forward-auth). Native username/password registration disabled.

```yaml
VIKUNJA_AUTH_LOCAL_ENABLED: "false"
VIKUNJA_AUTH_OPENID_ENABLED: "true"
VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_AUTHURL: https://accounts.google.com
VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_CLIENTID:     "{{ config.vikunja.google_client_id }}"
VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_CLIENTSECRET: "{{ config.vikunja.google_client_secret }}"
```

Prerequisite (manual, outside Ansible): create a new OAuth 2.0 client in Google Cloud (separate from the one `actual` uses, so revoking one doesn't impact the other) with authorized redirect URI:

```
https://vikunja.{domain}/auth/openid/google
```

The exact env var names follow Vikunja's `_` → `.` mapping for nested keys (`auth.openidConnect.providers[google].clientId` → `VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_CLIENTID`). To be validated against current Vikunja docs when implementing — the provider-list shape has changed across versions and may require a YAML config file instead of pure env vars. **Implementation step must verify before deploying** (see Open Questions).

## Service environment (vikunja)

```yaml
VIKUNJA_DATABASE_TYPE: postgres
VIKUNJA_DATABASE_HOST: vikunja_vikunja-db
VIKUNJA_DATABASE_USER: vikunja
VIKUNJA_DATABASE_PASSWORD: "{{ config.vikunja.postgres_password }}"
VIKUNJA_DATABASE_DATABASE: vikunja
VIKUNJA_SERVICE_PUBLICURL: "https://vikunja.{{ config.domain }}"
VIKUNJA_SERVICE_SECRET: "{{ config.vikunja.service_secret }}"
VIKUNJA_SERVICE_TIMEZONE: America/Los_Angeles
VIKUNJA_SERVICE_ENABLEREGISTRATION: "false"
# plus the AUTH_* block above
```

`VIKUNJA_SERVICE_SECRET` is the canonical name (the older `VIKUNJA_SERVICE_JWTSECRET` is deprecated but still copied into `service.secret` on startup).

Volume mounts on the `vikunja` web service:

```yaml
- /mnt/gluster/vikunja/files:/app/vikunja/files
```

## Service environment (vikunja-db)

```yaml
POSTGRES_USER: vikunja
POSTGRES_PASSWORD: "{{ config.vikunja.postgres_password }}"
```

Volume: `/mnt/gluster/vikunja/db:/var/lib/postgresql/data`.

## Service environment (vikunja-db-backup)

```yaml
POSTGRES_HOST: vikunja_vikunja-db
POSTGRES_DB: vikunja
POSTGRES_USER: vikunja
POSTGRES_PASSWORD: "{{ config.vikunja.postgres_password }}"
```

Volume: `/mnt/gluster/vikunja/backups:/backups`. Default schedule from the upstream image (daily / weekly / monthly retention) matches what temporal and dbos use — no overrides.

## Backups (rclone script)

`/mnt/gluster/rclone/scripts/vikunja.sh` — single script with two `rclone copy` calls:

```bash
#!/bin/bash
. /mnt/gluster/rclone/functions

# Postgres monthly dumps to S3 (mirrors temporal/dbos)
rclone copy --immutable /mnt/gluster/vikunja/backups/monthly \
  :s3:/$ARCHIVE_PATH/vikunja/backups/monthly \
  --exclude "vikunja-latest.sql.gz" \
  --min-age 1d

# Attachments to S3 (no service stop needed — uploads are write-once)
rclone copy --immutable /mnt/gluster/vikunja/files \
  :s3:/$ARCHIVE_PATH/vikunja/files
```

Rationale for not stopping the service when archiving `/files` (unlike `actual`'s squashfs flow):

- Official Vikunja guidance ([What to backup](https://vikunja.io/docs/what-to-backup)) says: *"To back up attachments and other files, it is enough to copy them from the attachments folder to some other place."* No service-stop is mentioned.
- The implementation in [`pkg/files/files.go`](https://github.com/go-vikunja/vikunja/blob/main/pkg/files/files.go) names each on-disk file by its database auto-increment ID (`File.fileID()` returns `strconv.FormatInt(f.ID, 10)`). IDs are monotonically increasing and never reused, so a given path's contents never change after it's written. Deletion (`File.Delete`) calls `storage.Remove(f.fileID())`, which removes the path entirely rather than rewriting it in place.

That means `rclone copy --immutable` is safe — `--immutable` only fires on content changes to an existing path, which can't happen. Source-side deletions are tolerated (rclone copy doesn't propagate deletes), so deleted attachments stay archived in S3 — the desired backup behavior.

## Secrets (sops)

Add a new `vikunja:` block to `env/inventory/group_vars/all.sops.yml`:

```yaml
vikunja:
    postgres_password: <generated, ≥32 char>
    service_secret:    <generated, ≥32 char>
    google_client_id:     <from new Google Cloud OAuth client>
    google_client_secret: <from new Google Cloud OAuth client>
```

## Playbook wiring

Append to the `deploy` play in `playbook.yml`, grouped with the other DB-backed apps:

```yaml
    - role: vikunja
      tags: vikunja
```

Deployment is then `task deploy --tags vikunja`.

## File layout

```
roles/vikunja/
  tasks/
    main.yml      # DNS → dirs → image mirror → docker_stack → backup script
```

No Dockerfile, no patches — using the upstream `vikunja/vikunja` image unmodified.

## Resource limits (starting points)

| service          | cpu  | memory |
|------------------|------|--------|
| vikunja          | 1.00 | 300M   |
| vikunja-db       | 1.00 | 200M   |
| vikunja-db-backup| 1.00 | 100M   |

Mirrors temporal's DB/backup sizing. Web service memory will be revisited if it OOMs.

## First-boot behavior

Vikunja runs migrations against the empty database automatically on first startup. With local auth disabled, the first login is via Google OIDC — that login creates the first user record. No manual seeding needed.

## Open questions / verify during implementation

1. **OIDC env-var shape.** Vikunja's openid `providers` is a YAML list of objects, and not all versions support flattening it to env vars. If env-var-only doesn't work on the pinned version, fall back to a config file (like `donetick`'s `selfhosted.yaml`) at `/mnt/gluster/vikunja/config/config.yml`.
2. **Pinned image version.** Pick the current stable `vikunja/vikunja` tag at implementation time and pin by sha256.
3. **Backup sidecar image digest.** Reuse the same `prodrigestivill/postgres-backup-local:16` sha256 already mirrored for temporal/dbos.
