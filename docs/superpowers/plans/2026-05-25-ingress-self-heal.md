# Ingress Self-Heal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `roles/ingress/files/ingress.sh` so the ingress service self-heals from any `wg-quick` start failure (port conflict, stale interface, residual address) within one tick interval (~30s), without changes outside that file.

**Architecture:** Replace the docker-events-only blocking read with a `coproc`-managed events stream wrapped in a `read -t TICK_SECS` loop. Decompose `handle_host` / `handle_peer` into small idempotent `ensure_*` helpers that verify and reconcile each piece of state independently. Drop the `last_state` cache — each helper is its own verify-then-act, so periodic ticks are free when reality matches intent.

**Tech Stack:** Bash 4+, systemd (`systemctl`, `wg-quick@.service`), iproute2 (`ip link`, `ip addr`), Docker (event stream), Ansible (deployment via `task deploy`).

**Reference spec:** `docs/superpowers/specs/2026-05-25-ingress-self-heal-design.md`

---

## File Structure

Only one source file changes:

- **Modify:** `roles/ingress/files/ingress.sh` — full rewrite (~75 lines, replaces current ~77).

No other files are touched. The Ansible role copies this script to `/opt/ingress.sh` and bounces `ingress.service` via the existing `ingress_service_restart` handler (`roles/ingress/handlers/main.yml:15-20`) — so a normal `task deploy` is the deployment vehicle.

---

## Task 1: Rewrite `ingress.sh` with idempotent helpers and tick loop

**Files:**
- Modify: `roles/ingress/files/ingress.sh` (full replacement)

- [ ] **Step 1: Capture current broken-state evidence on `cannoli` (the "failing test")**

Run from your workstation:

```bash
TERM=xterm /usr/bin/ssh cannoli '
  echo "=== wg interfaces ==="
  ip -br link show type wireguard
  echo "=== unit states ==="
  systemctl is-active wg-quick@vpn-host wg-quick@vpn-peer ingress 2>&1
  echo "=== restart counter ==="
  systemctl show wg-quick@vpn-peer -p NRestarts --value
'
```

Expected (current broken state): `vpn-host` interface UP, `wg-quick@vpn-host` = `failed`, `wg-quick@vpn-peer` = `activating`, restart counter in the hundreds. Save this output — you'll re-run after deploy to prove recovery.

- [ ] **Step 2: Replace `roles/ingress/files/ingress.sh` with the new implementation**

Overwrite the entire file with:

```bash
#!/bin/bash
set -Exeuo pipefail

LABEL="com.docker.swarm.service.name=traefik_traefik"
TICK_SECS=30

until ip addr show dev "$INTERFACE" | grep -q "inet "; do
    echo "Waiting for interface..."
    sleep 1
done

ensure_up() {
    local iface=$1
    if systemctl is-active --quiet "wg-quick@$iface"; then
        return 0
    fi
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
    if [[ -n "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]]; then
        return 0
    fi
    echo "Adding $INGRESS_IP to $INTERFACE"
    ip addr add "$INGRESS_IP/24" dev "$INTERFACE"
}

ensure_address_absent() {
    if [[ -z "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]]; then
        return 0
    fi
    echo "Removing $INGRESS_IP from $INTERFACE"
    ip addr del "$INGRESS_IP/24" dev "$INTERFACE"
}

handle_host() {
    ensure_down vpn-peer
    ensure_address_present
    ensure_up vpn-host
}

handle_peer() {
    ensure_down vpn-host
    ensure_address_absent
    ensure_up vpn-peer
}

trap handle_peer ERR EXIT

get_state() {
    local ids
    ids=$(docker ps -q --filter "label=$LABEL")
    if [[ -n "$ids" ]]; then
        echo "host"
    else
        echo "peer"
    fi
}

apply_current_state() {
    case "$(get_state)" in
        host) handle_host ;;
        peer) handle_peer ;;
    esac
}

if ! command -v docker; then
    handle_peer
    sleep infinity
fi

coproc DOCKER_EVENTS { docker events --filter "label=$LABEL"; }

while true; do
    apply_current_state
    rc=0
    read -r -t "$TICK_SECS" -u "${DOCKER_EVENTS[0]}" _ || rc=$?
    if (( rc > 0 && rc <= 128 )); then
        echo "docker events stream ended"
        exit 1
    fi
done
```

