#!/bin/bash
set -Exeuo pipefail

LABEL="com.docker.swarm.service.name=traefik_traefik"

until ip addr show dev "$INTERFACE" | grep -q "inet "; do
    echo "Waiting for interface...";
    sleep 1;
done

handle_host() {
    echo "Switching to host"
    systemctl stop wg-quick@vpn-peer
    if [[ -z "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]]; then
        ip addr add "$INGRESS_IP/24" dev "$INTERFACE"
    fi
    systemctl start wg-quick@vpn-host
    echo "Switched to host"
}

handle_peer() {
    echo "Switching to peer"
    systemctl stop wg-quick@vpn-host
    if [[ -n "$(ip addr show dev "$INTERFACE" to "$INGRESS_IP")" ]]; then
        ip addr del "$INGRESS_IP/24" dev "$INTERFACE"
    fi
    systemctl start wg-quick@vpn-peer
    echo "Switched to peer"
}

trap handle_peer ERR EXIT

get_state() {
    local ids=$(docker ps -q --filter "label=$LABEL")

    if [[ -n "$ids" ]]; then
        echo "host"
    else
        echo "peer"
    fi
}

last_state=""

apply_state() {
    local new_state="$1"

    if [[ "$new_state" == "$last_state" ]]; then
        return 0
    fi

    case "$new_state" in
        host)
            handle_host
            ;;
        peer)
            handle_peer
            ;;
    esac

    last_state="$new_state"
}

if ! command -v docker; then
    apply_state "peer"
    sleep infinity
fi

apply_state "$(get_state)"

docker events --filter "label=$LABEL" | while read -r _; do
    apply_state "$(get_state)"
done

echo "Docker events stream ended"
exit 1
