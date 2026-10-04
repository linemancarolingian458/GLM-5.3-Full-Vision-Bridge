#!/bin/bash
# Installs vision-proxy as a per-user macOS LaunchAgent: starts at login, restarts if it exits.
#
#   VP_UPSTREAM=http://<chat-server>:<port> VP_OLLAMA=http://<ollama-host>:11434 ./deploy/install.sh
#
# Every VP_* variable set when you run this is written into the LaunchAgent; anything not set
# uses the built-in default (see README). Re-run with new values to change settings.
#   --dry-run   print the LaunchAgent instead of installing it
set -euo pipefail
LABEL=local.vision-proxy
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/vision-proxy.log"
DRY_RUN=false
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=true; fi

if [ -z "${VP_UPSTREAM:-}" ]; then
  echo "VP_UPSTREAM is required: the OpenAI-compatible chat server to forward to, for example" >&2
  echo "  VP_UPSTREAM=http://127.0.0.1:8000 $0" >&2
  exit 1
fi

NODE="$(command -v node || true)"
if [ -z "$NODE" ]; then
  echo "node was not found on PATH; install Node.js 23.6 or newer" >&2
  exit 1
fi
"$NODE" -e '
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 23 || (major === 23 && minor < 6)) {
    console.error(`vision-proxy needs Node 23.6+ (it runs TypeScript directly); found ${process.version}`);
    process.exit(1);
  }'

xml_escape() {
  local value="$1"
  value="${value//&/&amp;}"
  value="${value//</&lt;}"
  value="${value//>/&gt;}"
  printf '%s' "$value"
}

settings=""
for name in $(compgen -e | grep '^VP_' | sort); do
  settings+="    <key>$name</key><string>$(xml_escape "${!name}")</string>"$'\n'
done

plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml_escape "$NODE")</string>
    <string>$(xml_escape "$REPO/src/main.ts")</string>
  </array>
  <key>WorkingDirectory</key><string>$(xml_escape "$REPO")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$(xml_escape "$LOG")</string>
  <key>StandardErrorPath</key><string>$(xml_escape "$LOG")</string>
  <key>EnvironmentVariables</key>
  <dict>
${settings}  </dict>
</dict>
</plist>"

if $DRY_RUN; then
  printf '%s\n' "$plist"
  exit 0
fi

mkdir -p "$(dirname "$PLIST")" "$(dirname "$LOG")"
printf '%s\n' "$plist" > "$PLIST"
plutil -lint "$PLIST" >/dev/null

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
for _ in $(seq 1 20); do
  if nc -z 127.0.0.1 "${VP_PORT:-11435}" 2>/dev/null; then break; fi
  sleep 0.5
done
echo "Installed $LABEL ($PLIST)"
echo "Log: $LOG"
tail -n 1 "$LOG"
