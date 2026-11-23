#!/bin/sh
# Runs this folder's server under systemd on this machine, as it is, first by Docker
# (acentric.service), then by Podman (acentric.container), and checks for each that it starts,
# keeps what it was given, is started again by systemd when it dies, and stops:
#
#   sudo ACENTRIC_VERSION=test deploy/systemd/test.sh
#
# For a Linux machine with systemd, Docker and Podman 4.4 or newer, as root: it is what CI runs.
# The image ghcr.io/acentricai/acentric-server:$ACENTRIC_VERSION must be in Docker. It writes
# /etc/acentric/acentric.env and the two unit files, and removes them at the end.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=${ACENTRIC_VERSION:?the image version to test, such as 0.15.0}
image=ghcr.io/acentricai/acentric-server:$version
url=http://127.0.0.1:4000
key=$(openssl rand -hex 24)
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  systemctl status acentric --no-pager >&2 || true
  journalctl -u acentric --no-pager -n 40 >&2 || true
  exit 1
}
cleanup() {
  systemctl stop acentric >/dev/null 2>&1 || true
  rm -f /etc/systemd/system/acentric.service /etc/containers/systemd/acentric.container
  systemctl daemon-reload || true
  rm -rf /etc/acentric
}
trap cleanup EXIT

mkdir -p /etc/acentric
sed -e "s|^ACENTRIC_VERSION=.*|ACENTRIC_VERSION=$version|" \
  -e "s|^ACENTRIC_PUBLIC_URL=.*|ACENTRIC_PUBLIC_URL=$url|" \
  "$here/acentric.env.example" > /etc/acentric/acentric.env
chmod 600 /etc/acentric/acentric.env
# The keys, as the README has them made.
install -d -m 700 /etc/acentric/secrets
openssl rand -hex 32 > /etc/acentric/secrets/secret-key
printf '%s\n' "$key" > /etc/acentric/secrets/admin-key
chmod 644 /etc/acentric/secrets/*

up() {
  for attempt in $(seq 1 90); do
    curl --fail --silent --output /dev/null "$url/health" && return 0
    sleep 1
  done
  fail "no answer at $url/health"
}
get() { curl --fail --silent --show-error -H "authorization: Bearer $key" "$@"; }

# What a server is checked for, whichever runs it. $1 kills its container.
check() {
  up
  health=$(get "$url/health")
  echo "$health"
  echo "$health" | grep -q '"version"' || fail "it says no version"
  name="kept-$(date +%s)"
  get -H 'content-type: application/json' -d "{\"name\":\"$name\"}" "$url/v1/machines" > /dev/null
  echo "made the machine $name"

  step "It dies, and systemd starts it again, with what it kept"
  "$@" kill acentric > /dev/null
  sleep 3
  up
  get "$url/v1/machines" | grep -q "\"$name\"" || fail "the machine $name is gone"
  systemctl is-active --quiet acentric || fail "systemd does not have it running"
  echo "it is running again, and has $name"

  step "It stops, and its container goes"
  systemctl stop acentric
  if "$@" ps --all --format '{{.Names}}' | grep -qx acentric; then fail "its container is left"; fi
  echo "stopped, and no container is left"
}

step "acentric.service, by Docker"
install -m 644 "$here/acentric.service" /etc/systemd/system/acentric.service
systemctl daemon-reload
systemctl start acentric
check docker

step "A backup taken beside it, and put back with it stopped"
systemctl start acentric
up
backup=$(mktemp)
docker exec acentric acentric-server backup > "$backup"
get -H 'content-type: application/json' -d '{"name":"after-backup"}' "$url/v1/machines" > /dev/null
systemctl stop acentric
docker run --rm -i --env-file /etc/acentric/acentric.env --volume acentric-data:/data \
  --volume /etc/acentric/secrets/secret-key:/run/secrets/acentric/secret-key:ro \
  "$image" acentric-server restore < "$backup"
systemctl start acentric
up
if get "$url/v1/machines" | grep -q '"after-backup"'; then fail "what came after the backup is still there"; fi
echo "put back: what came after the backup is not there"
systemctl stop acentric
rm -f "$backup" /etc/systemd/system/acentric.service

step "acentric.container, by Podman"
docker save "$image" | podman load > /dev/null
mkdir -p /etc/containers/systemd
sed "s|^Image=.*|Image=$image|" "$here/acentric.container" > /etc/containers/systemd/acentric.container
systemctl daemon-reload
systemctl start acentric
check podman

step "Passed"
