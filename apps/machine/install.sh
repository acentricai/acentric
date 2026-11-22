#!/bin/sh
# Installs the machine program from the engine that serves this script, enrols this machine with
# it, and keeps it connected as a service that starts again on its own. The engine puts its own
# address in place of __SERVER__ when it serves it, and `acentric machines add` gives the
# command:
#
#   curl -fsSL https://<engine>/install.sh | sh -s -- --id <machine> --token <token>
#
# Run again with no token, it updates the program to the engine's and restarts the service:
#
#   curl -fsSL https://<engine>/install.sh | sh
#
#   --id, --token   enrol as this machine, with the token the engine gave for it
#   --no-service    install and enrol only: run `machine connect` yourself
#   --uninstall     stop the service and remove the program; the enrolment is kept
#
# It needs curl. The program is one file, built for this system. Everything goes in ~/.acentric
# (MACHINE_DIR), and nothing needs root.

set -eu

SERVER='__SERVER__'
DIR="${MACHINE_DIR:-$HOME/.acentric}"
BIN="$DIR/bin"
# What the service is called. For tests, another, so as not to touch the real one.
LABEL="${MACHINE_SERVICE:-dev.acentric.machine}"

id=''
token=''
service=1
uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --id) id="${2:-}"; shift 2 ;;
    --token) token="${2:-}"; shift 2 ;;
    --no-service) service=0; shift ;;
    --uninstall) uninstall=1; shift ;;
    *) echo "install.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this machine runs $os: only macOS and Linux are supported" ;;
esac
case $(uname -m) in
  x86_64|amd64) arch=x64 ;;
  arm64|aarch64) arch=arm64 ;;
  *) fail "this machine's processor, $(uname -m), is not one the machine program is built for" ;;
esac

# The service, as this system keeps one.
systemd_unit="$HOME/.config/systemd/user/$LABEL.service"
launchd_plist="$HOME/Library/LaunchAgents/$LABEL.plist"

stop_service() {
  if [ "$os" = darwin ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  elif command -v systemctl >/dev/null 2>&1; then
    systemctl --user disable --now "$LABEL.service" 2>/dev/null || true
  fi
}

if [ "$uninstall" = 1 ]; then
  stop_service
  rm -f "$launchd_plist" "$systemd_unit"
  rm -rf "$BIN"
  say "Removed the program and its service. The enrolment is kept in $DIR: remove it to forget it."
  exit 0
fi

if [ -n "$token" ] && [ -z "$id" ]; then fail "--token goes with --id, the machine it is for"; fi
command -v curl >/dev/null 2>&1 || fail "it needs curl"
mkdir -p "$BIN"

# The program, as the engine has it for this system, in place of whatever was there.
if ! curl -fsSL "$SERVER/machine/$os-$arch" -o "$BIN/machine.new"; then
  rm -f "$BIN/machine.new"
  fail "$SERVER hands out no machine program for $os-$arch"
fi
chmod +x "$BIN/machine.new"
"$BIN/machine.new" --version >/dev/null 2>&1 || {
  rm -f "$BIN/machine.new"
  fail "the machine program for $os-$arch does not run on this machine"
}
mv "$BIN/machine.new" "$BIN/machine"
# On the PATH, where the user has a folder for their own programs.
for folder in "$HOME/.local/bin" "$HOME/bin"; do
  if [ -d "$folder" ]; then ln -sf "$BIN/machine" "$folder/machine"; break; fi
done
say "Installed $BIN/machine, version $("$BIN/machine" --version)."

if [ -n "$token" ]; then
  stop_service
  MACHINE_DIR="$DIR" "$BIN/machine" enrol --server "$SERVER" --id "$id" --token "$token"
elif [ ! -f "$DIR/machine.json" ]; then
  fail "this machine has not enrolled: give --id and --token, from \`acentric machines add\`"
fi

if [ "$service" = 0 ]; then
  say "Run \`$BIN/machine connect\` to connect it."
  exit 0
fi

if [ "$os" = darwin ]; then
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$launchd_plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN/machine</string><string>connect</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>MACHINE_DIR</key><string>$DIR</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$DIR/machine.log</string>
  <key>StandardErrorPath</key><string>$DIR/machine.log</string>
</dict>
</plist>
PLIST
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$launchd_plist"
  say "Connected, as the service $LABEL: it starts at login and again if it stops. Its log is $DIR/machine.log."
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  mkdir -p "$(dirname "$systemd_unit")"
  cat > "$systemd_unit" <<UNIT
[Unit]
Description=Acentric machine: connects this machine to $SERVER
After=network-online.target

[Service]
Environment=MACHINE_DIR=$DIR
ExecStart=$BIN/machine connect
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
UNIT
  systemctl --user daemon-reload
  systemctl --user enable "$LABEL.service" >/dev/null 2>&1
  systemctl --user restart "$LABEL.service"
  # Without lingering a user's services stop when they log out, and start only when they log in.
  if command -v loginctl >/dev/null 2>&1 && ! loginctl show-user "$(id -un)" -p Linger 2>/dev/null | grep -q yes; then
    loginctl enable-linger "$(id -un)" 2>/dev/null ||
      say "To keep it connected while you are logged out: sudo loginctl enable-linger $(id -un)"
  fi
  say "Connected, as the user service $LABEL. Its log: journalctl --user -u $LABEL"
else
  say "This system has no service manager to use: run \`$BIN/machine connect\` to connect it."
fi
