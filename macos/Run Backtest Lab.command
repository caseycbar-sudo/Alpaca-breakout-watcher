#!/bin/bash
set -uo pipefail

SUPPORT_DIR="$HOME/Library/Application Support/DriftlineWatcher"
APP_DIR="$SUPPORT_DIR/app"
CONFIG_FILE="$SUPPORT_DIR/watcher.env"
OUT_DIR="$SUPPORT_DIR/backtest"
MY_LIST="$SUPPORT_DIR/my_study_list.txt"
REPORT="$OUT_DIR/Backtest Lab Report.html"

pause() {
  printf "\nPress Return to close this window."
  read -r _
}

clear
printf "DRIFTLINE BACKTEST LAB\n"
printf "======================\n\n"
printf "Research only: replays past market data to learn which setups tend to work.\n"
printf "It does not send alerts, change paper trades, or place any order.\n\n"

if [[ ! -x "$APP_DIR/.venv/bin/python" || ! -r "$CONFIG_FILE" ]]; then
  printf "The Driftline watcher is not installed on this Mac yet.\n"
  printf "Run 'Install Driftline Watcher.command' first.\n"
  pause
  exit 1
fi

if [[ ! -f "$APP_DIR/src/backtest_lab.py" ]]; then
  printf "The installed watcher is an older version without the Backtest Lab.\n"
  printf "Run 'Install Driftline Watcher.command' again (it keeps your saved keys), then try this again.\n"
  pause
  exit 1
fi

mkdir -p "$OUT_DIR"
if [[ ! -f "$MY_LIST" ]]; then
  cp "$APP_DIR/data/study_list.txt" "$MY_LIST" 2>/dev/null || printf "# My study list — one ticker per line\n" > "$MY_LIST"
fi

printf "Your personal study list: %s\n" "$MY_LIST"
printf "Tickers the watcher flags are included automatically.\n\n"
read -r -p "Tickers to study now (e.g. SOFI,PLTR) or press Return for your study list: " SYMBOLS
SYMBOLS="${SYMBOLS// /}"
read -r -p "How many calendar days of history? [120]: " DAYS
DAYS="${DAYS:-120}"
if ! [[ "$DAYS" =~ ^[0-9]+$ ]] || (( DAYS < 20 || DAYS > 400 )); then
  printf "Using 120 days.\n"
  DAYS=120
fi

set -a
# shellcheck disable=SC1090
source "$CONFIG_FILE"
set +a
export STUDY_LIST_PATHS="$MY_LIST:$APP_DIR/data/study_list.txt"
export STUDY_PICKS_PATHS="$APP_DIR/data/study_picks.json:$APP_DIR/data/stream_picks.json"

ARGS=(--days "$DAYS" --out "$OUT_DIR/backtest.json" --csv-dir "$OUT_DIR" --history "$OUT_DIR/history.json" --report "$REPORT")
if [[ -n "$SYMBOLS" ]]; then
  ARGS+=(--symbols "$SYMBOLS")
fi

printf "\nDownloading history and replaying setups. This usually takes a few minutes...\n\n"
cd "$APP_DIR" || exit 1
if "$APP_DIR/.venv/bin/python" -m src.backtest_lab "${ARGS[@]}"; then
  printf "\nDone. Opening the report.\n"
  printf "Spreadsheets of every replayed setup are in: %s\n" "$OUT_DIR"
  open "$REPORT"
else
  printf "\nThe backtest stopped with an error (details above).\n"
  printf "Common causes: no internet connection, or Alpaca paper keys that need to be re-entered.\n"
fi
pause

