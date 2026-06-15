# Vikunja Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a new `vikunja` Ansible role following the `temporal`/`dbos` pattern (app + dedicated Postgres + backup sidecar) with Google OIDC auth, fronted by Traefik at `vikunja.{config.domain}`.

**Architecture:** Single Docker Swarm stack with three services on an internal `vikunja` overlay network. The `vikunja` web container additionally joins the external `traefik_traefik` network. Postgres data on Gluster at `/mnt/gluster/vikunja/db`; attachments on Gluster at `/mnt/gluster/vikunja/files`; nightly Postgres dumps + monthly S3 archive via `prodrigestivill/postgres-backup-local` + the standard `rclone` script pattern.

**Tech Stack:** Ansible (`community.general.docker_stack`, `community.general.cloudflare_dns`, `community.docker.*`), sops/PGP for secrets, `task` runner (npm `tasksfile`), Docker Swarm, Postgres 16, Traefik, rclone.

**Spec:** [`docs/superpowers/specs/2026-06-07-vikunja-role-design.md`](../specs/2026-06-07-vikunja-role-design.md)

---

## Notes for the implementer

This is infrastructure code — there are no unit tests. The acceptance test is `task deploy --tags vikunja` succeeding and the resulting site working end-to-end. Each major chunk gets its own commit so that if a later step needs to be reverted, the earlier scaffolding stays.

**Working directory throughout:** `/Users/ricardo/synced/Projects/home`. Current branch should be `add-vikunja-role` (created from `master`).

**Sops/PGP:** The repo encrypts secrets with PGP via `community.sops.sops` (see `ansible.cfg`, `.sops.yaml`). To edit, use the `sops` CLI — it decrypts to a temp file, opens `$EDITOR`, then re-encrypts on save. Do not write encrypted blobs by hand.

**Deploy command:** `task deploy --tags vikunja` (alias for `poetry run ansible-playbook playbook.yml --tags vikunja`; see `tasksfile.js:9`). All other `task deploy` flags pass through.

**Re-using the postgres-backup-local image digest:** `roles/temporal/tasks/main.yml:67` and `roles/dbos/tasks/main.yml:38` already mirror `prodrigestivill/postgres-backup-local:16` at sha256 `a0103fbce0c48ccc7693ddbb2a2bfa733048db845354f635efef9e4566de185d`. Re-use that exact digest in the vikunja role for consistency.

**Re-using the postgres image digest:** `postgres:16.8` at sha256 `5779f428edb411216d6960f2721974d7e71e124e3c41a3e625e47a9072949ed6` is already mirrored by both temporal and dbos. Re-use it.

---

### Task 1: Pre-deployment prerequisites (manual)

**Files:** none yet — this task just gathers values needed in later tasks.

- [ ] **Step 1: Pick a Vikunja image tag and resolve its sha256 digest**

Pick the latest stable from <https://hub.docker.com/r/vikunja/vikunja/tags> (avoid `unstable` / `-rc` tags). Then resolve the digest:

```bash
docker buildx imagetools inspect vikunja/vikunja:<chosen-tag>
```

Expected: lines like `Name: docker.io/vikunja/vikunja:<tag>@sha256:...`. Record the **multi-platform manifest list digest** (the top-level `Digest:` line) — that's what `docker_mirror_image.yml` pins on. Save it as `VIKUNJA_IMAGE_DIGEST` for use in Task 3.

- [ ] **Step 2: Create a new Google Cloud OAuth 2.0 client**

In Google Cloud Console → APIs & Services → Credentials → "Create credentials" → "OAuth client ID" → "Web application". Name it `vikunja-home`. Authorized redirect URI:

```
https://vikunja.<your-domain>/auth/openid/google
```

(Substitute `<your-domain>` with the actual `config.domain` value. Do **not** reuse the `actual` OAuth client — separate clients let you revoke one without affecting the other.)

Save the resulting client id and client secret for Task 2.

- [ ] **Step 3: Generate Postgres password and service secret**

```bash
openssl rand -base64 32  # postgres_password
openssl rand -base64 48  # service_secret  (Vikunja signs JWTs with this — make it long)
```

Save both values for Task 2.

- [ ] **Step 4: Stage nothing, commit nothing**