Key invariants in this version (each enforced by one helper):

- `ensure_up` early-returns if the unit is already active → repeat ticks don't tear down a healthy interface.
- `ensure_down` always verifies the kernel interface is gone after `systemctl stop`, force-deleting if not — this is the specific fix for the cannoli failure mode.
- `reset-failed` runs before any `systemctl start` to clear lingering failed state from the systemd restart loop.
- Address helpers compare against `$INGRESS_IP/24` on `$INTERFACE` and act only on divergence.
- Helpers log only when they actually do work, so a tick on a healthy host produces no journal output.

- [ ] **Step 3: Static syntax check (the "passing test")**

```bash
bash -n /Users/ricardo/synced/Projects/home/roles/ingress/files/ingress.sh
```

Expected: exit 0, no output.

- [ ] **Step 4 (optional): Run shellcheck if installed**

```bash
command -v shellcheck && shellcheck /Users/ricardo/synced/Projects/home/roles/ingress/files/ingress.sh
```

If `shellcheck` is not installed, skip — it is not a project dependency. If present, expect zero or only style warnings (SC2086 on intentional word-splitting of the `ip addr show` output is acceptable; address that only if it surfaces).

- [ ] **Step 5: Commit**

```bash
cd /Users/ricardo/synced/Projects/home
git add roles/ingress/files/ingress.sh
git commit -m "$(cat <<'EOF'
Make ingress.sh self-heal from wg-quick start failures

Decompose handle_host/handle_peer into idempotent ensure_* helpers that
verify-and-reconcile each piece of state. ensure_down force-deletes the
kernel interface if it survived systemctl stop (the failure mode that
left cannoli with vpn-host alive but the service marked failed, blocking
vpn-peer from binding UDP/51821 in an infinite restart loop).

Add a TICK_SECS=30 reconciliation tick around the docker events stream
via coproc + read -t, so drift recovers within one tick without needing
a swarm change.

Drop last_state caching: each ensure_* helper is its own verify-then-act
so periodic ticks are free when state matches intent.
EOF
)"
```

---

## Task 2: Deploy to `cannoli` first (recovery canary)

`cannoli` is the host currently stuck in the broken state. Deploying there first proves the fix end-to-end, since `ingress.service` will bounce and `handle_peer` will run with the new cleanup.

**Files:** none modified — uses existing role.

- [ ] **Step 1: Deploy to cannoli only**

```bash
cd /Users/ricardo/synced/Projects/home
task deploy --tags enable_ingress_service -l cannoli
```

Expected: Ansible reports the `create ingress script` task as `changed` on cannoli, which notifies `ingress_service_restart` → handler restarts `ingress.service`. No errors.

- [ ] **Step 2: Watch the restart take effect**

Open a tail of the ingress logs in another terminal *before* or immediately after the deploy:

```bash
TERM=xterm /usr/bin/ssh cannoli 'sudo journalctl -u ingress.service -u "wg-quick@vpn-host.service" -u "wg-quick@vpn-peer.service" -n 50 --no-pager'
```

Expected log narrative (in order):
1. `ingress.service: Stopping` then `Started Ingress`
2. `ingress.sh` logs `Stopping wg-quick@vpn-host` (was active)
3. `wg-quick@vpn-host` ExecStop runs; if it leaves the interface alive, `ingress.sh` logs `Removing stale vpn-host interface`
4. `ingress.sh` logs `Removing $INGRESS_IP from <interface>` (was present)
5. `ingress.sh` logs `Starting wg-quick@vpn-peer`
6. `wg-quick@vpn-peer` ExecStart succeeds (no `Could not create IPv4 socket` and no `Address already in use` lines)

- [ ] **Step 3: Verify final state on cannoli**

```bash
TERM=xterm /usr/bin/ssh cannoli '
  echo "=== wg interfaces ==="
  ip -br link show type wireguard
  echo "=== unit states ==="
  systemctl is-active wg-quick@vpn-host wg-quick@vpn-peer ingress 2>&1
  echo "=== restart counter (should stop climbing) ==="
  systemctl show wg-quick@vpn-peer -p NRestarts --value
  echo "=== peer handshake ==="
  sudo wg show vpn-peer latest-handshakes 2>&1
'
```

