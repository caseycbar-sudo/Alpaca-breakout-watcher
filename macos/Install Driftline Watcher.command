#!/bin/bash
set -euo pipefail

LABEL="com.driftline.market-watcher"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
SOURCE_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SUPPORT_DIR="$HOME/Library/Application Support/DriftlineWatcher"
APP_DIR="$SUPPORT_DIR/app"
CONFIG_FILE="$SUPPORT_DIR/watcher.env"
LOG_DIR="$HOME/Library/Logs/DriftlineWatcher"
LAUNCH_DIR="$HOME/Library/LaunchAgents"
PLIST="$LAUNCH_DIR/$LABEL.plist"
RUNNER="$SUPPORT_DIR/run_watcher.sh"
HEALTH_URL="http://127.0.0.1:8765/healthz"
DASHBOARD_URL="http://127.0.0.1:8765/"

pause() {
  printf "\nPress Return to close this window."
  read -r _
}

fail() {
  printf "\nSETUP STOPPED: %s\n" "$1" >&2
  pause
  exit 1
}

save_setting() {
  local name="$1"
  local value="$2"
  value="${value//\'/\'\"\'\"\'}"
  printf "%s='%s'\n" "$name" "$value" >> "$CONFIG_FILE"
}

prompt_required() {
  local label="$1"
  local secret="${2:-false}"
  local value=""
  while [[ -z "$value" ]]; do
    if [[ "$secret" == "true" ]]; then
      read -r -s -p "$label: " value
      printf "\n"
    else
      read -r -p "$label: " value
    fi
    value="${value// /}"
  done
  REPLY_VALUE="$value"
}

clear
printf "DRIFTLINE ALWAYS-ON WATCHER\n"
printf "============================\n\n"
printf "This installs a READ-ONLY market watcher on this Mac.\n"
printf "It cannot place, change, or cancel an order.\n\n"

command -v python3 >/dev/null 2>&1 || fail "Python 3 is required. Install it from https://www.python.org/downloads/macos/"
command -v curl >/dev/null 2>&1 || fail "curl is required but was not found."

mkdir -p "$SUPPORT_DIR" "$APP_DIR" "$LOG_DIR" "$LAUNCH_DIR"
chmod 700 "$SUPPORT_DIR" "$LOG_DIR"

printf "Copying the watcher into its permanent Mac folder...\n"
ditto "$SOURCE_DIR/src" "$APP_DIR/src" || fail "The watcher program could not be copied."
ditto "$SOURCE_DIR/data" "$APP_DIR/data" || fail "The watcher data could not be copied."
cp "$SOURCE_DIR/requirements.txt" "$APP_DIR/requirements.txt"

printf "Preparing the private Python environment...\n"
python3 -m venv "$APP_DIR/.venv" || fail "Python could not create the private environment."
"$APP_DIR/.venv/bin/python" -m pip install --quiet --upgrade pip
"$APP_DIR/.venv/bin/python" -m pip install --quiet -r "$APP_DIR/requirements.txt" || fail "Python packages could not be installed."

REUSE_SETTINGS="false"
if [[ -f "$CONFIG_FILE" ]]; then
  read -r -p "Existing private settings found. Reuse them? [Y/n]: " REUSE_REPLY
  case "${REUSE_REPLY:-Y}" in
    n|N|no|NO|No) REUSE_SETTINGS="false" ;;
    *) REUSE_SETTINGS="true" ;;
  esac
fi

if [[ "$REUSE_SETTINGS" == "true" ]]; then
  printf "Existing private settings will be reused.\n"
  # Migrate older installations to the expanded universe and new 24/7 crypto
  # feed without asking for or exposing the saved credentials again.
  if grep -q '^STREAM_MAX_SYMBOLS=' "$CONFIG_FILE"; then
    sed -i '' "s/^STREAM_MAX_SYMBOLS=.*/STREAM_MAX_SYMBOLS='180'/" "$CONFIG_FILE"
  else
    save_setting "STREAM_MAX_SYMBOLS" "180"
  fi
  grep -q '^CRYPTO_STREAM_ENABLED=' "$CONFIG_FILE" || save_setting "CRYPTO_STREAM_ENABLED" "true"
  grep -q '^CRYPTO_DATA_LOCATION=' "$CONFIG_FILE" || save_setting "CRYPTO_DATA_LOCATION" "us"
  grep -q '^CRYPTO_STREAM_SYMBOLS=' "$CONFIG_FILE" || save_setting "CRYPTO_STREAM_SYMBOLS" "BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,AVAX/USD,LINK/USD,LTC/USD,BCH/USD,UNI/USD"
  grep -q '^OPTIONS_VOLUME_ENABLED=' "$CONFIG_FILE" || save_setting "OPTIONS_VOLUME_ENABLED" "true"
  grep -q '^OPTIONS_DATA_FEED=' "$CONFIG_FILE" || save_setting "OPTIONS_DATA_FEED" "indicative"
  grep -q '^OPTIONS_CORE_SYMBOLS=' "$CONFIG_FILE" || save_setting "OPTIONS_CORE_SYMBOLS" "SPY,QQQ"
  grep -q '^OPTIONS_TOP_SYMBOLS=' "$CONFIG_FILE" || save_setting "OPTIONS_TOP_SYMBOLS" "5"
  grep -q '^OPTIONS_POLL_SECONDS=' "$CONFIG_FILE" || save_setting "OPTIONS_POLL_SECONDS" "120"
