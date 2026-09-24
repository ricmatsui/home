#!/bin/bash
set -Eeuo pipefail

MOUNT_POINT=/mnt/gluster
MOUNT_UNIT=mnt-gluster.mount
PROBE_TIMEOUT=20
FAILURE_THRESHOLD=2
STATE_FILE=/run/gluster-mount-recover.failures

# A brick sitting at connected = 0 is normal while its host reboots: quorum
# keeps I/O flowing and nothing queues, so recovering on that alone would bounce
# every container each time a peer reboots. The wedge a ping timeout leaves
# behind is a brick that stays disconnected *and* requests piling up on the FUSE
# connection, so require both before touching anything.
WAITING_THRESHOLD=1

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
fi

probe() {
    local output
    output=$(timeout "$PROBE_TIMEOUT" ls "$MOUNT_POINT" 2>/dev/null) || return 1
    [[ -n "${output//[[:space:]]/}" ]] || return 1
}

# With x-systemd.automount the mount point appears twice in mountinfo and the
# autofs entry shadows the fuse one, so match on the filesystem type rather than
# taking the first path hit.
fuse_minor() {
    awk -v mp="$MOUNT_POINT" '
        {
            fstype = ""
            for (i = 7; i <= NF; i++) {
                if ($i == "-") { fstype = $(i + 1); break }
            }
        }
        $5 == mp && fstype ~ /^fuse/ { split($3, dev, ":"); print dev[2]; exit }
    ' /proc/self/mountinfo
}

fuse_waiting() {
    local minor
    minor=$(fuse_minor)
    [[ -n "$minor" ]] || return 1
    cat "/sys/fs/fuse/connections/${minor}/waiting" 2>/dev/null
}

# Each brick the client talks to exposes its link state through the meta xlator.
disconnected_bricks() {
    local mount_point=${1:-$MOUNT_POINT}
    local private
    for private in "$mount_point"/.meta/graphs/active/*-client-*/private; do
        [[ -e "$private" ]] || continue
        if timeout "$PROBE_TIMEOUT" grep -qs '^connected = 0' "$private"; then
            basename "$(dirname "$private")"
        fi
    done
}

all_bricks_connected() {
    local disconnected
    disconnected=$(disconnected_bricks "${1:-$MOUNT_POINT}") || return 1
    [[ -z "$disconnected" ]]
}

# A client reconnects to each brick asynchronously, so a reading taken the moment
# it is mounted reports bricks that are merely still connecting.
settle_bricks() {
    local mount_point=$1
    local attempt
    for attempt in 1 2 3 4 5; do
        if all_bricks_connected "$mount_point"; then
            return 0
        fi
        sleep 3
    done
    return 1
}

# A remount can only ever repair client-side state, so mounting a throwaway
# client answers up front what recover() would otherwise bet the real mount on:
# if a brand new client cannot reach the brick either, the fault is on the brick
# and remounting only strands containers on a dead superblock.
fresh_client_disconnected_bricks() {
    local source probe_dir disconnected status=0

    # Reading the live mount would return two lines here, because the autofs
    # entry x-systemd.automount leaves behind shadows the fuse one, and it also
    # resolves to whichever single server happened to serve the mount. The fstab
    # entry names every pool server, so the probe survives one of them being down.
    source=$(findmnt -n -o SOURCE --fstab "$MOUNT_POINT") || return 1
    [[ -n "$source" ]] || return 1

    probe_dir=$(mktemp -d) || return 1

    if timeout "$PROBE_TIMEOUT" mount -t glusterfs "$source" "$probe_dir"; then
        settle_bricks "$probe_dir" || true
        disconnected=$(disconnected_bricks "$probe_dir") || status=1
    else
        status=1
    fi

    umount "$probe_dir" 2>/dev/null || umount -f -l "$probe_dir" 2>/dev/null || true
    rmdir "$probe_dir" 2>/dev/null || true

    [[ "$status" -eq 0 ]] || return 1
    printf '%s' "$disconnected"
}

record_failure() {
    local failures
    failures=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))

    if [[ "$DRY_RUN" == true ]]; then
        local brick_side
        if ! brick_side=$(fresh_client_disconnected_bricks); then
            echo "Dry run, could not probe with a fresh client, would not remount"
        elif [[ -n "$brick_side" ]]; then
            echo "Dry run, brick-side fault (${brick_side//$'\n'/ }), would not remount"
        else
            echo "Dry run, fresh client is clean, would remount"
        fi
        exit 1
    fi

    echo "$failures" > "$STATE_FILE"

    if [[ "$failures" -lt "$FAILURE_THRESHOLD" ]]; then
        echo "Failure $failures/$FAILURE_THRESHOLD for $MOUNT_POINT, deferring recovery"
        exit 0
    fi

    echo "Failure $failures/$FAILURE_THRESHOLD for $MOUNT_POINT, remounting"
    recover
}

recover() {
    local brick_side

    if ! brick_side=$(fresh_client_disconnected_bricks); then
        echo "Could not probe with a fresh client, not remounting $MOUNT_POINT"
        rm -f "$STATE_FILE"
        exit 0
    fi

    if [[ -n "$brick_side" ]]; then
        echo "Brick-side fault (${brick_side//$'\n'/ }): a fresh client cannot reach it either, not remounting"
        rm -f "$STATE_FILE"
        exit 0
    fi

    umount -f -l "$MOUNT_POINT" || echo "Unmount reported failure, continuing"
    sleep 2
    systemctl restart "$MOUNT_UNIT"

    if ! probe; then
        echo "Remount failed for $MOUNT_POINT" >&2
        exit 1
    fi

    settle_bricks "$MOUNT_POINT" || true

    if ! all_bricks_connected; then
        echo "Remounted $MOUNT_POINT but bricks still disconnected: $(disconnected_bricks | tr '\n' ' ')" >&2
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
}

if ! probe; then
    echo "Probe failed for $MOUNT_POINT"
    record_failure
    exit 0
fi

# The probe only reads the mount root, which keeps answering from the surviving
# bricks while a partially wedged client hangs every open, fsync and lock that
# touches a file the lost brick held state for.
disconnected=$(disconnected_bricks | tr '\n' ' ')
disconnected="${disconnected%% }"

if [[ -z "$disconnected" ]]; then
    rm -f "$STATE_FILE"
    echo "Mount healthy: $MOUNT_POINT"
    exit 0
fi

waiting=$(fuse_waiting) || waiting=""

if [[ ! "$waiting" =~ ^[0-9]+$ ]]; then
    rm -f "$STATE_FILE"
    echo "Bricks disconnected ($disconnected) but FUSE queue unreadable, leaving alone"
    exit 0
fi

if [[ "$waiting" -lt "$WAITING_THRESHOLD" ]]; then
    rm -f "$STATE_FILE"
    echo "Bricks disconnected ($disconnected) with $waiting waiting requests, quorum still serving"
    exit 0
fi

echo "Wedged: bricks disconnected ($disconnected) with $waiting requests waiting on the FUSE queue"
record_failure
