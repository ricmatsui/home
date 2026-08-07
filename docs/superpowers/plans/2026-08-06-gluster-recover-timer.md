# Gluster Recover Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a scheduled systemd timer on each Gluster pool server (`pi`, `cannoli`, `gelato`) that detects offline `gv0` bricks via `gstatus` and auto-issues `gluster volume start gv0 force` to recover them.


**Architecture:** New script `/opt/gluster-recover.sh` on each pool server, wrapped in a `gluster-recover.service` (`Type=oneshot`) and driven by `gluster-recover.timer` firing hourly at a per-host offset (:00/:20/:40). Deployed via new tasks in the existing `roles/gluster_server/` role. Preflight check keeps healthy state a no-op so glusterd is untouched when nothing is wrong.

**Tech Stack:** Ansible (existing role), bash, systemd, `gstatus v1.0.8` + `jq` (already installed on all pool servers).

## Global Constraints

- Volume scope is hard-coded to `gv0`. `backup` is out of scope.
- All three pool servers run the timer, staggered 20 min apart: `pi` :00, `cannoli` :20, `gelato` :40. Overlap must be impossible under normal clock behavior — `RandomizedDelaySec` stays ≤ 60s.
- Preflight required: force-start only when `gstatus` reports fewer online bricks than total. Never issue force unconditionally.
- Follow existing role patterns: inline systemd units via `ansible.builtin.copy` with `content:`, notify handlers with named `listen:` events. See `roles/scheduler/tasks/main.yml` and `roles/gluster_server/handlers/main.yml` for reference.
- No new package dependencies. `gstatus` is installed by `roles/gluster_server/tasks/main.yml:31`, `jq` is present on all pool servers.
- Deploy via `task deploy --tags gluster_recover`. All new tasks must carry that tag.

---

### Task 1: Recovery script

**Files:**
- Create: `roles/gluster_server/files/gluster-recover.sh`

**Interfaces:**
- Consumes: nothing (standalone script).
- Produces: `/opt/gluster-recover.sh` on target hosts (installed by Task 2). Exit 0 on success (whether recovery ran or was skipped). Non-zero exit propagates a failure to systemd.

- [ ] **Step 1: Create the script file**

