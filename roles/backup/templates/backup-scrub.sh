#!/bin/bash
set -euo pipefail

if [ "$EUID" -ne 0 ]; then
    echo "ERROR: must be run as root (use sudo)"
    exit 1
fi

if ! gluster volume info backup | grep -q '^Status: Started$'; then
    echo "ERROR: gluster volume backup is not started (run backup-mount.sh first)."
    exit 1
fi

echo "==> Starting on-demand scrub"
gluster volume bitrot backup scrub ondemand

echo "==> Scrub status"
gluster volume bitrot backup scrub status
