#!/bin/sh
# Builds the Boat saved snapshot a server makes sandboxes from at Boat (boat.dev): the machine
# program, and a service that enrols with what the server wrote into the sandbox and connects.
#
#   deploy/sandbox/boat-template.sh --server https://engine.example.com [--name acentric] [--share]
#   deploy/sandbox/boat-template.sh --binary ./acentric-machine [--name acentric] [--share]
#
# The machine program is the one a server hands out, with --server, or a file of yours, with
# --binary: one for Linux, on the processor Boat's sandboxes have. The name this prints is what
# the server is started with as ACENTRIC_BOAT_TEMPLATE. --share prints a share code instead,
# for a server whose sandboxes are made in other Boat accounts. Needs the boat CLI, logged in,
# and jq.
#
# This has not been run against Boat by whoever wrote it: it follows the script the template
# was built with before the machine program was one file. Read what it prints the first time.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
name=acentric
server=
binary=
share=0
usage() {
  echo "usage: deploy/sandbox/boat-template.sh (--server <url> | --binary <file>) [--name acentric] [--share]" >&2
  exit 2
}
while [ $# -gt 0 ]; do
  case "$1" in
    --name) [ $# -ge 2 ] || usage; name=$2; shift 2 ;;
    --server) [ $# -ge 2 ] || usage; server=${2%/}; shift 2 ;;
    --binary) [ $# -ge 2 ] || usage; binary=$2; shift 2 ;;
    --share) share=1; shift ;;
    *) usage ;;
  esac
done
# One of the two says where the machine program is from.
if [ -z "$server" ] && [ -z "$binary" ]; then usage; fi
if [ -n "$server" ] && [ -n "$binary" ]; then usage; fi
case "$name" in
  ''|[!a-z0-9]*|*[!a-z0-9-]*) echo "the snapshot's name starts with a letter or digit and has only lowercase letters, digits and dashes" >&2; exit 2 ;;
esac
[ "${#name}" -le 63 ] || { echo "the snapshot's name is at most 63 characters" >&2; exit 2; }
case "$server" in
  ''|http://*|https://*) ;;
  *) echo "--server is where a server is reached, such as https://engine.example.com" >&2; exit 2 ;;
esac
if [ -n "$binary" ] && [ ! -f "$binary" ]; then echo "there is no file $binary" >&2; exit 2; fi
boat() { command "${BOAT_BIN:-boat}" "$@"; }

id=$(boat new --type small --no-env --name "$name-template-builder" --json | jq -r 'select(.event == "ready") | .id')
[ -n "$id" ] || { echo "could not create a builder sandbox" >&2; exit 1; }
echo "builder sandbox $id"
trap 'boat delete "$id" --yes >/dev/null 2>&1 || true' EXIT

# The machine program, for the sandbox's own processor.
if [ -n "$server" ]; then
  boat exec "$id" --timeout 300 -- "set -eu
    case \$(uname -m) in x86_64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo unknown processor >&2; exit 1 ;; esac
    curl -fsSL $server/machine/linux-\$arch -o ~/acentric-machine" | jq -r .stdout
else
  boat scp "$binary" "$id:acentric-machine"
fi
boat scp "$here/boot" "$id:acentric-boot"
boat scp "$here/acentric-machine.service" "$id:acentric-machine.service"
boat exec "$id" -- 'set -eu
  sudo install -D -m 755 ~/acentric-machine /usr/local/bin/acentric-machine
  sudo install -D -m 755 ~/acentric-boot /usr/local/lib/acentric/boot
  sudo install -m 644 ~/acentric-machine.service /etc/systemd/system/acentric-machine.service
  rm ~/acentric-machine ~/acentric-boot ~/acentric-machine.service
  sudo systemctl daemon-reload
  sudo systemctl enable acentric-machine.service
  test ! -e ~/.acentric
  acentric-machine --version' | jq -r .stdout

# Returns once the save is complete.
if ! saved=$(boat snapshot "$id" "$name" --json); then
  printf '%s\n' "$saved" >&2
  exit 1
fi
if ! printf '%s\n' "$saved" | jq -e 'select(.event == "saved")' >/dev/null; then
  printf 'the snapshot was not confirmed as saved:\n%s\n' "$saved" >&2
  exit 1
fi
echo "the snapshot $name is saved: start the server with ACENTRIC_BOAT_TEMPLATE=$name"
if [ "$share" = 1 ]; then
  boat snapshot share "$name"
fi
