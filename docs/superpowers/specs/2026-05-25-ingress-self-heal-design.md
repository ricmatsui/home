# Ingress self-heal design

## Problem

`roles/ingress/files/ingress.sh` is a docker-event-driven state machine that toggles
between two mutually exclusive WireGuard modes (`vpn-host` / `vpn-peer`) sharing a
single UDP listen port. Each mode is owned by its own `wg-quick@<iface>.service`.

A real-world failure observed on `cannoli` (2026-05-26 02:26:40 UTC):

1. A swarm event caused `ingress.sh` to call `handle_peer`.
2. `systemctl stop wg-quick@vpn-host` returned 0, but the unit's `ExecStop`
   (`/usr/bin/wg-quick down vpn-host`) exited non-zero — the kernel interface
   `vpn-host` remained UP, holding UDP/51821.
3. `systemctl start wg-quick@vpn-peer` then looped forever in the systemd
   restart loop (`Restart=on-failure`, `StartLimitIntervalSec=0`), because
   `wireguard: vpn-peer: Could not create IPv4 socket` (`EADDRINUSE`).
4. `ingress.sh` exited `handle_peer` successfully (from systemctl's perspective)
   and went back to blocking on `docker events`. The host stayed in the broken
   state indefinitely — `vpn-host` interface alive but `INGRESS_IP` already
   stripped from the bridge, so neither mode actually serves traffic.

Two structural gaps caused this:

- **Trusting `systemctl stop`.** It returns 0 whenever the unit reaches an
  inactive *or* failed state, even if `ExecStop` aborted before deleting the
  kernel interface.
- **No reconciliation tick.** `ingress.sh` only acts on docker events. Once it
  has finished a handler, it does not re-check whether reality matches its
  intent until the next swarm change.

## Goal

Make `ingress.sh` self-heal from any `wg-quick` start failure (port conflict,
stale leftover interface, residual address, etc.) without manual intervention,
within one tick interval (~30s).

**Scope:** changes are limited to `roles/ingress/files/ingress.sh`. No new
systemd units, no changes to the `wg-quick@.service` override.

## Design

### Architecture

`ingress.sh` keeps its current shape — long-running daemon under
`ingress.service` (`Type=simple`, `Restart=always`). Two changes:

1. **Idempotent, self-cleaning handlers.** `handle_host` / `handle_peer`
   decompose into small `ensure_*` helpers that check current state and only
   act when reality diverges from intent. Each helper handles the cleanup
   needed before its corresponding `systemctl` operation.

2. **Periodic tick in the main loop.** The bare `docker events | while read`
   becomes `read -t TICK_SECS` over a `coproc`-managed docker events stream.
   Every tick (event *or* timeout) re-evaluates `get_state` and calls the
   appropriate handler. Idempotent helpers make ticks free when state matches.

`last_state` caching and any explicit `verify_state` step are dropped —
each `ensure_*` helper is its own verify-then-act, so there is no separate
cache to drift out of sync.

### Handlers and helpers

```bash
TICK_SECS=30

handle_peer() {
    ensure_down vpn-host
    ensure_address_absent
    ensure_up vpn-peer
}

handle_host() {
    ensure_down vpn-peer
    ensure_address_present
    ensure_up vpn-host
}

ensure_up() {
    local iface=$1
    systemctl is-active --quiet "wg-quick@$iface" && return 0
    echo "Starting wg-quick@$iface"
    if ip link show dev "$iface" &>/dev/null; then
        echo "Removing stale $iface interface"
        ip link delete dev "$iface"
    fi
    systemctl reset-failed "wg-quick@$iface" 2>/dev/null || true
    systemctl start "wg-quick@$iface"
}

ensure_down() {
    local iface=$1
    if systemctl is-active --quiet "wg-quick@$iface"; then
        echo "Stopping wg-quick@$iface"
        systemctl stop "wg-quick@$iface" || true
    fi
    if ip link show dev "$iface" &>/dev/null; then
        echo "Removing stale $iface interface"
        ip link delete dev "$iface"
    fi
    systemctl reset-failed "wg-quick@$iface" 2>/dev/null || true
}

ensure_address_present() {
    [[ -n "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]] && return 0
    echo "Adding $INGRESS_IP to $INTERFACE"
    ip addr add "$INGRESS_IP/24" dev "$INTERFACE"
}

ensure_address_absent() {
    [[ -z "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]] && return 0
    echo "Removing $INGRESS_IP from $INTERFACE"
    ip addr del "$INGRESS_IP/24" dev "$INTERFACE"
}
```

Key invariants enforced per helper:

- `ensure_up` early-returns when the unit is already active, so repeat ticks
  do not destroy and recreate a healthy interface.
- `ensure_down` always follows `systemctl stop` with a kernel-level check; if
  the interface survived (the exact failure mode observed), it force-deletes
  it. It then `reset-failed`s the unit so a subsequent `systemctl start` is
  not blocked by lingering failed state.
- `reset-failed` is also issued before any `systemctl start` to clear any
  prior failed/auto-restart state on the unit being started.
- Address helpers compare against `$INGRESS_IP/24` on `$INTERFACE` and act
  only on divergence.

Each helper logs only when it performs work, so a tick on a healthy host
produces no journal output.

### Main loop

```bash
coproc DOCKER_EVENTS { docker events --filter "label=$LABEL"; }

while true; do
    case "$(get_state)" in
        host) handle_host ;;
        peer) handle_peer ;;
    esac
    rc=0
    read -r -t "$TICK_SECS" -u "${DOCKER_EVENTS[0]}" _ || rc=$?
    if (( rc > 0 && rc <= 128 )); then
        echo "docker events stream ended"
        exit 1
    fi
done
```

Behavior:

- The handler runs once at startup (just as today), then on every loop
  iteration. Each iteration is either a docker event or a `TICK_SECS` timeout.
- `read -t` returns >128 on timeout (treated as "tick — re-evaluate") and
  non-zero ≤128 on EOF/error (treated as "events stream died — exit, let
  systemd restart us"). The latter preserves today's exit-on-stream-end
  behavior at `ingress.sh:75-76`.
- The existing `trap handle_peer ERR EXIT` is preserved so that any hard
  failure still leaves the host in the safer peer mode before exit.

### What is removed

- `last_state` variable and the `if [[ "$new_state" == "$last_state" ]]`
  short-circuit in the current `apply_state`.
- The `apply_state` wrapper itself — replaced by an inline `case` in the
  loop (kept thin because there is no caching to manage).

### What is preserved

- The "wait for `$INTERFACE` IPv4 to be present" gate at the top of the
  script — correct for first boot, no reason to change.
- `get_state`'s `docker ps --filter label=...` definition of "host vs peer".
- The `command -v docker` fallback (`apply_state peer; sleep infinity`) for
  hosts without docker. (Replace `apply_state peer` with `handle_peer` since
  `apply_state` is gone.)
- `trap handle_peer ERR EXIT`.

## Failure recovery, end-to-end

Replaying the cannoli incident under the new design:

1. Swarm event → `handle_peer` runs.
2. `ensure_down vpn-host` calls `systemctl stop`. Suppose `ExecStop` fails
   again and the kernel interface remains UP. The helper now sees
   `ip link show dev vpn-host` succeed and force-deletes it. Port 51821 is
   freed.
3. `ensure_address_absent` removes `INGRESS_IP` from the bridge.
4. `ensure_up vpn-peer` reset-failed's and starts the unit. With the port
   free, it comes up cleanly.

If for any reason step 4 still fails on this tick (e.g. transient kernel
error), the next tick — at most `TICK_SECS` later — re-runs the same
sequence with the same cleanup. The systemd restart loop on
`wg-quick@vpn-peer` continues its own retries in parallel; it succeeds as
soon as the kernel interface conflict is gone.

For the *already-broken* state captured in this spec, simply restarting
`ingress.service` after deploy — or waiting one tick — performs the
recovery.

## Out of scope

- Diagnosing *why* `wg-quick down vpn-host` failed on cannoli at 02:26:40 UTC
  (would require sudo `journalctl` from the host; tracked separately).
- Adding any new systemd timers, drop-ins, or wrapper scripts.
- Changing the `wg-quick@.service` override or its `Restart=on-failure`
  semantics.
- Changing inventory variables, peer key management, or the `vpn-host-sync`
  pipeline.

## Risks

- **Aggressive force-delete.** `ensure_down` deletes any kernel interface
  with the named iface even if something external created it. In this
  deployment only `wg-quick@<iface>` creates these interfaces, so the
  invariant holds; if that ever changes, this assumption breaks.
- **Tick interval log noise.** 30s ticks are silent on a healthy host (every
  helper short-circuits without printing). If the host enters a stuck state
  that the helpers cannot fix, each tick will repeat the same log line — a
  signal-of-stuck-ness rather than a regression.
- **Long-running `systemctl` calls.** `systemctl is-active` is local and
  fast; `systemctl stop` on a misbehaving `ExecStop` could in principle
  block. We rely on systemd's own timeouts; we do not add our own.
