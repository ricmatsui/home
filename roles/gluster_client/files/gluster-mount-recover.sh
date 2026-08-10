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