This task produces no files. Move on to Task 2 with the four values: image digest, OAuth client id, OAuth client secret, postgres password, service secret.

---

### Task 2: Add vikunja secrets to sops

**Files:**
- Modify: `env/inventory/group_vars/all.sops.yml` (add a top-level `vikunja:` block under `config:`)

- [ ] **Step 1: Open the encrypted file with sops**

```bash
cd /Users/ricardo/synced/Projects/home
sops env/inventory/group_vars/all.sops.yml
```

This decrypts in-place into your editor.

- [ ] **Step 2: Add the vikunja block**

Insert under the existing `config:` block, alphabetically near `vaultwarden` (i.e. somewhere near the bottom — the existing file is roughly alphabetized within `config:`):

```yaml
    vikunja:
        postgres_password: <paste from Task 1 Step 3>
        service_secret: <paste from Task 1 Step 3>
        google_client_id: <paste from Task 1 Step 2>
        google_client_secret: <paste from Task 1 Step 2>
```

Save and exit. sops re-encrypts on save.

- [ ] **Step 3: Verify decryption round-trips**

```bash
sops --decrypt env/inventory/group_vars/all.sops.yml | grep -A 5 '^    vikunja:'
```

Expected: the four keys you just added, with cleartext values.

- [ ] **Step 4: Commit**

```bash
git add env/inventory/group_vars/all.sops.yml
git commit -m "Add vikunja secrets to sops"
```

---

### Task 3: Create the vikunja role

**Files:**
- Create: `roles/vikunja/tasks/main.yml`

- [ ] **Step 1: Create the role directory**

```bash
mkdir -p /Users/ricardo/synced/Projects/home/roles/vikunja/tasks
```

- [ ] **Step 2: Write `roles/vikunja/tasks/main.yml`**

Substitute `<VIKUNJA_IMAGE_DIGEST>` with the sha256 from Task 1 Step 1.

