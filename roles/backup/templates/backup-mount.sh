#!/bin/bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "ERROR: must be run as root (use sudo)"
    exit 1
fi

DRIVES=(backup-1a backup-1b)
MOUNT=/mnt/backup

echo "==> Current block devices"
lsblk

if mountpoint -q "$MOUNT"; then
    echo "ERROR: $MOUNT is already mounted."
    exit 1
fi

read -rsp "LUKS passphrase: " LUKS_PASS
echo

echo "==> Verifying passphrase against ${DRIVES[0]}"
if ! printf '%s' "$LUKS_PASS" | cryptsetup luksOpen --test-passphrase --key-file=- /dev/disk/by-label/"${DRIVES[0]}"; then
    echo "ERROR: passphrase did not unlock ${DRIVES[0]}"
    exit 1
fi

echo "==> Opening LUKS volumes"
for drive in "${DRIVES[@]}"; do
    printf '%s' "$LUKS_PASS" | cryptsetup luksOpen --key-file=- /dev/disk/by-label/"$drive" "$drive"
done

echo "==> Mounting brick filesystems"
for drive in "${DRIVES[@]}"; do
    mount -o defaults,noatime /dev/mapper/"$drive" /mnt/"$drive"
done

echo "==> Starting gluster volume"
gluster volume start backup

echo "==> Mounting gluster FUSE volume at $MOUNT"
mount -t glusterfs -o defaults,_netdev,noatime {{ gluster_ip }}:/backup "$MOUNT"

echo "==> Final block devices"
lsblk
echo "==> Contents of $MOUNT"
ls "$MOUNT"