Path: `roles/gluster_server/files/gluster-recover.sh` (create the `files/` directory too — it doesn't exist yet).

```bash
#!/bin/bash
set -Eeuo pipefail

VOLUME=gv0

offline_bricks=$(timeout 30 gluster volume status "$VOLUME" --xml | python3 -c '
import sys
import xml.etree.ElementTree as ET

root = ET.fromstring(sys.stdin.read())
offline = 0
for node in root.iter("node"):
    path = node.findtext("path") or ""
    status = node.findtext("status") or ""
    # Bricks have real filesystem paths; daemons report path="localhost"
    if path.startswith("/") and status == "0":
        offline += 1
print(offline)
')

if [[ "$offline_bricks" -gt 0 ]]; then
    echo "Offline brick(s) detected in $VOLUME: $offline_bricks, running force start"
    gluster volume start "$VOLUME" force
else
    echo "All bricks online for $VOLUME"
fi
```

Note: `gstatus` was considered but proved unreliable (multi-minute hangs on this cluster). Using raw `gluster --xml` + Python stdlib parsing instead — no new deps.

- [ ] **Step 2: Copy the script to one node for manual validation**

From the repo root:
```bash
TERM=xterm /usr/bin/scp roles/gluster_server/files/gluster-recover.sh pi:/tmp/gluster-recover.sh
TERM=xterm /usr/bin/ssh pi "chmod +x /tmp/gluster-recover.sh"
```

- [ ] **Step 3: Verify healthy-state behavior (no-op)**

If `gv0` is healthy on `pi` (all bricks online), run:
```bash
TERM=xterm /usr/bin/ssh pi "sudo /tmp/gluster-recover.sh"
```
Expected output: `All bricks online for gv0`. Exit code 0.

If `gv0` is currently unhealthy (e.g., the pi brick is offline again), instead of the above, first force-start manually so we can observe the healthy path:
```bash
TERM=xterm /usr/bin/ssh pi "sudo gluster volume start gv0 force"
```
Then re-run the script command above.

- [ ] **Step 4: Verify unhealthy-state behavior (force start fires)**

Stop the local brick on `pi` to simulate a failure. Fetch the brick PID from gstatus (robust — no fragile pattern matching against `glusterfsd` cmdline):

```bash
TERM=xterm /usr/bin/ssh pi "sudo gstatus -v gv0 -o json \
  | jq -r '.data.volume_summary[0].subvols[0].bricks[] \
      | select(.name == \"192.168.3.33:/mnt/external/gluster\") \
      | .pid'"
```
Expected: a numeric PID (e.g. `772886`). If it prints `N/A`, the brick is already offline — skip the kill and continue to the script run.

Then kill it (substitute the PID from above):
```bash
TERM=xterm /usr/bin/ssh pi "sudo kill <PID>"
sleep 3
TERM=xterm /usr/bin/ssh pi "sudo gstatus -v gv0 -o json | jq '.data.volume_summary[0] | {online, num_bricks}'"
```
Confirm output shows `online < num_bricks` (e.g., `{"online": 2, "num_bricks": 3}`).

Then run the script:
```bash
TERM=xterm /usr/bin/ssh pi "sudo /tmp/gluster-recover.sh"
```
Expected output: `Offline brick detected in gv0, running force start` followed by `volume start: gv0: success`. Exit code 0.

Then verify recovery:
```bash
TERM=xterm /usr/bin/ssh pi "sudo gstatus -v gv0 -o json | jq '.data.volume_summary[0] | {online, num_bricks}'"
```
Expected: `online == num_bricks`.

- [ ] **Step 5: Clean up the test copy**

```bash
TERM=xterm /usr/bin/ssh pi "sudo rm /tmp/gluster-recover.sh"
```

- [ ] **Step 6: Commit**

```bash
git add roles/gluster_server/files/gluster-recover.sh
git commit -m "Add gluster-recover script for gv0 brick auto-recovery"
```

---

### Task 2: Ansible wiring — deploy script, service, timer

**Files:**
- Create: `roles/gluster_server/defaults/main.yml`
- Modify: `roles/gluster_server/tasks/main.yml` (append new tasks)
- Modify: `roles/gluster_server/handlers/main.yml` (append new handler)

**Interfaces:**
- Consumes: `roles/gluster_server/files/gluster-recover.sh` from Task 1.
- Produces: On each pool server — `/opt/gluster-recover.sh` (mode 0755, owned by root), `/etc/systemd/system/gluster-recover.service`, `/etc/systemd/system/gluster-recover.timer`, and the timer enabled + started. Handler `gluster_recover_reload` performs `daemon-reload` + timer restart when any of the three files change.

- [ ] **Step 1: Create the defaults file**

Path: `roles/gluster_server/defaults/main.yml` (create the `defaults/` directory too — it doesn't exist yet).

```yaml
---

gluster_recover_offset_minutes: "{{ {'pi': 0, 'cannoli': 20, 'gelato': 40}[inventory_hostname] }}"
```

Strict dict lookup — if a new pool server is added without an entry, deploy will fail loudly with a KeyError. That's intentional: silent collision on the same minute is worse.

- [ ] **Step 2: Add the handler**

Append to `roles/gluster_server/handlers/main.yml`:

```yaml
- name: reload gluster recover timer
  ansible.builtin.systemd:
    name: gluster-recover.timer
    daemon_reload: true
    state: restarted
  listen: gluster_recover_reload
```

- [ ] **Step 3: Add the deploy tasks**

Append to `roles/gluster_server/tasks/main.yml`:

```yaml
- name: create gluster recover script
  ansible.builtin.copy:
    dest: /opt/gluster-recover.sh
    src: gluster-recover.sh
    owner: root
    group: root
    mode: u=rwx,g=rx,o=rx
  notify: gluster_recover_reload
  tags: gluster_recover

- name: configure gluster recover service
  ansible.builtin.copy:
    dest: /etc/systemd/system/gluster-recover.service
    content: |
      [Unit]
      Description=Gluster Volume Recovery
      After=glusterd.service
      Requires=glusterd.service

      [Service]
      Type=oneshot
      ExecStart=/opt/gluster-recover.sh
  notify: gluster_recover_reload
  tags: gluster_recover

- name: configure gluster recover timer
  ansible.builtin.copy:
    dest: /etc/systemd/system/gluster-recover.timer
    content: |
      [Unit]
      Description=Gluster Volume Recovery

      [Timer]
      OnCalendar=*-*-* *:{{ gluster_recover_offset_minutes }}:00
      RandomizedDelaySec=60s
      Persistent=true

      [Install]
      WantedBy=timers.target
  notify: gluster_recover_reload
  tags: gluster_recover

- name: enable gluster recover timer
  ansible.builtin.systemd:
    name: gluster-recover.timer
    enabled: true
    state: started
  tags: gluster_recover
```

- [ ] **Step 4: Syntax-check the playbook**

From the repo root:
```bash
poetry run ansible-playbook playbook.yml --syntax-check
```
Expected: exit 0, no errors.

- [ ] **Step 5: Check-mode diff for the new tag**

```bash
task deploy --tags gluster_recover --check --diff
```
Expected: shows the three `copy` tasks and the `systemd` enable task as changed on `pi`, `cannoli`, `gelato`. No unrelated changes. Confirm the rendered timer content shows the correct offset per host: `*:0:00` for pi, `*:20:00` for cannoli, `*:40:00` for gelato.

- [ ] **Step 6: Deploy for real**

```bash
task deploy --tags gluster_recover
```
Expected: green run, all four tasks apply on all three hosts, handler `gluster_recover_reload` fires exactly once per host.

- [ ] **Step 7: Verify timers on all three hosts**

```bash
for host in pi cannoli gelato; do
  echo "=== $host ==="
  TERM=xterm /usr/bin/ssh $host "systemctl list-timers gluster-recover.timer --no-pager"
done
```
Expected per host:
- pi → NEXT column shows next hour at :00
- cannoli → next hour at :20
- gelato → next hour at :40
- All active, unit `gluster-recover.timer`, activates `gluster-recover.service`.

- [ ] **Step 8: Manually trigger the service on one host and inspect logs**

```bash
TERM=xterm /usr/bin/ssh pi "sudo systemctl start gluster-recover.service && sudo journalctl -u gluster-recover.service -n 20 --no-pager"
```
Expected: journal shows either `All bricks online for gv0` or (if the pi brick is currently offline) `Offline brick detected in gv0, running force start` followed by `volume start: gv0: success`. Service exits `status=0/SUCCESS`.

- [ ] **Step 9: Commit**

```bash
git add roles/gluster_server/defaults/main.yml \
        roles/gluster_server/tasks/main.yml \
        roles/gluster_server/handlers/main.yml
git commit -m "Wire gluster-recover.timer into gluster_server role"
```
