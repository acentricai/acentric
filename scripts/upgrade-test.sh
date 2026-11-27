#!/bin/sh
# An upgrade, as people make one: the server of the last release, from GHCR, on a folder of
# data, filled through its API and with that release's own command and machine program; then
# this version's image on the same data; then back again, as VERSIONS.md says to go back.
#
#   NEW=ghcr.io/acentricai/acentric-server:test scripts/upgrade-test.sh
#   OLD=0.15.0 NEW=… scripts/upgrade-test.sh          # from another release
#
# The last release is the newest tag v* that is not on this commit. It needs Docker, curl, git
# (with the tags), openssl and Node 24 or newer, and Linux or macOS for the machine program.
# CI runs it on main and before a release is pushed.

set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
new=${NEW:?the image to upgrade to, such as ghcr.io/acentricai/acentric-server:test}
if [ -z "${OLD:-}" ]; then
  head=$(git -C "$root" rev-parse HEAD)
  for tag in $(git -C "$root" tag --list 'v*.*.*' --sort=-v:refname); do
    [ "$(git -C "$root" rev-list -n 1 "$tag")" = "$head" ] && continue
    OLD=${tag#v}
    break
  done
fi
old=${OLD:?there is no release before this commit to upgrade from}
image_old=ghcr.io/acentricai/acentric-server:$old
port=${PORT:-4790}
url="http://127.0.0.1:$port"
work=${WORK:-${TMPDIR:-/tmp}/acentric-upgrade-test}
name=acentric-upgrade-test
secret=$(openssl rand -hex 32)
key=$(openssl rand -hex 24)
rm -rf "$work"
mkdir -p "$work/data" "$work/home/bin"
# The server runs as node (1000) in its image, on a folder of this machine's.
chmod 777 "$work/data"

step() { printf '\n== %s\n' "$*"; }
daemon=''
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  docker logs --tail 40 "$name" >&2 2>/dev/null || true
  exit 1
}
trap '[ -n "$daemon" ] && kill "$daemon" 2>/dev/null; docker stop --time 60 "$name" >/dev/null 2>&1 || true' EXIT

# The server of `$1`, on the data, in the background.
serve() {
  docker run --detach --rm --name "$name" --publish "127.0.0.1:$port:4000" \
    --volume "$work/data:/data" --env ACENTRIC_PUBLIC_URL="$url" \
    --env ACENTRIC_SECRET_KEY="$secret" --env ACENTRIC_ADMIN_KEY="$key" \
    --env ACENTRIC_ANTHROPIC_API_URL=http://127.0.0.1:9998 "$1" > /dev/null
  for attempt in $(seq 1 120); do
    health=$(curl --silent --fail "$url/health" 2>/dev/null) && break
    [ "$attempt" = 120 ] && fail "$1 did not answer at $url/health"
    sleep 1
  done
  echo "$health"
}
stop() { docker stop --time 60 "$name" > /dev/null; }
api() { curl --silent --show-error --fail -H "authorization: Bearer $key" "$@"; }
field() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
# What is kept, as the API says it: the same before and after.
kept() {
  {
    api "$url/v1/agents" | field '.items.map((a) => a.id + " " + a.name).join("\n")'
    api "$url/v1/accounts" | field '.items.map((a) => a.id + " " + a.name).join("\n")'
    api "$url/v1/actors?agent=$agent" | field '.items.map((a) => a.id).join("\n")'
    api "$url/v1/agents/$agent/secrets" | field '.items.map((s) => s.name).join("\n")'
    api "$url/v1/machines" | field '.items.map((m) => m.id + " " + m.name).join("\n")'
    api "$url/v1/keys" | field '.items.map((k) => k.id).join("\n")'
  } | sort
}

step "$old, from GHCR, on new data"
docker pull --quiet "$image_old" > /dev/null
serve "$image_old"

step "Filled with $old's own command and machine program"
export HOME="$work/home" ACENTRIC_DIR="$work/home/.acentric" ENGINE_URL="$url" ENGINE_API_KEY="$key"
curl --silent --fail "$url/install-cli.sh" | sh > /dev/null
acentric="$work/home/.acentric/bin/acentric"
(cd "$work" && "$acentric" init project --agent hello > /dev/null)
(cd "$work/project" && "$acentric" deploy)
agent=$(api "$url/v1/agents?name=hello" | field '.items[0].id')
# Anthropic's API is a stand-in in the server's container, which takes any key: an actor is
# made with a model account, whose key is checked when it is added, and no model is called.
docker exec -d "$name" node -e "$(cat "$root/deploy/anthropic-stand-in.js")"
for attempt in $(seq 1 10); do
  api -X POST -H 'content-type: application/json' \
    -d '{"provider":"anthropic","name":"main","apiKey":"a-key-for-the-stand-in"}' \
    "$url/v1/accounts" > /dev/null 2>&1 && break
  [ "$attempt" = 10 ] && fail "no model account was added"
  sleep 1
