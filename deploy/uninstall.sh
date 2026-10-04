#!/bin/bash
# Stops vision-proxy and removes its LaunchAgent. Cached captions stay in ~/.cache/vision-proxy.
set -euo pipefail
LABEL=local.vision-proxy
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed $LABEL. Remove the provider you pointed at the proxy from your client as well."
