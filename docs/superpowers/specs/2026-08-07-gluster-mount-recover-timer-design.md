# Gluster Client Mount Recover Timer

## Problem

`roles/gluster_client/` mounts `gv0` at `/mnt/gluster` on `pi`, `tart`,
`cannoli` and `gelato` via an fstab entry with `x-systemd.automount`. That
handles cold start — mount on first access — but nothing handles the two
runtime failure modes of a FUSE client:

- **Dead client (`ENOTCONN`).** The `glusterfs` client process dies (OOM kill,
  crash) while the kernel superblock survives. The mount is still listed in
  `/proc/self/mountinfo`, so systemd reports `mnt-gluster.mount` as
  `active (mounted)`, but every operation returns "Transport endpoint is not
  connected". This is the common case.
- **Hung client.** The process is alive but wedged; I/O blocks indefinitely
  rather than erroring.

Neither self-heals. systemd sees no failure, so there is nothing for
`OnFailure=` to catch, and `x-systemd.automount` only triggers when the mount
unit is *inactive* — which it never becomes. Recovery today is a manual
remount.

This spec adds a scheduled service that detects a broken mount and remounts it.
It is a self-healing safety net, not a substitute for root-causing why the
client dies.

## Constraints

- `.mount` units do not support `Restart=`. There is no native systemd
  directive that recovers a mount whose backing daemon has died.
- Supervising `glusterfs -N` (verified present on `pi`, glusterfs 10.3) under a
  `Restart=always` service was considered and rejected. It recovers the dead
  case well but cannot detect the hung case at all — `glusterfs` is not a
  `Type=notify` service, so `WatchdogSec=` does not apply. Adopting it also
  means dropping the fstab entry on four hosts and hand-rebuilding boot
  ordering for Docker, which risks cold boot on a setup that currently works.
  A timer covers both failure modes with one mechanism and is purely additive.
- Detection already exists. `roles/datadog/templates/custom_gluster_mount.py`
  runs `timeout 10 ls /mnt/gluster` every 60s and emits the
  `gluster.mount.healthy` service check, and the `datadog` group covers all
  four gluster clients. Only remediation is missing.
- `tart` is a `gluster_client` but not a `gluster_pool_server`, so it does not
  run `glusterd`. Units must not declare a dependency on `glusterd.service`.
- Every service on these hosts is a Docker Swarm stack bind-mounting subpaths
  of `/mnt/gluster` (mosquitto, temporal, jellyfin, vpn_ui, donetick, paper,
  …). Docker resolves bind mounts at container creation, so a container holds a
  reference to the *old* superblock across a remount. See "Out of scope".
- Deployments follow the existing role pattern: inline systemd unit files via
  `ansible.builtin.copy` with `content:`, notify handlers with named `listen:`
  events. See `roles/gluster_server/tasks/main.yml:97-144` for the directly
  analogous `gluster-recover` trio.

## Design

### Placement

New files live inside the existing `roles/gluster_client/` role, already
applied to the `gluster_client` group via `playbook.yml:52`. The `files/`
subdirectory does not exist yet and must be created.

Nothing existing changes — the fstab entry, the automount, and the Datadog
check are all left exactly as they are.

### Recovery script — `/opt/gluster-mount-recover.sh`

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

- **Probe is deliberately identical to the Datadog check** — `timeout N ls
  <mount>`, treating a non-zero exit or empty output as failure. Using the same
  test means the script acts on exactly the condition that alerts, with no
  drift where one says healthy and the other does not. `PROBE_TIMEOUT=20`
  is longer than the check's 10s so the script is the more conservative of the
  two.
- The `timeout` wrapper is what catches the hung case; a bare `ls` would block
  the systemd unit forever.
- Empty output is treated as failure because a successfully mounted `gv0` is
  never empty. This also catches the case where the automount point is exposed
  bare without the real mount on top.

#### Two-strikes guard

Recovery fires only after two consecutive failed probes, counted in
`/run/gluster-mount-recover.failures` (tmpfs, so it self-clears on boot). Any
successful probe resets the counter.

This exists because a false trip is expensive, not merely wasteful: remounting
makes every running container's bind mount stale, converting a transient blip
into a real outage worse than the blip itself. At a 2-minute cadence, sustained
failure still recovers within roughly 2–4 minutes, while one slow `ls` under
load costs nothing.

#### Remount sequence

`umount -l` is required rather than a plain `umount` because containers hold
the mount open and a normal unmount fails as busy. Lazy unmount detaches the
mountpoint immediately and lets the dead superblock drain as references are
released.

The `sleep 2` gives systemd time to observe the `mountinfo` change and mark
`mnt-gluster.mount` inactive before the restart is issued; without it there is
a race where `systemctl restart` still believes the unit is active. `restart`
is used rather than `start` so the sequence is correct from either state.

Because `mnt-gluster.automount` remains active throughout, the final `probe`
can itself retrigger the mount — the explicit restart and the probe together
cover both paths.

**This sequence must be verified on-host against a deliberately broken mount
during implementation**, including its interaction with the autofs layer. The
verification approach in `docs/superpowers/plans/2026-08-06-gluster-recover-timer.md:91`
is the model to follow.

#### Container recovery