else
  printf "Enter the same PAPER Alpaca keys and Gmail App Password used by the watcher.\n"
  printf "Typing is hidden for secret values. Nothing is uploaded to GitHub.\n\n"

  : > "$CONFIG_FILE"
  chmod 600 "$CONFIG_FILE"

  prompt_required "Alpaca PAPER API key" true
  save_setting "ALPACA_API_KEY" "$REPLY_VALUE"
  prompt_required "Alpaca PAPER secret key" true
  save_setting "ALPACA_SECRET_KEY" "$REPLY_VALUE"
  prompt_required "Gmail 16-character App Password" true
  GMAIL_PASSWORD="$REPLY_VALUE"
  if [[ ${#GMAIL_PASSWORD} -ne 16 ]]; then
    rm -f "$CONFIG_FILE"
    fail "The Gmail App Password must contain 16 characters after spaces are removed. Run this installer again."
  fi
  save_setting "GMAIL_APP_PASSWORD" "$GMAIL_PASSWORD"
  save_setting "ALERT_EMAIL_FROM" "caseycbarai@gmail.com"
  save_setting "ALERT_EMAIL_TO" "caseycbar@gmail.com"
  save_setting "ALPACA_DATA_FEED" "iex"
  save_setting "PORT" "8765"
  save_setting "STREAM_MAX_SYMBOLS" "180"
  save_setting "CRYPTO_STREAM_ENABLED" "true"
  save_setting "CRYPTO_DATA_LOCATION" "us"
  save_setting "CRYPTO_STREAM_SYMBOLS" "BTC/USD,ETH/USD,SOL/USD,XRP/USD,DOGE/USD,AVAX/USD,LINK/USD,LTC/USD,BCH/USD,UNI/USD"
  save_setting "OPTIONS_VOLUME_ENABLED" "true"
  save_setting "OPTIONS_DATA_FEED" "indicative"
  save_setting "OPTIONS_CORE_SYMBOLS" "SPY,QQQ"
  save_setting "OPTIONS_TOP_SYMBOLS" "5"
  save_setting "OPTIONS_POLL_SECONDS" "120"
  save_setting "STREAM_REFRESH_SECONDS" "60"
  save_setting "STREAM_COOLDOWN_SECONDS" "600"
fi

sed \
  -e "s|__APP_DIR__|$APP_DIR|g" \
  -e "s|__CONFIG_FILE__|$CONFIG_FILE|g" \
  "$SCRIPT_DIR/run_watcher.sh" > "$RUNNER"
chmod 700 "$RUNNER"

sed \
  -e "s|__RUNNER__|$RUNNER|g" \
  -e "s|__LOG_DIR__|$LOG_DIR|g" \
  "$SCRIPT_DIR/com.driftline.market-watcher.plist.template" > "$PLIST"
chmod 600 "$PLIST"
plutil -lint "$PLIST" >/dev/null || fail "The Mac service file did not validate."

DOMAIN="gui/$(id -u)"
if launchctl print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
  printf "Updating the existing background service...\n"
else
  launchctl bootstrap "$DOMAIN" "$PLIST" || fail "macOS could not install the background service."
fi
launchctl enable "$DOMAIN/$LABEL"
launchctl kickstart -k "$DOMAIN/$LABEL" || fail "macOS could not start the background service."

printf "\nWaiting for the live market connection...\n"
for _ in {1..20}; do
  if HEALTH="$(curl --silent --fail --max-time 2 "$HEALTH_URL" 2>/dev/null)"; then
    printf "\n%s\n" "$HEALTH"
    if printf "%s" "$HEALTH" | grep -q '"connected": true'; then
      printf "\nSUCCESS: Driftline is connected and watching the market.\n"
      printf "Live dashboard: %s\n" "$DASHBOARD_URL"
      printf "Logs: %s\n" "$LOG_DIR"
      printf "Keep this Mac powered on, awake, and connected during market hours.\n"
      open "$DASHBOARD_URL"
      pause
      exit 0
    fi
  fi
  sleep 1
done

printf "\nThe service installed, but Alpaca has not connected yet.\n"
printf "Open 'Check Driftline Status.command' for the exact error and next step.\n"
pause