done
api -X POST -H 'content-type: application/json' -d '{}' "$url/v1/agents/$agent/actors" > /dev/null
api -X PUT -H 'content-type: application/json' -d '{"value":"sealed by the release"}' \
  "$url/v1/agents/$agent/secrets/HELLO_KEY" > /dev/null
api -X POST -H 'content-type: application/json' \
  -d '{"label":"for CI","scope":{"type":"engine"},"permissions":["agents:deploy"]}' "$url/v1/keys" > /dev/null
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) system=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) system=linux-arm64 ;;
  Darwin-x86_64) system=darwin-x64 ;;
  Darwin-arm64) system=darwin-arm64 ;;
  *) fail "no machine program for $(uname -s) $(uname -m)" ;;
esac
curl --silent --fail -o "$work/acentric-machine" "$url/machine/$system"
chmod +x "$work/acentric-machine"
made=$(api -X POST -H 'content-type: application/json' -d '{"name":"build-box","agents":"*"}' "$url/v1/machines")
machine=$(echo "$made" | field .machine.id)
export MACHINE_DIR="$work/machine" MACHINE_SHELL=none MACHINE_RECONNECT_MS=500
"$work/acentric-machine" enrol --server "$url" --id "$machine" --token "$(echo "$made" | field .token)"
"$work/acentric-machine" connect > "$work/daemon.log" 2>&1 &
daemon=$!
online() { [ "$(api "$url/v1/machines/$machine" | field .online)" = true ]; }
for attempt in $(seq 1 60); do
  online && break
  [ "$attempt" = 60 ] && { cat "$work/daemon.log" >&2; fail "$old's daemon did not come online"; }
  sleep 1
done
before=$(kept)
echo "$before" | sed 's/^/  /'
schema_old=$(docker run --rm --volume "$work/data:/data" --entrypoint node "$image_old" \
  -e "const d=new (require('node:sqlite').DatabaseSync)('/data/engine.sqlite',{readOnly:true});console.log(d.prepare('PRAGMA user_version').get().user_version)")
echo "schema $schema_old"

step "Upgraded to $new, on the same data"
stop
serve "$new"
[ "$(kept)" = "$before" ] || { printf 'before:\n%s\nafter:\n%s\n' "$before" "$(kept)"; fail "what was kept is not as it was"; }
echo "what was kept is as it was"
upgraded=$(api "$url/v1/backups" | field '.items.filter((b) => b.kind === "before-upgrade").map((b) => b.name).join(" ")')
schema_new=$(docker run --rm --volume "$work/data:/data" --entrypoint node "$new" \
  -e "const d=new (require('node:sqlite').DatabaseSync)('/data/engine.sqlite',{readOnly:true});console.log(d.prepare('PRAGMA user_version').get().user_version)")
echo "schema $schema_old to $schema_new"
if [ "$schema_new" != "$schema_old" ]; then
  [ -n "$upgraded" ] || fail "the database was changed with no backup before it"
  echo "backed up first, as $upgraded"
else
  [ -z "$upgraded" ] || fail "a backup before an upgrade was taken, and the database is the same"
  echo "the same database, and no backup before it"
fi
for attempt in $(seq 1 60); do
  online && break
  [ "$attempt" = 60 ] && { tail -20 "$work/daemon.log" >&2; fail "$old's daemon did not connect to $new"; }
  sleep 1
done
echo "$old's daemon is connected"
(cd "$work/project" && "$acentric" deploy) || fail "$old's command does not deploy to $new"
echo "$old's command deploys"
# What is done after the upgrade, which going back takes back.
api -X POST -H 'content-type: application/json' -d '{"name":"after-upgrade"}' "$url/v1/machines" > /dev/null

step "Back to $old"
stop
kill "$daemon" 2>/dev/null || true
daemon=''
if [ "$schema_new" != "$schema_old" ]; then
  # Not on what the newer version changed: it is refused, and left as it is.
  if docker run --rm --volume "$work/data:/data" --env ACENTRIC_SECRET_KEY="$secret" \
    --env ACENTRIC_ADMIN_KEY="$key" "$image_old" > "$work/refused.log" 2>&1; then
    fail "$old started on a database $new changed"
  fi
  grep -q 'made by a newer one' "$work/refused.log" || { cat "$work/refused.log" >&2; fail "$old did not say why"; }
  echo "$old refuses the changed database: $(grep -o 'The database is at.*' "$work/refused.log" | head -1)"
  docker run --rm --volume "$work/data:/data" --env ACENTRIC_SECRET_KEY="$secret" "$image_old" \
    acentric-server restore "/data/backups/$upgraded"
fi
serve "$image_old"
after=$(kept)
if [ "$schema_new" != "$schema_old" ]; then
  [ "$after" = "$before" ] || { printf 'before:\n%s\nback:\n%s\n' "$before" "$after"; fail "going back is not as it was before"; }
  echo "as it was before the upgrade"
else
  echo "$after" | grep -q 'after-upgrade' || fail "$old does not have what $new kept"
  echo "$old opens what $new kept"
fi

step "Passed: $old to $new and back"
