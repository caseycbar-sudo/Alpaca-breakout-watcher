#!/bin/bash
set -euo pipefail

APP_DIR="__APP_DIR__"
CONFIG_FILE="__CONFIG_FILE__"

if [[ ! -r "$CONFIG_FILE" ]]; then
  echo "Missing private settings file: $CONFIG_FILE" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a

cd "$APP_DIR"
exec /usr/bin/caffeinate -i "$APP_DIR/.venv/bin/python" -m src.stream_watcher
