# Gluster Client Mount Recover Timer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a scheduled systemd timer on each Gluster client (`pi`, `tart`, `cannoli`, `gelato`) that detects a dead or hung `/mnt/gluster` FUSE mount and remounts it automatically.

**Architecture:** New script `/opt/gluster-mount-recover.sh` on each client, wrapped in a `gluster-mount-recover.service` (`Type=oneshot`) and driven by `gluster-mount-recover.timer` firing every 2 minutes. Deployed via new tasks in the existing `roles/gluster_client/` role. A two-strikes guard backed by a counter in `/run/` keeps a single slow probe from triggering a disruptive remount.

**Tech Stack:** Ansible (existing role), bash, systemd. No new package dependencies.

**Spec:** `docs/superpowers/specs/2026-08-07-gluster-mount-recover-timer-design.md`

## Global Constraints

- Mount scope is hard-coded to `/mnt/gluster` / `mnt-gluster.mount`.
- All four hosts in the `gluster_client` group run the timer: `pi`, `tart`, `cannoli`, `gelato`. Note `tart` is a `gluster_client` but **not** a pool server — it does not run `glusterd`, so no unit may declare `Requires=glusterd.service` or `After=glusterd.service`.
- The probe must be `timeout`-wrapped. A bare `ls` on a hung FUSE mount blocks forever and would wedge the systemd unit.
- The probe must stay behaviourally identical to `roles/datadog/templates/custom_gluster_mount.py:10-18` — `timeout N ls <mount>`, treating non-zero exit **or** empty output as failure. Only the timeout value differs (20s here vs. 10s there).
- Two-strikes guard is required. Recovery fires only on the second consecutive failure. A false remount makes every running container's bind mount stale, which is worse than the transient blip it would be reacting to.
- Unmount must be lazy (`umount -l`). Containers hold the mount open, so a plain `umount` fails as busy.
- Nothing existing may change: the fstab entry at `roles/gluster_client/tasks/main.yml:14-21`, the automount, and the Datadog check all stay exactly as they are.
- Follow existing role patterns: inline systemd units via `ansible.builtin.copy` with `content:`, notify handlers with named `listen:` events. See `roles/gluster_server/tasks/main.yml:97-144` for the directly analogous `gluster-recover` trio.
- Deploy via `task deploy --tags gluster_mount_recover`. All new Ansible tasks must carry that tag.
- Non-interactive SSH on this workstation requires the `TERM=xterm /usr/bin/ssh` prefix (kitty terminal workaround).

---

### Task 1: Recovery script and non-destructive validation

**Files:**
- Create: `roles/gluster_client/files/gluster-mount-recover.sh`

**Interfaces:**
- Consumes: nothing (standalone script).
- Produces: `/opt/gluster-mount-recover.sh` on target hosts (installed by Task 3). Exit 0 when the mount is healthy, when recovery is deferred on strike 1, and when a remount succeeds. Exit 1 only when a remount was attempted and the mount is still broken afterwards. Maintains state file `/run/gluster-mount-recover.failures`.

- [ ] **Step 1: Create the script file**