Expected:
- `vpn-peer` interface present (`overlay`, `vpn-peer` — NO `vpn-host`).
- `wg-quick@vpn-host` = `inactive`, `wg-quick@vpn-peer` = `active`, `ingress` = `active`.
- `NRestarts` value still high (carried over) but no longer climbing on subsequent checks 30s apart.
- `wg show vpn-peer latest-handshakes` shows recent handshake to the actual ingress host.

If any of the above is wrong, **STOP** — do not deploy to other hosts. Re-read journal output and diagnose before continuing.

- [ ] **Step 4: Verify tick loop is silent on healthy state**

Wait at least 90 seconds (3 ticks), then:

```bash
TERM=xterm /usr/bin/ssh cannoli 'sudo journalctl -u ingress.service --since "90 seconds ago" --no-pager'
```

Expected: zero new lines from `ingress.sh` (the ensure_* helpers all early-return when state is correct). If the loop is logging on every tick, something is non-idempotent — investigate before deploying further.

---

## Task 3: Deploy to remaining `ingress_peers` hosts

Remaining hosts from `env/inventory/hosts.yml`: `autopi`, `gelato`, `pi`, `tart`.

- [ ] **Step 1: Deploy to remaining hosts**

```bash
cd /Users/ricardo/synced/Projects/home
task deploy --tags enable_ingress_service -l autopi,gelato,pi,tart
```

Expected: each host reports `changed` on the script copy and the service is restarted. No failures.

- [ ] **Step 2: Spot-check each host's post-deploy state**

```bash
for h in autopi gelato pi tart; do
  echo "=== $h ==="
  TERM=xterm /usr/bin/ssh "$h" '
    ip -br link show type wireguard
    systemctl is-active wg-quick@vpn-host wg-quick@vpn-peer ingress 2>&1
  '
done
```

Expected per host: exactly one of `vpn-host` / `vpn-peer` interface present (whichever matches that host's current swarm role), corresponding `wg-quick@` unit `active`, `ingress` = `active`. No `failed` units.

- [ ] **Step 3: Spot-check tick-silence on one peer host**

Pick any non-cannoli host that came up cleanly (e.g. `gelato`):

```bash
sleep 90
TERM=xterm /usr/bin/ssh gelato 'sudo journalctl -u ingress.service --since "90 seconds ago" --no-pager'
```

Expected: no `ingress.sh` log lines in that window.

- [ ] **Step 4: No additional commit needed**

This task is deploy-only; no source changes. Commit from Task 1 is the only commit.

---

## Self-review

**Spec coverage:**
- "Hardened handlers" → Task 1 Step 2 implements `ensure_up` / `ensure_down` / `ensure_address_*` and the two-line `handle_host` / `handle_peer`.
- "Periodic tick" → Task 1 Step 2 implements `coproc DOCKER_EVENTS` + `read -t TICK_SECS` loop.
- "What is removed" (last_state, verify_state, apply_state wrapper) → confirmed absent in the new script.
- "What is preserved" (interface-up gate, get_state, `command -v docker` fallback, `trap handle_peer ERR EXIT`) → all present and unchanged in spirit; the fallback uses `handle_peer` directly per the spec.
- "Recovery, end-to-end" narrative → Task 2 Steps 2–3 verify exactly this on cannoli.
- "Tick is free on healthy state" → Task 2 Step 4 + Task 3 Step 3 verify.

**Placeholder scan:** No "TBD", "TODO", or "implement later". Every code step contains complete code; every command step contains the exact command and expected output.

**Type/name consistency:** Helpers used in `handle_*` (`ensure_down`, `ensure_address_absent`, `ensure_address_present`, `ensure_up`) match the definitions above them. `TICK_SECS` is set once and referenced once. `${DOCKER_EVENTS[0]}` matches the `coproc DOCKER_EVENTS { ... }` declaration. `INTERFACE` and `INGRESS_IP` continue to be provided by the systemd unit (`Environment=` lines, `roles/ingress/tasks/main.yml:260-261`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-05-25-ingress-self-heal.md`. Two execution options:

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
