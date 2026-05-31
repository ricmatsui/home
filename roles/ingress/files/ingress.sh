#!/bin/bash
set -Exeuo pipefail

LABEL="com.docker.swarm.service.name=traefik_traefik"
TICK_SECS=300

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