Path: `roles/gluster_client/files/gluster-mount-recover.sh` (create the `files/` directory too — it doesn't exist yet).

```bash
#!/bin/bash
set -Eeuo pipefail

MOUNT_POINT=/mnt/gluster
MOUNT_UNIT=mnt-gluster.mount
PROBE_TIMEOUT=20
FAILURE_THRESHOLD=2
STATE_FILE=/run/gluster-mount-recover.failures

probe() {
    local output
    output=$(timeout "$PROBE_TIMEOUT" ls "$MOUNT_POINT" 2>/dev/null) || return 1
    [[ -n "${output//[[:space:]]/}" ]] || return 1
}

if probe; then
    rm -f "$STATE_FILE"
    echo "Mount healthy: $MOUNT_POINT"
    exit 0
fi

failures=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))
echo "$failures" > "$STATE_FILE"

if [[ "$failures" -lt "$FAILURE_THRESHOLD" ]]; then
    echo "Probe failed for $MOUNT_POINT ($failures/$FAILURE_THRESHOLD), deferring recovery"
    exit 0
fi

echo "Probe failed for $MOUNT_POINT ($failures/$FAILURE_THRESHOLD), remounting"
umount -l "$MOUNT_POINT" || echo "Lazy unmount reported failure, continuing"
sleep 2
systemctl restart "$MOUNT_UNIT"

if ! probe; then
    echo "Remount failed for $MOUNT_POINT" >&2
    exit 1
fi

rm -f "$STATE_FILE"
echo "Remount succeeded for $MOUNT_POINT"

# Containers resolve bind mounts at creation, so they keep pointing at the dead
# superblock across a remount and stay broken without ever crashing. Restarting
# the daemon forces every container to re-resolve.
if systemctl is-active --quiet docker; then
    echo "Restarting docker so containers re-resolve their bind mounts"
    systemctl restart docker
    echo "Docker restarted"
else
    echo "Docker not active, skipping restart"
fi
```

Notes for the implementer:
- `probe` returns non-zero via its final `[[ ... ]]`. Calling it inside `if` is safe under `set -e` — the shell suspends errexit in condition context.
- Empty output counts as failure because a mounted `gv0` is never empty. This also catches a bare autofs mountpoint exposed without the real mount on top.
- `sleep 2` closes a race: after `umount -l`, systemd needs a moment to observe the `/proc/self/mountinfo` change and mark `mnt-gluster.mount` inactive. Without it `systemctl restart` may still believe the unit is active.
- `restart` rather than `start` so the sequence is correct whether or not systemd has already noticed.

- [ ] **Step 2: Syntax-check the script locally**

From the repo root:
```bash
bash -n roles/gluster_client/files/gluster-mount-recover.sh
```
Expected: exit 0, no output.

- [ ] **Step 3: Copy the script to `tart` for manual validation**

`tart` is the Swarm worker and the lowest-blast-radius client. All validation in this task and Task 2 happens there.

```bash
TERM=xterm /usr/bin/scp roles/gluster_client/files/gluster-mount-recover.sh tart:/tmp/gluster-mount-recover.sh
TERM=xterm /usr/bin/ssh tart "chmod +x /tmp/gluster-mount-recover.sh"
```

- [ ] **Step 4: Verify healthy-state behavior (no-op)**

```bash
TERM=xterm /usr/bin/ssh tart "sudo /tmp/gluster-mount-recover.sh; echo EXIT=\$?"
```
Expected output:
```
Mount healthy: /mnt/gluster
EXIT=0
```

- [ ] **Step 5: Verify the healthy path clears a stale counter**

Plant a counter, then confirm a healthy run removes it:

```bash
TERM=xterm /usr/bin/ssh tart "echo 1 | sudo tee /run/gluster-mount-recover.failures >/dev/null && sudo /tmp/gluster-mount-recover.sh && ls /run/gluster-mount-recover.failures"
```
Expected: `Mount healthy: /mnt/gluster`, then `ls: cannot access '/run/gluster-mount-recover.failures': No such file or directory`. The failing `ls` at the end is the expected result, not an error in the script.

- [ ] **Step 6: Verify the two-strikes counter increments against a bogus mount point**

This exercises the failure path without touching the real mount. Run a copy of the script pointed at a guaranteed-empty directory:

```bash
TERM=xterm /usr/bin/ssh tart "sudo mkdir -p /tmp/fake-mount && \
  sudo sed 's#^MOUNT_POINT=.*#MOUNT_POINT=/tmp/fake-mount#; s#^STATE_FILE=.*#STATE_FILE=/run/gluster-mount-recover-test.failures#' \
    /tmp/gluster-mount-recover.sh > /tmp/gluster-mount-recover-test.sh && \
  sudo chmod +x /tmp/gluster-mount-recover-test.sh && \
  sudo rm -f /run/gluster-mount-recover-test.failures && \
  sudo /tmp/gluster-mount-recover-test.sh; echo EXIT=\$?"
```
Expected:
```
Probe failed for /tmp/fake-mount (1/2), deferring recovery
EXIT=0
```

Confirm the counter was written:
```bash
TERM=xterm /usr/bin/ssh tart "cat /run/gluster-mount-recover-test.failures"
```
Expected: `1`

Do **not** run the test script a second time — strike 2 would call `systemctl restart mnt-gluster.mount` for real. The genuine two-strike path is validated in Task 2.

- [ ] **Step 7: Clean up the test copies**

```bash
TERM=xterm /usr/bin/ssh tart "sudo rm -f /tmp/gluster-mount-recover-test.sh /run/gluster-mount-recover-test.failures && sudo rmdir /tmp/fake-mount"
```

Leave `/tmp/gluster-mount-recover.sh` in place — Task 2 uses it.

- [ ] **Step 8: Commit**

```bash
git add roles/gluster_client/files/gluster-mount-recover.sh
git commit -m "Add gluster-mount-recover script for /mnt/gluster auto-recovery"
```

---

### Task 2: Destructive validation of the recovery path

This task deliberately breaks the `/mnt/gluster` mount on `tart` to prove the remount sequence works, including its interaction with the autofs layer from `x-systemd.automount`. Everything happens on `tart` only.

**Files:**
- None. Validation only — no repo changes, no commit.

**Interfaces:**
- Consumes: `/tmp/gluster-mount-recover.sh` on `tart`, left in place by Task 1.
- Produces: confirmation that the `umount -l` → `systemctl restart` sequence recovers an `ENOTCONN` mount. Task 3 should not deploy fleet-wide until this passes.

- [ ] **Step 1: Record what is currently running on `tart`**

```bash
TERM=xterm /usr/bin/ssh tart "docker ps --format '{{.Names}}\t{{.Status}}'"
```
Save this output. Containers with binds under `/mnt/gluster` will see I/O errors during this task; the ones that crash will be rescheduled by Swarm. Compare against this list in Step 8.

- [ ] **Step 2: Confirm the mount is healthy and find the client PID**

```bash
TERM=xterm /usr/bin/ssh tart "ls /mnt/gluster >/dev/null && echo MOUNT_OK; pgrep -af 'glusterfs.*--volfile-id=/gv0'"
```
Expected: `MOUNT_OK`, then one line with a numeric PID and the full `/usr/sbin/glusterfs … /mnt/gluster` command line.

- [ ] **Step 3: Inspect the mount stack before breaking it**

```bash
TERM=xterm /usr/bin/ssh tart "findmnt -T /mnt/gluster -o TARGET,SOURCE,FSTYPE --no-truncate; systemctl is-active mnt-gluster.mount mnt-gluster.automount"
```
Expected: a `fuse.glusterfs` mount at `/mnt/gluster`, and both units reporting `active`. Record this output — Step 7 compares against it.

- [ ] **Step 4: Break the mount**

Kill the FUSE client, which leaves the mount present but `ENOTCONN` (substitute the PID from Step 2):

```bash
TERM=xterm /usr/bin/ssh tart "sudo kill -9 <PID>"
```

Confirm the failure mode is the one we're targeting:
```bash
TERM=xterm /usr/bin/ssh tart "ls /mnt/gluster; echo EXIT=\$?; systemctl is-active mnt-gluster.mount"
```
Expected: `ls: cannot access '/mnt/gluster': Transport endpoint is not connected`, `EXIT=2`, and `mnt-gluster.mount` still reporting `active` — which is exactly the gap this whole feature closes.

- [ ] **Step 5: Run the script — strike 1 should defer**

```bash
TERM=xterm /usr/bin/ssh tart "sudo rm -f /run/gluster-mount-recover.failures; sudo /tmp/gluster-mount-recover.sh; echo EXIT=\$?"
```
Expected:
```
Probe failed for /mnt/gluster (1/2), deferring recovery
EXIT=0
```
Confirm the mount is still broken — the script must not have acted yet:
```bash
TERM=xterm /usr/bin/ssh tart "ls /mnt/gluster; echo EXIT=\$?"
```
Expected: still `Transport endpoint is not connected`, `EXIT=2`.

- [ ] **Step 6: Run the script — strike 2 should recover**

```bash
TERM=xterm /usr/bin/ssh tart "sudo /tmp/gluster-mount-recover.sh; echo EXIT=\$?"
```
Expected:
```
Probe failed for /mnt/gluster (2/2), remounting
Remount succeeded for /mnt/gluster
EXIT=0
```

If `umount -l` prints `Lazy unmount reported failure, continuing` but the run still ends in `Remount succeeded`, that is acceptable. If the run ends in `Remount failed`, **stop here** — the remount sequence needs rework before Task 3. Recover the host by hand with `sudo umount -l /mnt/gluster; sudo systemctl restart mnt-gluster.mount` and report the failure.

- [ ] **Step 7: Verify the mount stack is fully restored**

```bash
TERM=xterm /usr/bin/ssh tart "findmnt -T /mnt/gluster -o TARGET,SOURCE,FSTYPE --no-truncate; systemctl is-active mnt-gluster.mount mnt-gluster.automount; ls /mnt/gluster | head -5; pgrep -af 'glusterfs.*--volfile-id=/gv0'"
```
Expected: output matches Step 3 — a `fuse.glusterfs` mount present, both units `active`, a non-empty listing, and a **new** glusterfs PID differing from the one killed in Step 4. Critically, `mnt-gluster.automount` must still be active; if it is gone, the lazy unmount stripped the autofs layer too and the script needs to unmount more precisely.

Confirm the counter was cleared:
```bash
TERM=xterm /usr/bin/ssh tart "ls /run/gluster-mount-recover.failures"
```
Expected: `No such file or directory`.

- [ ] **Step 8: Verify container recovery on `tart`**

The script restarts `docker.service` after a successful remount, so **every** container on the host must show a fresh `Up` time — not just the ones with gluster binds.

```bash
TERM=xterm /usr/bin/ssh tart "sudo docker ps --format '{{.Names}}\t{{.Status}}'"
```
Compare against Step 1. Expected: all containers show `Up <seconds/minutes>`, not the multi-hour uptimes from Step 1.

Then confirm the gluster-bound containers can actually reach their data — this is the check that matters, and the one that failed before the daemon restart was added:

```bash
TERM=xterm /usr/bin/ssh tart "sudo docker ps -q | while read c; do
  n=\$(sudo docker inspect -f '{{.Name}}' \$c)
  if sudo docker inspect -f '{{range .Mounts}}{{.Source}} {{end}}' \$c | tr ' ' '\n' | grep -q '^/mnt/gluster'; then
    p=\$(sudo docker inspect -f '{{range .Mounts}}{{if eq (printf \"%.13s\" .Source) \"/mnt/gluster\"}}{{.Destination}}{{end}}{{end}}' \$c | head -c 100)
    echo -n \"\$n \$p -> \"
    sudo timeout 15 docker exec \$c ls \$p >/dev/null 2>&1 && echo OK || echo STALE
  fi
done"
```
Expected: every gluster-bound container reports `OK`. Any `STALE` means the daemon restart did not achieve its purpose — stop and report.

Note `sudo` is required for all `docker` commands on these hosts; the login user is not in the `docker` group.

- [ ] **Step 9: Clean up the test copy**

```bash
TERM=xterm /usr/bin/ssh tart "sudo rm -f /tmp/gluster-mount-recover.sh"
```

No commit — this task changes no files.

---

### Task 3: Ansible wiring — deploy script, service, timer

**Files:**
- Modify: `roles/gluster_client/tasks/main.yml` (append new tasks)
- Modify: `roles/gluster_client/handlers/main.yml` (append new handler)

**Interfaces:**
- Consumes: `roles/gluster_client/files/gluster-mount-recover.sh` from Task 1, validated by Task 2.
- Produces: On each of `pi`, `tart`, `cannoli`, `gelato` — `/opt/gluster-mount-recover.sh` (mode 0755, owned by root), `/etc/systemd/system/gluster-mount-recover.service`, `/etc/systemd/system/gluster-mount-recover.timer`, and the timer enabled + started. Handler `gluster_mount_recover_reload` performs `daemon-reload` + timer restart when any of the three files change.

- [ ] **Step 1: Add the handler**

Append to `roles/gluster_client/handlers/main.yml`:

```yaml
- name: reload gluster mount recover timer
  ansible.builtin.systemd:
    name: gluster-mount-recover.timer
    daemon_reload: true
    state: restarted
  listen: gluster_mount_recover_reload
```

- [ ] **Step 2: Add the deploy tasks**

Append to `roles/gluster_client/tasks/main.yml`:

```yaml
- name: create gluster mount recover script
  ansible.builtin.copy:
    dest: /opt/gluster-mount-recover.sh
    src: gluster-mount-recover.sh
    owner: root
    group: root
    mode: u=rwx,g=rx,o=rx
  notify: gluster_mount_recover_reload
  tags: gluster_mount_recover

- name: configure gluster mount recover service
  ansible.builtin.copy:
    dest: /etc/systemd/system/gluster-mount-recover.service
    content: |
      [Unit]
      Description=Gluster Mount Recovery

      [Service]
      Type=oneshot
      TimeoutStartSec=300
      ExecStart=/opt/gluster-mount-recover.sh
  notify: gluster_mount_recover_reload
  tags: gluster_mount_recover

- name: configure gluster mount recover timer
  ansible.builtin.copy:
    dest: /etc/systemd/system/gluster-mount-recover.timer
    content: |
      [Unit]
      Description=Gluster Mount Recovery

      [Timer]
      OnCalendar=*:0/2
      RandomizedDelaySec=30s

      [Install]
      WantedBy=timers.target
  notify: gluster_mount_recover_reload
  tags: gluster_mount_recover

- name: enable gluster mount recover timer
  ansible.builtin.systemd:
    name: gluster-mount-recover.timer
    enabled: true
    state: started
  tags: gluster_mount_recover
```

Deliberately absent from the service unit: `After=glusterd.service` / `Requires=glusterd.service`. `tart` has no glusterd, and the client mount does not depend on a local server anyway. Also absent from the timer: `Persistent=true` — catch-up runs are meaningless for a 2-minute health probe.

`TimeoutStartSec=300` raises systemd's default 90s start timeout. The recovery path spends up to 20s per probe plus a full `docker.service` restart, which can exceed 90s on a Pi with nine containers; at the default the unit would be killed mid-restart. The healthy path exits in under a second and is unaffected.

- [ ] **Step 3: Syntax-check the playbook**

From the repo root:
```bash
poetry run ansible-playbook playbook.yml --syntax-check
```
Expected: exit 0, no errors.

- [ ] **Step 4: Check-mode diff for the new tag**

```bash
task deploy --tags gluster_mount_recover --check --diff
```
Expected: the three `copy` tasks and the `systemd` enable task show as changed on `pi`, `tart`, `cannoli`, `gelato`. No unrelated changes, and specifically no diff against the fstab mount or the Datadog check. Confirm the rendered timer content shows `OnCalendar=*:0/2` on every host — this timer has no per-host offset.

- [ ] **Step 5: Deploy for real**

```bash
task deploy --tags gluster_mount_recover
```
Expected: green run, all four tasks apply on all four hosts, handler `gluster_mount_recover_reload` fires exactly once per host.

- [ ] **Step 6: Verify timers on all four hosts**

```bash
for host in pi tart cannoli gelato; do
  echo "=== $host ==="
  TERM=xterm /usr/bin/ssh $host "systemctl list-timers gluster-mount-recover.timer --no-pager"
done
```
Expected per host: timer active, NEXT column within the next ~2.5 minutes (2-minute cadence plus up to 30s of randomized delay), unit `gluster-mount-recover.timer`, activating `gluster-mount-recover.service`.

- [ ] **Step 7: Manually trigger the service on every host and inspect logs**

```bash
for host in pi tart cannoli gelato; do
  echo "=== $host ==="
  TERM=xterm /usr/bin/ssh $host "sudo systemctl start gluster-mount-recover.service && sudo journalctl -u gluster-mount-recover.service -n 5 --no-pager"
done
```
Expected per host: journal shows `Mount healthy: /mnt/gluster` and the service exits `status=0/SUCCESS`. Any host reporting a probe failure means that host's mount is genuinely broken right now — investigate before continuing.

- [ ] **Step 8: Confirm steady-state runs stay quiet**

Wait for at least two timer firings (about 5 minutes), then:

```bash
TERM=xterm /usr/bin/ssh pi "sudo journalctl -u gluster-mount-recover.service --since '6 minutes ago' --no-pager | grep -c 'Mount healthy'"
```
Expected: `2` or more. Also confirm no strike counters are lingering anywhere:

```bash
for host in pi tart cannoli gelato; do
  echo -n "$host: "
  TERM=xterm /usr/bin/ssh $host "ls /run/gluster-mount-recover.failures 2>&1 | tail -1"
done
```
Expected: `No such file or directory` on all four.

- [ ] **Step 9: Commit**

```bash
git add roles/gluster_client/tasks/main.yml \
        roles/gluster_client/handlers/main.yml
git commit -m "Wire gluster-mount-recover.timer into gluster_client role"
```
