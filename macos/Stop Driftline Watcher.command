#!/bin/bash
set -u

LABEL="com.driftline.market-watcher"
DOMAIN="gui/$(id -u)"

launchctl bootout "$DOMAIN/$LABEL" >/dev/null 2>&1 || true
printf "Driftline watcher stopped. It will remain stopped until you start or reinstall it.\n"
printf "Press Return to close this window."
read -r _
