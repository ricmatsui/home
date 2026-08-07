# Gluster Volume Recover Timer

## Problem

Gluster brick processes on `gv0` occasionally drop offline (currently the pi
brick is the recurring culprit). Recovery requires `gluster volume start gv0
force`, which is idempotent but must be issued by hand. This spec adds a
scheduled service that detects offline bricks and issues the force-start
automatically.

Root-cause investigation of why the pi brick drops is out of scope for this
spec. The timer is a self-healing safety net, not a substitute for the fix.

## Constraints

- `gluster volume start ... force` acquires the glusterd distributed lock.
  Concurrent invocations from multiple peers can hit "Another transaction is in
  progress" errors, and in the worst case leave a stale lock requiring
  `systemctl restart glusterd` to clear.
  ([Gluster docs — Troubleshooting glusterd](https://docs.gluster.org/en/latest/Troubleshooting/troubleshooting-glusterd/))
- `force` bounces bitrot and scrubber daemons even when all bricks are
  already online (verified empirically). Running it unconditionally on a
  short cadence is wasteful.
- Deployments follow the existing role pattern: inline systemd unit files
  copied via `ansible.builtin.copy`, notify handlers for reload, timer enabled
  via `ansible.builtin.systemd`. See `roles/scheduler/tasks/main.yml` for
  reference.

## Design

### Placement

New files live inside the existing `roles/gluster_server/` role, which is
already applied to the `gluster_pool_servers` group (`pi`, `cannoli`,
`gelato`) via `playbook.yml`.

### Recovery script — `/opt/gluster-recover.sh`

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

- Uses `gluster volume status --xml` (the underlying CLI) rather than
  `gstatus`. `gstatus` was tested first but proved unreliable — it can hang
  for multiple minutes on this cluster even when the raw CLI responds
  sub-second. The `timeout 30` prefix ensures the script never hangs the
  systemd unit if the gluster CLI itself misbehaves.
- Parsing via Python's stdlib `xml.etree.ElementTree` (no new package
  dependencies — Python 3 is required by Ansible and present on all pool
  servers). `xmllint` was considered but is not installed on the nodes.
- Bricks are distinguished from daemons (self-heal, bitrot, scrubber) by
  filtering on `path.startswith("/")` — daemons report `<path>localhost</path>`.
- Preflight check: force-start fires only when at least one brick reports
  `<status>0</status>`. Healthy state → no lock contention, no daemon bounces.
- Volume scope is hard-coded to `gv0`. The `backup` volume's two bricks are
  both local to `pi`, so single-node failure isn't a meaningful recovery
  scenario there.

### systemd service — `/etc/systemd/system/gluster-recover.service`

```ini
[Unit]
Description=Gluster Volume Recovery
After=glusterd.service
Requires=glusterd.service

[Service]
Type=oneshot
ExecStart=/opt/gluster-recover.sh
```

`Type=oneshot` so each run's success/failure is visible in `systemctl status`
and logs land in the journal under `gluster-recover.service`.

### systemd timer — `/etc/systemd/system/gluster-recover.timer`

```ini
[Unit]
Description=Gluster Volume Recovery

[Timer]
OnCalendar=*-*-* *:{{ gluster_recover_offset_minutes }}:00
RandomizedDelaySec=60s
Persistent=true

[Install]
WantedBy=timers.target
```

Offset defined in `roles/gluster_server/defaults/main.yml`:

```yaml
gluster_recover_offset_minutes: "{{ {'pi': 0, 'cannoli': 20, 'gelato': 40}[inventory_hostname] }}"
```

- Fires hourly at :00, :20, :40 past the hour on `pi`, `cannoli`, `gelato`
  respectively. Any offline brick is recovered within 20 min max; worst case
  (one node completely down) within 40 min.
- `RandomizedDelaySec=60s` is well below the 20-minute offset, so overlap is
  impossible under normal clock behavior. Even if drift produced overlap, the
  preflight makes double-work vanishingly rare.

### Ansible tasks — append to `roles/gluster_server/tasks/main.yml`

1. `copy` script to `/opt/gluster-recover.sh` (mode `0755`) — notify
   `gluster_recover_reload`.
2. `copy` service unit inline — notify `gluster_recover_reload`.
3. `copy` timer unit inline (rendered with per-host offset) — notify
   `gluster_recover_reload`.
4. `ansible.builtin.systemd` — enable and start `gluster-recover.timer`.

### Ansible handlers — new `roles/gluster_server/handlers/main.yml`

```yaml
- name: gluster_recover_reload
  ansible.builtin.systemd:
    name: gluster-recover.timer
    daemon_reload: true
    state: restarted
```

## Operational notes

- Manual trigger for testing: `sudo systemctl start gluster-recover.service`.
- Check next fire times: `systemctl list-timers gluster-recover.timer`.
- Logs: `journalctl -u gluster-recover.service`.
- Disable temporarily: `sudo systemctl stop gluster-recover.timer` (survives
  until next Ansible run, which will re-enable it).

## Out of scope

- Investigating why the pi brick keeps dropping. The timer masks the symptom;
  the underlying cause (mount, kernel, disk, network) needs separate
  diagnosis.
- Recovery for the `backup` volume.
- Alerting when the timer actually did work (i.e. noticing repeated recoveries
  as a signal that something is wrong). Datadog already has a gluster check
  that can be relied on for alerting.
