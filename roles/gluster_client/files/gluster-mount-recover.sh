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

# A wedged mount parks anything touching it in uninterruptible sleep, where no
# signal lands, so `timeout` sends its kill and then blocks reaping the child
# forever. Run the command in the background and stop waiting instead; the
# stranded process clears once the remount aborts the old connection. The unit
# runs with KillMode=process so that leftover can't hold it in deactivating,
# which would stop the timer from ever firing the run that recovers.
bounded() {
    local output pid elapsed=0
    output=$(mktemp)
    "$@" > "$output" 2>/dev/null &
    pid=$!

    while kill -0 "$pid" 2>/dev/null; do
        if [[ "$elapsed" -ge "$PROBE_TIMEOUT" ]]; then
            kill -9 "$pid" 2>/dev/null || true
            rm -f "$output"
            return 124
        fi
        sleep 1
        elapsed=$((elapsed + 1))
    done

    local status=0
    wait "$pid" || status=$?
    cat "$output"
    rm -f "$output"
    return "$status"
}

probe() {
    local output
    output=$(bounded ls "$MOUNT_POINT") || return 1
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
    local private
    for private in "$MOUNT_POINT"/.meta/graphs/active/*-client-*/private; do
        [[ -e "$private" ]] || continue
        if bounded grep -qs '^connected = 0' "$private"; then
            basename "$(dirname "$private")"
        fi
    done
}

# A brick the client lost because its host is down (a reboot, a crashed brick
# process) comes back on its own, and remounting against it only strands
# containers. The wedge a remount fixes is a client that stays cut off from a
# brick that is up. Servers can ask glusterd directly; clients without the CLI
# fall back to whether glusterd on the brick's host answers at all.
brick_online() {
    local options="$MOUNT_POINT/.meta/graphs/active/$1/options"
    local volume="${1%-client-*}" host subvolume
    host=$(bounded cat "$options/remote-host") || return 1
    subvolume=$(bounded cat "$options/remote-subvolume") || return 1

    if command -v gluster >/dev/null; then
        bounded gluster volume status "$volume" "$host:$subvolume" --xml | grep -q '<status>1</status>'
    else
        bounded bash -c 'exec 3<>"/dev/tcp/$0/24007"' "$host"
    fi
}

all_bricks_connected() {
    local disconnected
    disconnected=$(disconnected_bricks) || return 1
    [[ -z "$disconnected" ]]
}

record_failure() {
    local failures
    failures=$(( $(cat "$STATE_FILE" 2>/dev/null || echo 0) + 1 ))

    if [[ "$DRY_RUN" == true ]]; then
        echo "Dry run, not recording failure or recovering"
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

# Containers resolve bind mounts at creation, so they keep pointing at the dead
# superblock across a remount and stay broken without ever crashing. Restarting
# the daemon forces every container to re-resolve.
restart_docker() {
    if systemctl is-active --quiet docker; then
        echo "Restarting docker so containers re-resolve their bind mounts"
        systemctl restart docker
        echo "Docker restarted"
    else
        echo "Docker not active, skipping restart"
    fi
}

recover() {
    umount -f -l "$MOUNT_POINT" || echo "Unmount reported failure, continuing"

    # The old superblock is detached now and every container still points at
    # it, so however the remount goes, leave through the docker restart.
    trap restart_docker EXIT

    sleep 2

    # Anything touching the mount point after the detach triggers the automount,
    # and a restart then fails trying to stop that mount half way up. Start
    # joins it instead.
    systemctl start "$MOUNT_UNIT" || echo "Starting $MOUNT_UNIT reported failure, continuing"

    if ! probe; then
        echo "Remount failed for $MOUNT_POINT" >&2
        exit 1
    fi

    # The fresh client reconnects to each brick asynchronously, so give it a
    # moment before declaring the wedge cleared.
    local attempt
    for attempt in 1 2 3 4 5; do
        if all_bricks_connected; then
            break
        fi
        sleep 3
    done

    if ! all_bricks_connected; then
        echo "Remounted $MOUNT_POINT but bricks still disconnected: $(disconnected_bricks | tr '\n' ' ')" >&2
        exit 1
    fi

    rm -f "$STATE_FILE"
    echo "Remount succeeded for $MOUNT_POINT"
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

stranded=""
for client in $disconnected; do
    if brick_online "$client"; then
        stranded+="$client "
    fi
done
stranded="${stranded%% }"

if [[ -z "$stranded" ]]; then
    rm -f "$STATE_FILE"
    echo "Bricks disconnected ($disconnected) are offline on their hosts, waiting for them to return"
    exit 0
fi

echo "Wedged: bricks disconnected ($stranded) while online with $waiting requests waiting on the FUSE queue"
record_failure
