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

if ! mountpoint -q "$MOUNT"; then
    echo "ERROR: $MOUNT is not mounted."
    exit 1
fi

echo "==> Unmounting gluster FUSE volume"
umount "$MOUNT"

echo "==> Stopping gluster volume"
gluster --mode=script volume stop backup

echo "==> Unmounting brick filesystems"
for drive in "${DRIVES[@]}"; do
    umount /mnt/"$drive"
done

echo "==> Closing LUKS volumes"
for drive in "${DRIVES[@]}"; do
    cryptsetup luksClose "$drive"
done

echo "==> Final block devices"
lsblk