```yaml
---

- name: set dns record
  community.general.cloudflare_dns:
    zone: "{{ config.cloudflare.zone }}"
    record: "vikunja.{{ config.domain }}"
    type: A
    value: "{{ config.ip }}"
    api_token: "{{ config.cloudflare.api_key }}"
  delegate_to: localhost

- name: create db and backup directories
  ansible.builtin.file:
    path: "/mnt/gluster/vikunja/{{ item }}"
    owner: 999
    group: pi
    state: directory
  loop:
    - db
    - backups

- name: create files directory
  ansible.builtin.file:
    path: /mnt/gluster/vikunja/files
    owner: 1000
    group: 1000
    state: directory

- name: mirror image
  include_tasks: tasks/docker_mirror_image.yml
  vars:
    fact: "{{ item.fact }}"
    name: "{{ item.name }}"
    source: "{{ item.source }}"
    image_id: "{{ item.image_id }}"
  loop:
    - fact: vikunja_image
      name: vikunja
      source: vikunja/vikunja:<TAG_FROM_TASK_1>
      image_id: sha256:<VIKUNJA_IMAGE_DIGEST>

    - fact: vikunja_db_image
      name: vikunja-db
      source: postgres:16.8
      image_id: sha256:5779f428edb411216d6960f2721974d7e71e124e3c41a3e625e47a9072949ed6

    - fact: vikunja_db_backup_image
      name: vikunja-db-backup
      source: prodrigestivill/postgres-backup-local:16
      image_id: sha256:a0103fbce0c48ccc7693ddbb2a2bfa733048db845354f635efef9e4566de185d

- name: deploy stack
  community.general.docker_stack:
    name: vikunja
    prune: yes
    resolve_image: always
    compose:
      - version: '3.8'
        services:
          vikunja:
            image: "{{ vikunja_image }}"
            environment:
              VIKUNJA_DATABASE_TYPE: postgres
              VIKUNJA_DATABASE_HOST: vikunja_vikunja-db
              VIKUNJA_DATABASE_USER: vikunja
              VIKUNJA_DATABASE_PASSWORD: "{{ config.vikunja.postgres_password }}"
              VIKUNJA_DATABASE_DATABASE: vikunja
              VIKUNJA_SERVICE_PUBLICURL: "https://vikunja.{{ config.domain }}"
              VIKUNJA_SERVICE_SECRET: "{{ config.vikunja.service_secret }}"
              VIKUNJA_SERVICE_TIMEZONE: America/Los_Angeles
              VIKUNJA_SERVICE_ENABLEREGISTRATION: "false"
              VIKUNJA_AUTH_LOCAL_ENABLED: "false"
              VIKUNJA_AUTH_OPENID_ENABLED: "true"
              VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_AUTHURL: https://accounts.google.com
              VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_CLIENTID: "{{ config.vikunja.google_client_id }}"
              VIKUNJA_AUTH_OPENID_PROVIDERS_GOOGLE_CLIENTSECRET: "{{ config.vikunja.google_client_secret }}"
              TZ: America/Los_Angeles
            networks:
              - vikunja
              - traefik_traefik
            volumes:
              - /mnt/gluster/vikunja/files:/app/vikunja/files
            deploy:
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=50"
                - "home.scheduler.restart=true"
                - "traefik.enable=true"
                - "traefik.http.routers.vikunja.rule=Host(`vikunja.{{ config.domain }}`)"
                - "traefik.http.routers.vikunja.middlewares=traefik-internal"
                - "traefik.http.routers.vikunja.entrypoints=websecure"
                - "traefik.http.routers.vikunja.tls.certresolver=letsencrypt"
                - "traefik.http.services.vikunja.loadbalancer.server.port=3456"
              placement:
                constraints:
                  - 'node.labels.home.instance_type == mbp'
              resources:
                limits:
                  cpus: '1.00'
                  memory: 300M
              restart_policy:
                delay: 10m
              update_config:
                order: stop-first

          vikunja-db:
            image: "{{ vikunja_db_image }}"
            environment:
              POSTGRES_USER: vikunja
              POSTGRES_PASSWORD: "{{ config.vikunja.postgres_password }}"
            networks:
              - vikunja
            volumes:
              - /mnt/gluster/vikunja/db:/var/lib/postgresql/data
            deploy:
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=30"
              placement:
                constraints:
                  - 'node.labels.home.instance_type == mbp'
              resources:
                limits:
                  cpus: '1.00'
                  memory: 200M
              restart_policy:
                delay: 20s
              update_config:
                order: stop-first

          vikunja-db-backup:
            image: "{{ vikunja_db_backup_image }}"
            environment:
              POSTGRES_HOST: vikunja_vikunja-db
              POSTGRES_DB: vikunja
              POSTGRES_USER: vikunja
              POSTGRES_PASSWORD: "{{ config.vikunja.postgres_password }}"
            networks:
              - vikunja
            volumes:
              - /mnt/gluster/vikunja/backups:/backups
            deploy:
              mode: replicated
              replicas: 1
              labels:
                - "home.scheduler.replicas=1"
                - "home.scheduler.priority=30"
              placement:
                constraints:
                  - 'node.labels.home.instance_type == mbp'
              resources:
                limits:
                  cpus: '1.00'
                  memory: 100M
              restart_policy:
                delay: 60s
              update_config:
                order: stop-first

        networks:
          vikunja: {}
          traefik_traefik:
            external: true
  vars:
    ansible_python_interpreter: /opt/docker_venv/bin/python

- name: configure backup
  ansible.builtin.copy:
    dest: /mnt/gluster/rclone/scripts/vikunja.sh
    mode: u=rwx,g=rx,o=rx
    content: |
      #!/bin/bash
      . /mnt/gluster/rclone/functions

      rclone copy --immutable /mnt/gluster/vikunja/backups/monthly \
        :s3:/$ARCHIVE_PATH/vikunja/backups/monthly \
        --exclude "vikunja-latest.sql.gz" \
        --min-age 1d

      rclone copy --immutable /mnt/gluster/vikunja/files \
        :s3:/$ARCHIVE_PATH/vikunja/files
```

- [ ] **Step 3: Lint the role YAML**

```bash
poetry run ansible-playbook playbook.yml --tags vikunja --syntax-check
```

Expected: no errors, no output beyond the play header. (Syntax-check parses YAML and validates module names, but does not connect to hosts.)

- [ ] **Step 4: Commit**