After a successful remount the script restarts `docker.service`.

This is not optional polish — it is what makes the remount meaningful.
Containers resolve bind mounts at creation time, so after a remount they still
reference the old, dead superblock. An earlier revision of this spec assumed
containers that hit I/O errors would crash and be rescheduled by Swarm against
the fresh mount, leaving only silently-degraded containers as an accepted gap.
**Testing on `tart` disproved that.** With the FUSE client killed and the mount
recovered:

- All nine containers stayed up. None crashed or restarted.
- All three with binds under `/mnt/gluster` (`vaultwarden`, `vpn-ui`,
  `timelapse-viewer`) were confirmed broken inside the container while the host
  mount was healthy.
- `vaultwarden`'s Docker healthcheck reported `healthy` throughout, with its
  `/data` inaccessible.

Without a container restart the recovery is actively harmful: the host mount
goes green, `gluster.mount.healthy` clears, and services stay broken with no
remaining signal. The pre-existing behaviour — check stays red until a human
intervenes — is strictly better than that.

A daemon restart is the chosen mechanism because it is one command that works
identically on managers and workers and guarantees every container
re-resolves. Restarting only the containers with gluster binds would have a
smaller blast radius; the daemon restart was chosen deliberately over that.

The `systemctl is-active --quiet docker` guard keeps the script from failing on
a gluster client that does not run Docker. All four current clients do.

**Known risk, accepted:** restarting `docker.service` bounces every container
on the host, and on `pi`/`cannoli`/`gelato` — all Swarm managers — it briefly
drops raft participation. If a cluster-wide gluster outage resolves and all
three managers remount within the timer's 30s jitter of each other, all three
could restart Docker near-simultaneously and risk Swarm quorum. This is
accepted rather than mitigated.

### systemd service — `/etc/systemd/system/gluster-mount-recover.service`

```ini
[Unit]
Description=Gluster Mount Recovery

[Service]
Type=oneshot
TimeoutStartSec=300
ExecStart=/opt/gluster-mount-recover.sh
```

`Type=oneshot` so each run's success or failure is visible in `systemctl
status` and logs land in the journal. No `Requires=glusterd.service` — `tart`
does not run glusterd, and the client mount does not depend on a local server
in any case.

`TimeoutStartSec=300` raises systemd's default 90s start timeout. The recovery
path can spend 20s in each of two probes plus a full `docker.service` restart,
which with nine containers on a Pi can exceed 90s. At the default the unit
would be killed mid-restart, leaving Docker in a worse state than it started.
The healthy path is unaffected — it exits in well under a second.

The script exits non-zero only when a remount was attempted and did not take,
so a failed unit is a genuine signal rather than routine noise.

### systemd timer — `/etc/systemd/system/gluster-mount-recover.timer`

```ini
[Unit]
Description=Gluster Mount Recovery

[Timer]
OnCalendar=*:0/2
RandomizedDelaySec=30s

[Install]
WantedBy=timers.target
```

- Fires every 2 minutes. A dead client mount is more urgent than the offline
  brick that `gluster-recover.timer` handles hourly, and the probe is cheap
  when healthy.
- `RandomizedDelaySec=30s` staggers the four hosts so they do not probe or
  remount in lockstep. No per-host offset variable is needed — unlike
  `gluster-recover`, this script takes no distributed lock and has no
  cross-host interaction.
- `Persistent=true` is deliberately omitted. Catch-up runs are meaningless for
  a 2-minute health probe.

### Ansible tasks — append to `roles/gluster_client/tasks/main.yml`

All tagged `gluster_mount_recover`:

1. `copy` script to `/opt/gluster-mount-recover.sh` (owner root, mode
   `u=rwx,g=rx,o=rx`) — notify `gluster_mount_recover_reload`.
2. `copy` service unit inline — notify `gluster_mount_recover_reload`.
3. `copy` timer unit inline — notify `gluster_mount_recover_reload`.
4. `ansible.builtin.systemd` — enable and start `gluster-mount-recover.timer`.

### Ansible handler — append to `roles/gluster_client/handlers/main.yml`

```yaml
- name: reload gluster mount recover timer
  ansible.builtin.systemd:
    name: gluster-mount-recover.timer
    daemon_reload: true
    state: restarted
  listen: gluster_mount_recover_reload
```

### Deployment

```
task deploy --tags gluster_mount_recover
```

## Operational notes

- Manual trigger: `sudo systemctl start gluster-mount-recover.service`.
- Next fire times: `systemctl list-timers gluster-mount-recover.timer`.
- Logs: `journalctl -u gluster-mount-recover.service`.
- Current strike count: `cat /run/gluster-mount-recover.failures` (absent when
  healthy).
- Disable temporarily: `sudo systemctl stop gluster-mount-recover.timer`
  (survives until the next Ansible run, which re-enables it).

## Out of scope

- **Root-causing why the client dies.** The timer masks the symptom.
- **Alerting on repeated recoveries** as a signal that something is wrong.
  `gluster.mount.healthy` already alerts on the underlying condition.
- **Replacing the fstab mount with a supervised `glusterfs -N` service.**
  Rejected above; revisit only if the dead-client case proves frequent enough
  that a 2–4 minute recovery window is too slow.
