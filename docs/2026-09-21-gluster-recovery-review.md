# Gluster recovery review

Written 2026-09-21, after the cannoli deaf-brick incident. Read-only review of
every recovery script in the fleet, a fault-case matrix, and what the
server-side recover would need to cover the gap that incident exposed.

Nothing here has been implemented. The only change on disk at the time of
writing is the throwaway-client probe added to
`roles/gluster_client/files/gluster-mount-recover.sh`.

## Context

A `glusterfsd` brick on cannoli stopped calling `accept()`. The process was
alive, listening, all threads sleeping, ext4 healthy and rw, `ls` on the brick
path fine, fds at 1184 of 1048576. `gluster volume status` reported Online = Y
throughout.

The kernel completes the TCP handshake on the brick's behalf, so clients
believed they had connected and then sat waiting for RPC that never came
(`rpc_clnt_ping_timer_expired ... has not responded in the last 42 seconds`).
The probe that revealed it was `Recv-Q` on the *listening* socket — the count
of completed connections waiting to be accepted:

    sudo ss -lnt 'sport = :<brick-port>'
    # LISTEN  Recv-Q 897  Send-Q 1024   0.0.0.0:57017    <- deaf

It climbed 575 -> 897 against a 1024 backlog in ~20 min. Past 1024 the kernel
drops SYNs outright.

The key discriminator was that **all** clients showed `connected = 0` for that
brick, including cannoli's own client to its own local brick. All clients
including localhost means brick-side, not network, not one bad client.

Fix was `kill -9` (the process ignored SIGTERM) then `gluster volume start gv0
force`. It respawned on a new port, clients rediscovered it via glusterd in
~25s, and heal drained 1984 -> 0 unattended.

### The cascade

`gluster-mount-recover.sh` detected the wedge and force-remounted the *client*,
which can never fix a brick-side fault. It then failed its own
`all_bricks_connected` check and `exit 1`'d — which happens to be *before* its
own `systemctl restart docker` step. Each attempt orphaned a superblock and
then left without doing the one thing that would repair the fallout.

Containers resolve bind mounts at creation, so they stayed pinned to dead
superblocks — not crashing, just taking ENOTCONN on every I/O. 12 containers on
cannoli were stranded, including three Postgres instances and gitea.

Proof technique, host vs container on the same file — the disagreement is the
diagnosis:

    sudo head -c 16 /mnt/gluster/<path>         # host, fresh mount -> OK
    sudo docker exec <cid> head -c 16 /<dest>   # container -> ENOTCONN

Knock-on: gitea's SQLite lives on gluster, so a stranded gitea 500s on
`GetUserByName` -> the container registry 401/500s -> unrelated services fail
to pull with "No such image" and show Rejected. temporal-db looked like a
registry problem and was actually a storage problem.

## Fault matrix

`connected` is the client's `.meta` link state. `ls` probe is the shared
`timeout N ls /mnt/gluster` used by both the recover script and the Datadog
check.

| # | Case | `volume status` | client `connected` | `ls` probe | What fires today | Verdict |
|---|---|---|---|---|---|---|
| 1 | Client process dead (ENOTCONN) | Y | — | fails | 2 strikes -> fresh probe -> clean -> remount + docker restart | works |
| 2 | Client hung (I/O blocks) | Y | — | times out | same as 1 | works |
| 3 | Client partially wedged (1 brick lost, FUSE queue piling) | Y | 0 for that brick | passes | `disconnected` + `waiting>=1` -> 2 strikes -> fresh probe decides | works |
| 4 | Peer host legitimately rebooting | 0 | 0 for that brick | passes | queue empty -> "quorum still serving", no action | correct |
| 5 | Brick process dead / offline | 0 | 0 | passes | `gluster-recover` hourly -> `volume start force`; client refuses to remount | correct split |
| 6 | **Brick deaf** (listens, never `accept()`s) | **Y** | **0 on all clients incl. localhost** | passes or times out | `gluster-recover` sees 0 offline -> no-op. Client refuses to remount, exits 0 | **nothing remediates, nothing alerts** |
| 7 | Brick accepts, RPC stalled (io-threads exhausted, lock deadlock) | Y | **1** | times out | fresh probe handshakes fine -> reports *clean* -> remount + docker restart, every ~4 min, forever | **harmful loop** |
| 8 | Brick disk hung (D-state, USB drop) | Y | **1** | times out | same as 7 | **harmful loop** |
| 9 | Brick ext4 remounted read-only | Y | 1 | **passes** | nothing — reads fine, writes EROFS | invisible |
| 10 | Whole volume down everywhere | 0 | 0 | fails | fresh probe fails or sees all down -> refuse, exit 0 | correct but silent |
| 11 | Split-brain / gfid mismatch (per-file EIO) | Y | 1 | passes | nothing automated; manual via the split-brain skill | by design |
| 12 | Heal backlog | Y | 1 | passes | nothing; Datadog `glusterfs` (gstatus) only | by design |
| 13 | Brick respawned on new port | Y | 0 for ~25s | passes | `settle_bricks` waits 15s -> may refuse spuriously once | benign |