```bash
git add roles/vikunja/tasks/main.yml
git commit -m "Add vikunja role"
```

---

### Task 4: Wire role into playbook.yml

**Files:**
- Modify: `playbook.yml` (the `deploy` play, around line 200–205 — between `temporal` and `dbos` to keep DB-backed apps grouped)

- [ ] **Step 1: Add the role entry**

Open `playbook.yml` and inside the `deploy` play (`hosts: manager`), add the following two lines after the `temporal` role entry and before `dbos`:

```yaml
    - role: vikunja
      tags: vikunja
```

The surrounding context after the edit should look like:

```yaml
    - role: temporal
      tags: temporal

    - role: vikunja
      tags: vikunja

    - role: dbos
      tags: dbos
```

- [ ] **Step 2: Syntax-check the full playbook**

```bash
poetry run ansible-playbook playbook.yml --syntax-check
```

Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add playbook.yml
git commit -m "Wire vikunja role into playbook"
```

---

### Task 5: Deploy and verify

This is the acceptance test. Run it from the repo root.

- [ ] **Step 1: Deploy**

```bash
task deploy --tags vikunja
```

Expected:
- `set dns record` → `ok` or `changed`
- `create db and backup directories` → `changed` (first run) then `ok`
- `create files directory` → `changed`
- `mirror image` for each of the three images → `ok` / `changed` (the helper is idempotent; the two reused digests will be `ok` since temporal/dbos already mirrored them)
- `deploy stack` → `changed`
- `configure backup` → `changed`

If any step fails, stop and read the error before proceeding — do not patch around it blindly.

- [ ] **Step 2: Confirm the three services are running**

SSH to the swarm manager (or run via `task` if there's a remote-exec helper) and check:

```bash
docker stack services vikunja
```

Expected: three rows, all `REPLICAS 1/1`:

```
NAME                       REPLICAS   IMAGE
vikunja_vikunja            1/1        gitea.<domain>/<user>/vikunja@sha256:...
vikunja_vikunja-db         1/1        gitea.<domain>/<user>/vikunja-db@sha256:5779f4...
vikunja_vikunja-db-backup  1/1        gitea.<domain>/<user>/vikunja-db-backup@sha256:a0103f...
```

If any service shows `0/1` after ~2 minutes, inspect logs:

```bash
docker service logs --tail 200 vikunja_<service-name>
```

- [ ] **Step 3: Confirm DNS resolves and TLS works**

From the manager host (or your laptop):

```bash
curl -sI https://vikunja.<domain>/api/v1/info | head -20
```

Expected: `HTTP/2 200` and JSON in the body when you drop `-I`. The `/api/v1/info` endpoint requires no auth and returns build info — if you get it, the app, DB, and ingress are all working.

- [ ] **Step 4: Confirm OIDC login flow**

Browse to `https://vikunja.<domain>` in an incognito window. Expected behavior:
- Login page shows a "Sign in with Google" button (or similar — exact label depends on the Vikunja version).
- No username/password fields, since `VIKUNJA_AUTH_LOCAL_ENABLED=false`.
- Clicking the Google button redirects to Google's OAuth consent screen, then back to `https://vikunja.<domain>/auth/openid/google`, and finally lands you logged in.

If OIDC fails (no button appears, or the redirect 404s, or Vikunja logs show "no openid providers configured"), proceed to **Task 6**. Otherwise this is success — skip Task 6 entirely.

- [ ] **Step 5: No commit needed**

This task is verification only.

---

### Task 6: OIDC fallback to config-file (only if Task 5 Step 4 fails)

If the env-var flattening of `auth.openidConnect.providers[]` doesn't work on the pinned Vikunja version, replace the AUTH_* env vars with a mounted config file. Vikunja's `providers` is a list of objects, which some versions refuse to populate from env vars.

**Files:**
- Modify: `roles/vikunja/tasks/main.yml` (add a config-file copy task, mount it on the vikunja service, drop the `VIKUNJA_AUTH_OPENID_PROVIDERS_*` env vars)

- [ ] **Step 1: Create the config directory in the role**

Add this to the `create files directory` task in `main.yml`, or add a new task before `mirror image`:

