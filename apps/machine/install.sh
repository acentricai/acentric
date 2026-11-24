#!/bin/sh
# Installs the machine program, `acentric-machine`, from the engine that serves this script. The
# engine puts its own address in SERVER, below, when it serves it. Then, with what the engine
# gave for the machine:
#
#   curl -fsSL https://<engine>/install.sh | sh
#   acentric-machine enrol --server https://<engine> --id <machine> --token <token>
#   acentric-machine connect          # in the background; `acentric-machine disconnect` stops it
#
# Run again, it updates the program to the engine's, and a machine that is connected takes it.
#
#   --id, --token   enrol as this machine as well, with the token the engine gave for it, and
#                   connect it, unless --no-service
#   --no-service    with --id and --token: enrol only
#   --uninstall     disconnect it and remove the program; the enrolment is kept
#
# It needs curl. The program is one file, built for this system. It goes in ~/.acentric/bin
# (MACHINE_DIR), with a link on the PATH, and nothing needs root.

set -eu

SERVER='__SERVER__'
DIR="${MACHINE_DIR:-$HOME/.acentric}"
BIN="$DIR/bin"
PROGRAM="$BIN/acentric-machine"

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

# The links on the PATH this made, of this version and of one before, which named it `machine`.
links() {
  for folder in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
    for name in acentric-machine machine; do
      target=$(readlink "$folder/$name" 2>/dev/null || true)
      if [ "$target" = "$PROGRAM" ] || [ "$target" = "$BIN/machine" ]; then
        printf '%s\n' "$folder/$name"
      fi
    done
  done
}

if [ "$uninstall" = 1 ]; then
  for program in "$PROGRAM" "$BIN/machine"; do
    if [ -x "$program" ]; then MACHINE_DIR="$DIR" "$program" disconnect </dev/null >/dev/null 2>&1 || true; fi
  done
  for link in $(links); do rm -f "$link"; done
  rm -rf "$BIN"
  say "Disconnected it and removed the program. The enrolment is kept in $DIR: remove it to forget it."
  exit 0
fi

if [ -n "$token" ] && [ -z "$id" ]; then fail "--token goes with --id, the machine it is for"; fi
command -v curl >/dev/null 2>&1 || fail "it needs curl"
mkdir -p "$BIN"

# The program, as the engine has it for this system, in place of whatever was there.
if ! curl -fsSL "$SERVER/machine/$os-$arch" -o "$BIN/acentric-machine.new"; then
  rm -f "$BIN/acentric-machine.new"
  fail "$SERVER hands out no machine program for $os-$arch"
fi
chmod +x "$BIN/acentric-machine.new"
"$BIN/acentric-machine.new" --version >/dev/null 2>&1 || {
  rm -f "$BIN/acentric-machine.new"
  fail "the machine program for $os-$arch does not run on this machine"
}
mv "$BIN/acentric-machine.new" "$PROGRAM"
# A version before this one installed it as `machine`, which its service may still run: it is
# this program from now on.
if [ -e "$BIN/machine" ] || [ -L "$BIN/machine" ]; then ln -sf "$PROGRAM" "$BIN/machine"; fi
say "Installed acentric-machine $("$PROGRAM" --version | sed 's/^acentric-machine //'), in $BIN."

# On the PATH: in a folder of the user's that is on it already, so that it runs at once.
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }
linked=''
for folder in "$HOME/.local/bin" "$HOME/bin" /usr/local/bin; do
  if on_path "$folder" && [ -d "$folder" ] && [ -w "$folder" ]; then
    ln -sf "$PROGRAM" "$folder/acentric-machine"
    linked="$folder"
    break
  fi
done
if [ -z "$linked" ] && ! on_path "$BIN"; then
  # None is: the shell's own file puts the program's folder on it, from the next terminal on.
  case "${SHELL:-}" in
    */zsh) profile="$HOME/.zshrc" ;;
    */bash) profile="$HOME/.bashrc"; [ "$os" = darwin ] && profile="$HOME/.bash_profile" ;;
    *) profile="$HOME/.profile" ;;
  esac
  line="export PATH=\"$BIN:\$PATH\""
  if ! grep -qsF "$line" "$profile"; then
    printf '\n# acentric-machine\n%s\n' "$line" >> "$profile"
  fi
  say "Added $BIN to the PATH in $profile. In this terminal, first: $line"
fi

if [ -z "$token" ]; then
  if [ -f "$DIR/machine.json" ]; then
    say "This machine is enrolled: \`acentric-machine connect\` connects it, if it is not already."
  else
    say "Next, enrol it, with the command the engine gave for it: \`acentric-machine enrol --server $SERVER --id … --token …\`."
  fi
  exit 0
fi

MACHINE_DIR="$DIR" "$PROGRAM" disconnect </dev/null >/dev/null 2>&1 || true
MACHINE_DIR="$DIR" "$PROGRAM" enrol --server "$SERVER" --id "$id" --token "$token"
if [ "$service" = 0 ]; then
  say "Run \`acentric-machine connect\` to connect it."
  exit 0
fi
MACHINE_DIR="$DIR" "$PROGRAM" connect --background