The structural point: **`connected` is a link-establishment signal, not a
serving signal.** That is why the throwaway-client probe discriminates case 6
(handshake never completes, so a brand-new client also reports `connected = 0`)
but not cases 7-9 (handshake completes, so a fresh client looks perfect while
the brick serves nothing).

## Three fault domains

It is not a client/server split, it is a question of who owns the fault domain.

| Domain | Fixable by | Owner today |
|---|---|---|
| The mount (client-local superblock/process) | remount + docker restart | `gluster-mount-recover.sh` |
| The brick (one host's glusterfsd) | process-level fix on that host | `gluster-recover.sh`, partially |
| The volume (glusterd, quorum, cluster lock) | glusterd restart, peer ops | **nobody** |

The discipline that makes the split work is that each layer can say "not mine".
The throwaway-client probe just gave the client that ability. The server side
has no such ability — one signal, and it cannot distinguish "brick not running"
from "brick running but useless".

The client's refusal currently dead-ends at `exit 0` rather than escalating, so
there is no handoff. A handoff needs no message bus: pi, cannoli and gelato are
in **both** `gluster_pool_servers` and `gluster_client`, so the server script
can read the same local evidence for free. tart is client-only, so for any
brick-side fault its refusal is permanently unactionable locally — which is
fine as long as the server half actually acts.

## Client side: `gluster-mount-recover.sh`

### Decision tree as deployed

```
ls /mnt/gluster
├─ fails ─────────────────► strike++ ──► <2: defer
│                                        >=2: recover()
└─ passes
   └─ any brick connected = 0?
      ├─ no  ──────────────► healthy, reset strikes
      └─ yes
         └─ FUSE waiting queue
            ├─ unreadable ─► leave alone, reset
            ├─ 0 ─────────► "quorum still serving", reset   (case 4)
            └─ >=1 ───────► strike++ ──► >=2: recover()

recover()
└─ mount throwaway client, settle 15s, read its .meta
   ├─ mount failed / fstab unreadable ─► refuse, reset strikes, exit 0   SILENT
   ├─ fresh client also sees brick down ► refuse, reset strikes, exit 0   SILENT (case 6)
   └─ fresh client clean
      └─ umount -f -l ; restart mnt-gluster.mount
         ├─ probe fails ───────────────► exit 1   containers stranded, docker NOT restarted
         ├─ bricks still disconnected ─► exit 1   containers stranded, docker NOT restarted
         └─ ok ───────────────────────► restart docker
```

Two things this makes visible:

- **The original cascade is narrowed, not closed.** Both `exit 1` arms still
  unmount first and leave before the docker restart. The probe prevents
  *reaching* them in the brick-side case, but a brick that goes deaf *during*
  the remount still strands every container on that host.
- **Refusal and inconclusive-probe look identical to systemd** — both `exit 0`.
  A host that has silently stopped self-healing is indistinguishable from a
  healthy one.

### Findings

#### 1. `disconnected_bricks` cannot say "I don't know", and the probe bets a remount on that

`roles/gluster_client/files/gluster-mount-recover.sh:51-60` returns empty
output and exit 0 in three distinct situations: all bricks connected, `.meta`
absent entirely, and every read timing out. Verified:

```
no .meta at all      -> rc=0 output='[]'
all three bricks 'connected = 0' on disk, every read times out:
  disconnected_bricks  -> rc=0 output='[]'
  all_bricks_connected -> TRUE  (reports healthy)
```

The mechanism is `if timeout ... grep -qs` at `:56`. `timeout` exit 124 makes
the `if` false, and a false `if` with no `else` yields 0. A hung read is
counted as a connected brick.

Before the probe existed this fail-open direction was safe — an unreadable
`.meta` at `:194` meant "mount healthy, do nothing". Now the same empty string
flows into `fresh_client_disconnected_bricks` at `:100` and reads as "the fresh
client is clean, go ahead and remount". The one case where the evidence is
missing is the case that authorizes the destructive action. A probe client that
mounts but is itself wedged — plausible when the brick is deaf, since the new
client connects to that same brick — produces exactly this.

Fix: three-state semantics. Enumerate the `*-client-*` entries, assert the
count equals the replica count (3), assert each read succeeded, assert each
says `connected = 1`. Anything else is inconclusive, not clean.

#### 2. The refusal path resets the strike counter, so the probe re-fires every 4 minutes forever

Both refusal branches (`:144`, `:150`) `rm -f "$STATE_FILE"`. While a brick is
deaf and the FUSE queue is non-empty:

| run | failures | action |
|---|---|---|
| 1 | 1 | defer |
| 2 | 2 | `recover()` -> probe mount -> refuse -> **reset to 0** |
| 3 | 1 | defer |
| 4 | 2 | probe mount -> refuse -> reset |

One throwaway gluster client mounted every 4 minutes per host, on 4 hosts —
roughly **60 fresh client connections per hour to the deaf brick's listening
socket**, the queue that was already at 897 of 1024.

Whether each probe permanently consumes a slot depends on whether the client's
close sends FIN or RST: a queued connection that receives FIN stays in the
accept queue until `accept()` (which never comes), while an RST removes it.
Undetermined from the repo — see open questions. But the risk is structural:
**the diagnostic can accelerate the fault it diagnoses, and it fires most often
in exactly that fault.**

Fix: do not reset on refusal. Write a separate brick-side marker with a
timestamp and back the probe off to at most once per 30 min.

#### 3. Every probe writes a new log file in `/var/log/glusterfs`

`mount -t glusterfs` with no `log-file` option derives the log name from the
mountpoint path. `mktemp -d` produces a unique path per run, so each probe
creates a fresh, never-rotated log file — at the cadence above, ~360/day/host.

Fix: fixed probe directory under `/run` instead of `mktemp`, plus explicit
`-o log-file=`. A fixed path also makes a leaked mount detectable and reusable
instead of accumulating; handle the stale case with `mountpoint -q` plus a
force-unmount at entry.

#### 4. No cleanup trap, so a killed run leaks a mount and a client process

Between `mount` (`:98`) and `umount` (`:105`) there is no trap.
`gluster-mount-recover.service` is `Type=oneshot` with default
`KillMode=control-group`, so if `TimeoutStartSec=300` fires, systemd SIGKILLs
the whole cgroup including the backgrounded `glusterfs` client — leaving a
mount entry on a temp path and a client holding connections to all three
bricks. Compounds finding 2.

Fix: `trap` on EXIT to unmount and remove.

#### 5. `TimeoutStartSec=300` is now too tight

The design spec sized 300s for "20s in each of two probes plus a full
`docker.service` restart ... which with nine containers on a Pi can exceed 90s",
and warned that hitting the timeout kills the unit mid-restart and "leaves
Docker in a worse state than it started."

The probe adds up to 20s (mount) + 15s (`settle_bricks`) + grep time on the
*front* of the remount path. That margin is gone.

Fix: raise to 600 in `roles/gluster_client/tasks/main.yml:50`.

#### 6. Fail-closed refusals exit 0, so nothing notices

`:143` and `:149` both `exit 0`. The spec's own contract was "the script exits
non-zero only when a remount was attempted and did not take, so a failed unit
is a genuine signal". The new refusal states break that in the safe direction
but also in the silent direction.

Refusal is the correct action; it should be loud. Exit non-zero so Datadog's
`systemd` check sees the failed unit. This is the cheapest interim deaf-brick
alert available.

#### 7. Remount + docker-restart loop with no cooldown (cases 7, 8)

There is no state recording that a remount happened. After a successful
recovery the strike file is removed and the script exits 0. If the underlying
fault is one the probe cannot see (brick connected but not serving), the next
run fails the `ls` probe again, and ~4 minutes later the host performs another
unmount, remount and **full docker daemon restart**. Unbounded, on every client.

This is pre-existing, not introduced by the probe, and it is the
highest-severity remaining gap on the client side.

Fix: record that a remount occurred; if the probe fails again within N minutes,
stop and exit non-zero instead of remounting.

#### 8. Smaller notes

- `findmnt --fstab` at `:93` is the right call and the comment correctly
  documents the autofs-shadowing trap. `findmnt -n -o SOURCE /mnt/gluster`
  returns two lines because `x-systemd.automount` leaves an autofs entry that
  shadows the fuse one — the same trap the existing `fuse_minor()` comment
  documents.
- `settle_bricks` inherits finding 1: `all_bricks_connected` returns true on
  unreadable state, so it can return 0 immediately having proved nothing.
- `--dry-run` now has side effects — `record_failure:118` really mounts a
  gluster client. Manual-only, not wired to any timer, but worth documenting.
- This file is deliberately commented (commit `cc37fa3`). The scheduler family
  is bare. Match per file.

## Server side: `gluster-recover.sh`

26 lines: parse `gluster volume status gv0 --xml`, count nodes whose `path`
starts with `/` and whose `status` is `0`, and if any, run `gluster volume
start gv0 force`. Runs on all three pool servers, hourly, offset :00/:20/:40
via `gluster_recover_offset_minutes` in sops host_vars.

### What it covers

| Condition | Detected? | Remediated? |
|---|---|---|
| Brick process not running | yes, `status == 0` | yes, `volume start force` |
| Brick deaf (listening, no `accept()`) | **no** — reports Online = Y | no |
| Brick RPC-stalled / disk hung | **no** — reports Online = Y | no |
| Brick ext4 read-only | no | no |
| glustershd / bitd / scrub down | **no** — filtered out by design | no, though `volume start force` would fix it |
| glusterd wedged or deaf | no | no |
| Brick path (`/mnt/external/gluster`) not mounted | partially (brick will not start) | no — force-start cannot fix it, retries hourly forever |

The self-heal daemon row is an outright oversight rather than a known gap.
`path.startswith("/")` at `:16` exists to exclude daemons, which report
`path="localhost"` — but that filter also discards the only signal that shd is
down. Heals silently stop, and the action the script already takes would have
fixed it.

### Robustness holes

**No verification.** `:23` fires `volume start force` and exits. It never
re-checks whether the brick came back. Exit status says "I ran the command",
not "it worked". The client script is strictly more rigorous here — it probes
after remounting and exits 1 if it did not take. That asymmetry is backwards,
given the server side takes cluster-wide actions.

**No rate limit, no escalation.** If a brick is offline for a reason
force-start cannot repair — the external disk not being mounted is the
realistic one — the script bounces bitd and scrub hourly, forever, with no
"I have tried this 24 times" state.

**No identity.** `:18` prints a *count*. Which brick, on which host, on which
port — all discarded, and the port is right there in the XML. Anything more
targeted than a global force-start needs it; a Recv-Q check needs it
specifically.

**Wrong shape for anything invasive.** All three hosts detect a cluster-wide
condition and issue a cluster-wide fix. That is why the :00/:20/:40 offsets
exist (glusterd distributed lock — concurrent invocations hit "Another
transaction is in progress", worst case leaving a stale lock that needs
`systemctl restart glusterd`). It does not extend to `kill -9`, which must be
local to the brick's owner.

**Cadence coupled to the wrong constraint.** Hourly, because force-start takes
the lock. Detection is lock-free and cheap. A deaf brick strands containers in
minutes while the client script runs every 2.

**`Persistent=true` defeats the offsets after a fleet-wide power event.** All
three pool servers boot at once and fire their missed run immediately.
`RandomizedDelaySec=60s` does not cover a 20-minute offset.

**Fails opaquely.** If glusterd does not answer, `timeout 30` kills it, python
gets empty stdin, `ET.fromstring("")` raises, and with `pipefail` + `set -e`
the unit fails with a traceback rather than "glusterd is not answering". A
wedged glusterd shows up as a broken recovery script rather than as the fault
it is.

**No `--dry-run`,** unlike the other two recovery scripts. That matters
specifically now: a new detector cannot be validated against a live cluster
before it is allowed to act.

### What it should look like

Same shape the client script already has — detect, debounce, prove it is mine,
act, verify.

1. **Detect per-brick, not per-count.** Keep `status == 0`, add the
   disagreement rule below. Stop filtering daemons out of the health view.
2. **Prove it is local.** Only act on the brick this host owns; confirm with
   Recv-Q on that brick's own listening socket.
3. **Gate on quorum.** Refuse any process-level action unless every *other*
   brick is healthy. This is what keeps a misfire from taking the volume to
   1-of-3 during a rolling reboot.
4. **Act in escalating order:** `volume start force` (safe, already there) ->
   `TERM`, wait 30s, `KILL` the brick -> force-start again. Expect to need the
   escalation; the deaf brick ignored SIGTERM.
5. **Verify and rate-limit.** Re-check after acting; exit non-zero if it did
   not take. Cap at one process kill per brick per 6h, give up after two in
   24h.
6. **Add glusterd liveness** as a separate small check. A deaf glusterd means a
   respawned brick's new port never reaches clients, which silently defeats
   step 4.

Steps 1, 5 and 6 are worth doing even if the kill is never enabled — they are
the difference between a script that fires a command and one that tells you
whether the cluster is actually serving.

## Detection research

### Fault classes in the gap

| class | `volume status` | client `.meta` | Recv-Q | disk |
|---|---|---|---|---|
| deaf brick (no `accept()`) | Online=Y | all clients `connected = 0` | climbing | fine |
| brick accepting, RPC stalled | Online=Y | `connected = 1`, I/O hangs | 0 | fine |
| underlying disk hung (D-state) | Online=Y | `connected = 1`, I/O hangs | 0 | hung |
| ext4 remounted read-only | Online=Y | `connected = 1` | 0 | reads OK, writes EROFS |
| network blackhole (MTU, conntrack full) | Online=Y | *some* clients `connected = 0` | maybe | fine |

Recv-Q is specific to the first row only. It is not a general liveness signal —
rows 2-4 all show Recv-Q 0.

### The best signal was already observed during the incident

`gluster volume heal gv0 info summary` reported "Transport endpoint is not
connected" for the deaf brick while showing Connected for the others. That is a
**real RPC round-trip to every brick**, from one host, in one command. It
answers the actual question — "is this brick serving?" — rather than a proxy
for it.

The discriminator that excludes legitimate churn is the **disagreement between
two views**:

> `gluster volume status gv0` says a brick is Online = Y **and**
> `gluster volume heal gv0 info summary` says that same brick is not connected.

A brick whose host is rebooting fails both — `status` reports it offline too,
so the pair does not match. Only "glusterd thinks it is running, but nothing
can talk to it" produces the disagreement. No new tooling, no `.meta` parsing,
no `ss`, runs entirely on a pool server.

Caveats: `heal info` can be slow (1984 pending entries during the incident) —
wrap in `timeout 60`, in the spirit of the existing `timeout 30` on `volume
status`. It also transiently reports not-connected during a legitimate brick
respawn, which is what the debounce is for.

### A second, free corroborator

pi, cannoli and gelato are in both `gluster_pool_servers` and `gluster_client`,
so `gluster-recover.sh` can read the local client's
`/mnt/gluster/.meta/graphs/active/*-client-*/private` at zero cost — the same
file the client script already parses. Same disagreement rule: glusterd says
`status = 1`, local client says `connected = 0`. The incident's key insight was
that *all* clients including localhost showed `connected = 0`, and localhost is
the view a pool server has for free.

Inherits finding 1, so fix the three-state semantics first — the helper would
need to be shared or reimplemented.

### Is Recv-Q safe to automate on?

As a **confirmation gate**, yes. As a **trigger**, no.

On a healthy brick `accept()` is immediate, so Recv-Q on the listening socket
is ~0 essentially always; a mount storm produces a spike that drains in
milliseconds. So the false-positive rate on a sustained reading is very low.
But a single sample is noisy, and it covers only one fault class.

If used: non-zero on **three consecutive samples >=30s apart**, a small floor
(>=5) to absorb a genuine connect burst, and **monotonically non-decreasing**
across those samples — a draining queue is a busy brick, a growing queue is a
deaf one. The incident's second signal is equally cheap and worth pairing:
kernel ESTABLISHED count for the port (64) far exceeding the socket fds the
process actually held (19).

The check must run **on the host owning the brick**, reading its own socket,
with the port taken from `gluster volume status --xml`'s `<port>`.

### Should remediation be automatic?

Yes, but gated on three preconditions, and only for the brick the host owns.

Blast radius:

- `kill -9` on one brick under replica-3 with `cluster.quorum-type: auto` is
  safe in isolation — the volume keeps serving from two replicas, in-flight
  writes fail over, and heal reconciles (observed: 1984 -> 0 unattended).
- **The dominant risk is killing the second brick.** If the detector misfires
  while another brick is already down — rolling reboot, the monthly ~14:0x
  gelato kernel reboot, a deploy — dropping to 1-of-3 trips `quorum-type: auto`
  and blocks writes fleet-wide. Far worse than the fault being fixed.
- A misfire loop is the other scary mode: kill -> respawn -> detector still
  unhappy -> kill again.

Hence:

1. **Hard quorum precondition.** Refuse unless every *other* brick reports both
   `status = 1` and connected. Non-negotiable; this alone removes the
   fleet-outage scenario.
2. **Debounce.** Two detections >=2 minutes apart, so a brick respawning on a
   new port (clients rediscover in ~25s) is never mistaken for a deaf one.
3. **Rate limit, fail visible.** At most one remediation per brick per 6h; give
   up with a non-zero exit after two in 24h. `/run` is acceptable state — a
   reboot of the brick host is itself a remediation.

`volume start force` remains the only step taking the glusterd distributed
lock, so the existing offset discipline still applies to it and nothing new is
needed there.

Given the fleet already auto-runs `volume start force` and auto-restarts
docker, this is consistent with the existing appetite. The conservative variant
is to ship detection plus a failing unit first and watch it for a few weeks
before enabling the kill.

## Adjacent scripts

### `docker-network-recover.sh` — no "docker recently restarted" guard

The script's own comment (`:14-16`) states the correct theory: a `vx-*`
interface appears in the host namespace transiently during normal operation,
and the two-sighting rule exists to avoid mistaking that window for a leak.

But sightings are 2 minutes apart, and the window is *widest* during a docker
daemon restart, when many overlay networks are rebuilt at once on a Pi.
`gluster-mount-recover.timer` and `docker-network-recover.timer` carry
**identical** `OnCalendar=*:0/2` and `RandomizedDelaySec=30s`, so on any host
where gluster recovery restarts docker, network-recover is near-certain to
sample during the rebuild — possibly twice — and `ip link delete` an interface
docker is actively moving.

Fix: skip when docker started recently, e.g. gate on
`systemctl show docker -p ActiveEnterTimestamp` being more than ~5 minutes old.
Also covers Ansible deploys and manual restarts. Three lines.

### `scheduler.sh` — recovery-induced scaling churn

No node-health precondition. While a host restarts docker its node goes `Down`
from the leader's view; tasks there stop counting, so `running < replicas` and
a deficit timestamp is recorded (`:62-75`). Many fleet services carry
`restart_policy.delay: 10m`, so that deficit survives ~10 minutes.
`deficit_threshold_seconds=1200` gives 20 minutes of headroom, so a single
clean restart rides it out — but two hosts recovering, or a slow image pull,
crosses it, and the scheduler then **scales down an unrelated donor service to
free capacity that was never scarce** and is about to come back.

Fix: exit early when any swarm node is not `Ready`/`Active`, in the same style
as the existing leader check. Makes the whole scheduler stand down during any
recovery.

Minor: `docker service inspect "${service_ids[@]}"` (`:26`) runs inside process
substitution, so a service removed between `ls` and `inspect` yields partial
output with its exit code swallowed.

Note on restart delays: the fleet-wide "10m" figure is not universal. traefik
is 5s, mosquitto/selenium 5m, reader/homepage 30s, doorbell/planner 1m, while
paper, donetick, vpn_ui, actual, jellyfin and temporal's main service are 10m.

### `ingress.sh` — the mechanism behind "docker restart severs ingress"

`get_state` (`:70-78`) calls `docker ps`, which exits non-zero while the daemon
is restarting. Reproduced:

```
ERR:return 1
ERR:ids=$(docker ps -q --filter "label=x")
GET_STATE_CONTINUED
AFTER: state=<<HANDLE_PEER_RAN
host>>
REACHED_END
```

Three things happen, none intended:

1. `trap ... handle_peer ERR` (`:67`) fires **inside the command substitution**
   — the tunnel is torn down and `INGRESS_IP` is removed from the interface
   (`:47-53`). Every peer in the fleet loses its WireGuard endpoint. This is
   the fleet-wide SSH severing.
2. `handle_peer`'s stdout is captured into `ids`, making it non-empty, so
   `get_state` returns `host` — the opposite of reality.
3. That garbage also lands in `$state`, so `case "$state"` in
   `apply_current_state` (`:91-94`) matches **neither** arm and no handler
   runs. `last_state` is set to the garbage string.

Recovery happens only via process exit -> `Restart=always`. `ingress.service`
has no `StartLimitIntervalSec=0` (unlike `wg-quick@`, which does); `RestartSec=5s`
keeps it under the default 5-in-10s burst limit, but with no margin.

Fix: make `get_state` distinguish "docker is not answering" from "traefik is
not running here". If `docker ps` fails, hold the current state and skip the
tick. That decouples ingress from any docker restart entirely — removing the
blast radius rather than scheduling around it. Highest value-per-line change in
this document. Also route `handle_peer`'s diagnostics to stderr so a handler
can never contaminate a command substitution again.

### `backup-mount.sh` / `backup-unmount.sh` — partial failure strands the operator

Manual and interactive, so the bar is lower, but there is a real gap.
`backup-mount.sh` has no rollback: if `luksOpen` succeeds for `backup-1a` and
fails for `backup-1b` (`:30-32`), or the first `mount` succeeds and the second
fails (`:35-37`), `set -e` aborts leaving LUKS devices open and/or bricks
mounted.

The operator's natural next move — run `backup-unmount.sh` — fails immediately
at `mountpoint -q "$MOUNT"` (`:15-18`) because the FUSE mount was never
reached. **There is no scripted path back from a partial mount.**

Lock-contention interaction: `backup-unmount.sh:24` runs
`gluster --mode=script volume stop backup`, which takes the glusterd cluster
lock. pi's `gluster-recover.timer` fires at :00 every hour and may hold that
lock. A collision aborts the unmount script under `set -e` at exactly the point
where LUKS devices are still open.

Fix: trap-based rollback in mount; make unmount tolerant of partial state
(unmount what is mounted, close what is open, skip what is not) rather than
bailing at the first guard.

### Concurrency, generally

systemd will not run two instances of the same `Type=oneshot` unit
concurrently, so none of these scripts can overlap *themselves*. And `volume
start force` racing a client remount is benign — force-start only respawns
missing brick processes, and clients tolerate it.

The real gaps are cross-script: docker-network-recover sampling during a
gluster-triggered docker restart, scheduler scaling during one, and
`backup-unmount.sh` colliding with the hourly force-start on the glusterd lock.
None need a distributed lock — each is fixable with a local precondition. Do
not introduce fleet-wide locking for this; the failure modes are all "act
during someone else's recovery", and "check whether recovery is in progress" is
cheaper and more debuggable.

One genuine benefit of the throwaway-client probe worth recording: the spec
accepted the risk that "if a cluster-wide gluster outage resolves and all three
managers remount within the timer's 30s jitter of each other, all three could
restart Docker near-simultaneously and risk Swarm quorum." The brick-side
refusal means a genuinely cluster-wide fault no longer triggers three
simultaneous remounts — all three clients will refuse. The change reduces that
risk.

## Recommendations, prioritized

### Fix first — correctness of what is already deployed

1. Give `disconnected_bricks` three-state semantics and make
   `fresh_client_disconnected_bricks` demand positive evidence (3 client
   entries, all read, all `connected = 1`) before authorizing a remount.
   *(Finding 1 — an unreadable probe currently reads as a green light.)*
2. Stop resetting the strike counter on brick-side refusal; back the probe off
   to <=1 per 30 min per host. *(Finding 2 — the probe currently feeds the deaf
   brick's accept queue every 4 min from every host.)*
3. Add a remount cooldown: if the probe fails again within N minutes of a
   remount, stop and exit non-zero instead of remounting. *(Finding 7 — cases
   7 and 8 currently loop unbounded.)*
4. Fixed probe dir under `/run`, explicit `-o log-file=`, EXIT trap for
   cleanup. *(Findings 3, 4.)*
5. Raise `TimeoutStartSec` to 600 on `gluster-mount-recover.service`.
   *(Finding 5.)*
6. Make brick-side refusal exit non-zero so the failed unit is visible to
   Datadog's systemd check. *(Finding 6 — interim deaf-brick alert, nearly
   free.)*
7. Move the docker restart so it runs whenever an unmount occurred, success or
   not. *(Closes the remaining arm of the original cascade.)*

### Then the interaction guards — each a few lines, each independently valuable

8. `ingress.sh`: hold state when `docker ps` fails instead of flipping to peer.
9. `docker-network-recover.sh`: skip when docker started within the last ~5 min.
10. `scheduler.sh`: exit early when any swarm node is not Ready/Active.

### Then the new capability

11. Extend `gluster-recover.sh` with a deaf-brick detector: `volume status`
    says Online = Y **and** `heal info summary` says not-connected,
    corroborated by the local client's `.meta` view, confirmed on the owning
    host by a growing Recv-Q. Detection is lock-free and wants a shorter
    cadence than the hourly force-start, so split the timer: frequent
    detection, offset remediation.
12. Remediation (`TERM` -> `KILL` -> `volume start force`) behind the three
    preconditions above, on the host owning the brick only.
13. Stop filtering daemons out of the server-side health view so a down
    glustershd is detected.
14. Add a glusterd liveness check.
15. Add `--dry-run` to `gluster-recover.sh` so a new detector can be validated
    before it acts.

### Lower priority

16. `backup-mount.sh` rollback trap; make `backup-unmount.sh` tolerate partial
    state.
17. Retry `volume start force` on "Another transaction is in progress" instead
    of failing the unit; reconsider whether `Persistent=true` is worth the
    post-power-event convergence risk.
18. Canary write+fsync rather than `ls` alone, so a read-only brick is visible.

## Open questions needing on-host measurement

- **Does a probe client's unmount reclaim its accept-queue slot?** Depends on
  FIN vs RST on close. Measure `Recv-Q` across probe cycles against a real deaf
  brick. Determines how severe finding 2 actually is.
- **How long does the probe add to the real remount path on a Pi?** Sizes the
  `TimeoutStartSec` bump in recommendation 5.
- **Does `gluster volume start <vol> force` return non-zero when an individual
  brick fails to start?** If it returns success, the hourly retry loop against
  an unmountable brick path is silent as well as futile.
- **How expensive is `heal info summary` on gv0 under load?** Sizes the
  `timeout` and the detector's cadence.

## References

- `roles/gluster_client/files/gluster-mount-recover.sh`
- `roles/gluster_server/files/gluster-recover.sh`
- `roles/docker/files/docker-network-recover.sh`
- `roles/scheduler/files/scheduler.sh`
- `roles/ingress/files/ingress.sh`
- `roles/backup/templates/backup-mount.sh`, `backup-unmount.sh`
- `docs/superpowers/specs/2026-08-06-gluster-recover-timer-design.md`
- `docs/superpowers/specs/2026-08-07-gluster-mount-recover-timer-design.md`
