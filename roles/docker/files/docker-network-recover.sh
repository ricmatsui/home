#!/bin/bash
set -Eeuo pipefail

STATE_FILE=/run/docker-network-recover.orphans
SIGHTING_THRESHOLD=2

# Docker builds an overlay's vxlan interface in the host namespace and then
# moves it into the network's own namespace, so a healthy node has none of them
# left here. A daemon restart can lose track of one mid-move and strand it, and
# because the stale interface keeps the name reserved every later task on that
# network is rejected with "error creating vxlan interface: file exists". Docker
# never reaps it, so the network stays unusable until the interface is removed.
#
# The move is not atomic, so a freshly created interface shows up here for a
# moment during normal operation. Requiring the same name across consecutive
# runs keeps that window from being mistaken for a leak.

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

# Emits "name state" for every vxlan interface sitting in the host namespace.
host_vxlans() {
    ip -o link show 2>/dev/null | awk '
        {
            name = $2
            sub(/:$/, "", name)
            sub(/@.*/, "", name)
            if (name !~ /^vx-/) next

            state = "UNKNOWN"
            for (i = 3; i <= NF; i++) {
                if ($i == "state") { state = $(i + 1); break }
            }
            print name, state
        }
    '
}

if ! systemctl is-active --quiet docker; then
    echo "Docker not active, skipping"
    exit 0
fi

declare -A seen_before=()
if [[ -f "$STATE_FILE" ]]; then
    while read -r name count; do
        [[ -n "$name" ]] || continue
        seen_before["$name"]="$count"
    done < "$STATE_FILE"
fi

declare -a next_state=()
recovered=0
pending=0

while read -r name state; do
    [[ -n "$name" ]] || continue
    count=$(( ${seen_before["$name"]:-0} + 1 ))

    if (( count < SIGHTING_THRESHOLD )); then
        echo "Stranded interface $name seen $count/$SIGHTING_THRESHOLD, deferring removal"
        next_state+=("$name $count")
        pending=$(( pending + 1 ))
        continue
    fi

    # An interface that is up is carrying traffic for something this script does
    # not understand, so leave it alone and say so rather than guess.
    if [[ "$state" != "DOWN" ]]; then
        echo "Stranded interface $name is $state, not removing"
        next_state+=("$name $count")
        pending=$(( pending + 1 ))
        continue
    fi

    if [[ "$DRY_RUN" == true ]]; then
        echo "Dry run, would remove stranded interface $name"
        next_state+=("$name $count")
        pending=$(( pending + 1 ))
        continue
    fi

    echo "Removing stranded interface $name after $count sightings"
    if ip link delete "$name"; then
        echo "Removed $name, docker can recreate the network on the next task attempt"
        recovered=$(( recovered + 1 ))
    else
        echo "Failed to remove $name" >&2
        next_state+=("$name $count")
    fi
done < <(host_vxlans)


if (( recovered == 0 && pending == 0 )); then
    echo "No stranded overlay interfaces"
fi

if [[ "$DRY_RUN" == true ]]; then
    echo "Dry run, leaving state file untouched"
elif (( ${#next_state[@]} > 0 )); then
    printf '%s\n' "${next_state[@]}" > "$STATE_FILE"
else
    rm -f "$STATE_FILE"
fi
