#!/bin/bash
set -u

LABEL="com.driftline.market-watcher"
DOMAIN="gui/$(id -u)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

if [[ ! -f "$PLIST" ]]; then
  printf "Driftline is not installed yet. Double-click 'Install Driftline Watcher.command' first.\n"
else
  launchctl bootstrap "$DOMAIN" "$PLIST" >/dev/null 2>&1 || true
  launchctl enable "$DOMAIN/$LABEL"
  launchctl kickstart -k "$DOMAIN/$LABEL"
  printf "Driftline watcher started.\n"
fi

printf "Press Return to close this window."
read -r _
