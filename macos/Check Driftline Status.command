#!/bin/bash
set -u

LABEL="com.driftline.market-watcher"
HEALTH_URL="http://127.0.0.1:8765/healthz"
LOG_DIR="$HOME/Library/Logs/DriftlineWatcher"

clear
printf "DRIFTLINE WATCHER STATUS\n"
printf "========================\n\n"

if launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1; then
  printf "Mac service: RUNNING\n"
else
  printf "Mac service: NOT RUNNING\n"
fi

if HEALTH="$(curl --silent --fail --max-time 3 "$HEALTH_URL" 2>/dev/null)"; then
  printf "Health page: %s\n\n" "$HEALTH_URL"
  printf "%s\n" "$HEALTH"
  open "$HEALTH_URL"
else
  printf "Health page: NOT RESPONDING\n"
fi

printf "\nLATEST ACTIVITY\n"
printf '%s\n' '---------------'
if [[ -f "$LOG_DIR/watcher.log" ]]; then
  tail -n 20 "$LOG_DIR/watcher.log"
else
  printf "No activity log yet.\n"
fi

if [[ -s "$LOG_DIR/watcher-error.log" ]]; then
  printf "\nLATEST ERRORS\n"
  printf '%s\n' '-------------'
  tail -n 20 "$LOG_DIR/watcher-error.log"
fi

printf "\nPress Return to close this window."
read -r _
