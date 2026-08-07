#!/bin/bash
set -Eeuo pipefail

VOLUME=gv0

offline_bricks=$(timeout 30 gluster volume status "$VOLUME" --xml | python3 -c '
import sys
import xml.etree.ElementTree as ET

root = ET.fromstring(sys.stdin.read())
offline = 0
for node in root.iter("node"):
    path = node.findtext("path") or ""
    status = node.findtext("status") or ""
    # Bricks have real filesystem paths; daemons report path="localhost"
    if path.startswith("/") and status == "0":
        offline += 1
print(offline)
')

if [[ "$offline_bricks" -gt 0 ]]; then
    echo "Offline brick(s) detected in $VOLUME: $offline_bricks, running force start"
    gluster volume start "$VOLUME" force
else
    echo "All bricks online for $VOLUME"
fi