```yaml
- name: create config directory
  ansible.builtin.file:
    path: /mnt/gluster/vikunja/config
    owner: 1000
    group: 1000
    state: directory
```

- [ ] **Step 2: Add a `template config` task before the deploy stack**

```yaml
- name: configure
  ansible.builtin.copy:
    dest: /mnt/gluster/vikunja/config/config.yml
    owner: 1000
    group: 1000
    mode: '0600'
    content: |
      service:
        publicurl: "https://vikunja.{{ config.domain }}"
        secret: "{{ config.vikunja.service_secret }}"
        timezone: America/Los_Angeles
        enableregistration: false
      database:
        type: postgres
        host: vikunja_vikunja-db
        user: vikunja
        password: "{{ config.vikunja.postgres_password }}"
        database: vikunja
      auth:
        local:
          enabled: false
        openid:
          enabled: true
          providers:
            - name: google
              authurl: https://accounts.google.com
              clientid: "{{ config.vikunja.google_client_id }}"
              clientsecret: "{{ config.vikunja.google_client_secret }}"
```

- [ ] **Step 3: Mount the config and shrink the env block**

In the `vikunja` service of the deploy stack:

Replace the entire `environment:` block with:

```yaml
            environment:
              TZ: America/Los_Angeles
```

And add to the `volumes:` block:

```yaml
              - /mnt/gluster/vikunja/config/config.yml:/etc/vikunja/config.yml:ro
```

- [ ] **Step 4: Re-deploy**

```bash
task deploy --tags vikunja
```

- [ ] **Step 5: Re-run Task 5 Step 4 (OIDC login)**

Should now succeed.

- [ ] **Step 6: Commit**

```bash
git add roles/vikunja/tasks/main.yml
git commit -m "Switch vikunja auth to config-file (env-var providers unsupported on this version)"
```

---

### Task 7: Verify backups end-to-end

The Postgres backup sidecar runs on its own schedule (default is hourly + daily + weekly + monthly). Force one immediately to confirm the wiring.

- [ ] **Step 1: Trigger a manual Postgres dump**

```bash
docker exec $(docker ps -q -f name=vikunja_vikunja-db-backup) /backup.sh
```

Expected: exits 0. Then check the output landed:

```bash
ls -lh /mnt/gluster/vikunja/backups/last
```

Expected: a `vikunja-latest.sql.gz` file from within the last minute, non-empty.

- [ ] **Step 2: Dry-run the rclone backup script**

```bash
DRY_RUN=1 /mnt/gluster/rclone/scripts/vikunja.sh
```

(Check `/mnt/gluster/rclone/functions` for the actual dry-run env var name if `DRY_RUN=1` isn't honored — copy the same convention the donetick/temporal scripts assume in practice.) If there's no native dry-run, instead run the two `rclone copy` lines manually with `--dry-run` appended.

Expected: rclone reports it would transfer the dump file and any existing attachment files, with no permission errors.

- [ ] **Step 3: No commit needed**

This task is verification only.

---

### Task 8: Open a PR (when satisfied)

- [ ] **Step 1: Push the branch and open PR**

```bash
git push -u all add-vikunja-role
gh pr create --title "Add vikunja role" --body "$(cat <<'EOF'
## Summary
- Adds `roles/vikunja` following the `temporal`/`dbos` pattern: app + dedicated `postgres:16.8` + `prodrigestivill/postgres-backup-local` sidecar.
- Google OIDC as the sole auth method (`actual` pattern); native registration disabled.
- Backed up via the standard rclone script (Postgres monthly dumps + attachments).

See [`docs/superpowers/specs/2026-06-07-vikunja-role-design.md`](docs/superpowers/specs/2026-06-07-vikunja-role-design.md) for the full design and rationale (including source-level justification for backing up `/files` without stopping the service).

## Test plan
- [x] `task deploy --tags vikunja` succeeds
- [x] `docker stack services vikunja` shows 3/3 healthy
- [x] `https://vikunja.<domain>/api/v1/info` returns 200
- [x] Google OIDC login succeeds end-to-end
- [x] Manual `/backup.sh` produces a non-empty dump in `/mnt/gluster/vikunja/backups/last`
- [x] rclone script dry-run shows expected uploads

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Confirm the resulting URL.
