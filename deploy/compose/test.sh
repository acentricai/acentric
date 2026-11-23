#!/bin/sh
# Brings this recipe up on this machine, as it is, with Caddy's own certificate for localhost,
# and checks what a server behind it is used for, through Caddy:
#
#   ACENTRIC_VERSION=0.15.0 deploy/compose/test.sh     # an image of GHCR's
#   ACENTRIC_VERSION=test deploy/compose/test.sh       # ghcr.io/acentricai/acentric-server:test,
#                                                      # tagged from a build of this repository
#
# It needs Docker with Compose, curl, openssl and Node 24 or newer. The command it installs goes
# into a home of its own, under the work folder. It stops what it started, and leaves Docker's
# volumes of the test project (acentric-recipe-test_*) for another run.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
# Docker's own folder, with its plugins, stays where it is when the command's home is changed.
export DOCKER_CONFIG="${DOCKER_CONFIG:-$HOME/.docker}"
version=${ACENTRIC_VERSION:?the image version to test, such as 0.15.0}
http_port=${HTTP_PORT:-8080}
https_port=${HTTPS_PORT:-8443}
url="https://localhost:$https_port"
work=${WORK:-${TMPDIR:-/tmp}/acentric-recipe-test}
project=acentric-recipe-test
mkdir -p "$work"
cp "$here/compose.yaml" "$here/Caddyfile" "$work/"

# The settings of a test server, from the recipe's example, as its README has them made.
sed -e "s|^ACENTRIC_PUBLIC_URL=.*|ACENTRIC_PUBLIC_URL=$url|" "$here/.env.example" > "$work/.env"
printf 'ACENTRIC_HTTP_PORT=%s\nACENTRIC_HTTPS_PORT=%s\n' "$http_port" "$https_port" >> "$work/.env"
# Its keys, made once and kept with its volumes, which have what they sealed.
if [ ! -d "$work/secrets" ]; then
  install -d -m 700 "$work/secrets"
  openssl rand -hex 32 > "$work/secrets/secret-key"
  openssl rand -hex 24 > "$work/secrets/admin-key"
fi
key=$(cat "$work/secrets/admin-key")
# The test's own names, as its volumes are kept from one run to the next.
run=$(date +%s)
compose() { ACENTRIC_VERSION=$version docker compose -p "$project" --project-directory "$work" "$@"; }
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; compose logs --tail 40 >&2 || true; exit 1; }
daemon=''
# A store that speaks S3's API, for the bucket backups are copied to: started near the end.
s3="$project-s3"
trap '[ -n "$daemon" ] && kill "$daemon" 2>/dev/null; docker stop "$s3" >/dev/null 2>&1; compose down >/dev/null 2>&1 || true' EXIT

step "Up, with the server healthy before Caddy starts"
compose up --detach --wait --wait-timeout 180

step "Its keys are files, not settings of its environment"
if compose exec -T server env | grep -q '^ACENTRIC_SECRET_KEY=\|^ACENTRIC_ADMIN_KEY='; then
  fail "a key is in the server's environment"
fi
if docker inspect "$(compose ps -q server)" | grep -q "$key"; then
  fail "the admin key is in what docker inspect shows"
fi
echo "neither is in the environment, nor in what docker inspect shows"

step "Caddy's own root certificate, which its certificate for localhost is signed by"
for attempt in $(seq 1 30); do
  compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$work/root.crt" >/dev/null 2>&1 && break
  [ "$attempt" = 30 ] && fail "Caddy made no certificate"
  sleep 1
done
get() { curl --fail --silent --show-error --cacert "$work/root.crt" "$@"; }

step "HTTPS, to the server's version"
for attempt in $(seq 1 30); do
  health=$(get "$url/health" 2>/dev/null) && break
  [ "$attempt" = 30 ] && fail "no answer at $url/health"
  sleep 1
done
echo "$health"
echo "$health" | grep -q '"ok":true' || fail "the server is not up"

step "Plain HTTP is sent to HTTPS (to port 443: on other ports, people use the HTTPS address)"
location=$(curl --silent --output /dev/null --write-out '%{redirect_url}' "http://localhost:$http_port/health")
echo "$location"
case "$location" in https://localhost*) ;; *) fail "http is not sent to https" ;; esac

step "The server's own port is on no port of this machine"
if curl --silent --max-time 3 --output /dev/null http://localhost:4000/health; then
  fail "the server is reached without Caddy"
fi
echo "not reached"

step "The dashboard, and the address its links and scripts start with"
get "$url/setup" | grep -q '<div id="root">' || fail "no dashboard"
get "$url/install-cli.sh" | grep -q "SERVER='$url'" || fail "install-cli.sh has another address"
get "$url/install.sh" | grep -q "$url" || fail "install.sh has another address"
echo "both scripts have $url"

step "The command, installed from the server, makes a project and deploys its agent"
home="$work/home"
mkdir -p "$home/bin"
# curl and Node trust Caddy's root here, as a machine whose own trust has it would. A curl in
# front of the one there is, as not every curl reads CURL_CA_BUNDLE (macOS's does not).
real_curl=$(command -v curl)
printf '#!/bin/sh\nexec "%s" --cacert "%s" "$@"\n' "$real_curl" "$work/root.crt" > "$home/bin/curl"
chmod +x "$home/bin/curl"
export HOME="$home" PATH="$home/bin:$PATH" ACENTRIC_DIR="$home/.acentric" \
  NODE_EXTRA_CA_CERTS="$work/root.crt" ENGINE_URL="$url" ENGINE_API_KEY="$key"
get "$url/install-cli.sh" | sh
acentric="$home/.acentric/bin/acentric"
rm -rf "$work/project"
(cd "$work" && "$acentric" init project --agent hello)
(cd "$work/project" && "$acentric" deploy)

step "An actor, and its events as they come through Caddy"
agent=$(get -H "authorization: Bearer $key" "$url/v1/agents?name=hello" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).items[0].id))')
actor=$(get -H "authorization: Bearer $key" -H 'content-type: application/json' -d '{}' \
  "$url/v1/agents/$agent/actors" | node -e 'let s="";process.stdin.on("data",(d)=>s+=d).on("end",()=>console.log(JSON.parse(s).actor.id))')
echo "actor $actor"
# The stream is held open: what came in its first seconds is what Caddy let through at once.
curl --silent --no-buffer --max-time 5 --cacert "$work/root.crt" -H "authorization: Bearer $key" \
  "$url/v1/actors/$actor/events" > "$work/events.txt" || true
head -c 300 "$work/events.txt"; echo
grep -q '^event:' "$work/events.txt" || fail "no event came through"

step "A machine's daemon enrols and connects through Caddy, trusting Caddy's authority"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) system=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) system=linux-arm64 ;;
  Darwin-x86_64) system=darwin-x64 ;;
  Darwin-arm64) system=darwin-arm64 ;;
  *) fail "no machine program for $(uname -s) $(uname -m)" ;;
esac
get -o "$work/acentric-machine" "$url/machine/$system"
chmod +x "$work/acentric-machine"
machine_of() {
  get -H "authorization: Bearer $key" -H 'content-type: application/json' \
    -d "{\"name\":\"$1\",\"agents\":\"*\"}" "$url/v1/machines"
}
field() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }
# Without it, Caddy's authority is one the daemon does not know: it does not enrol.
made=$(machine_of "untrusted-$run")
if MACHINE_DIR="$work/untrusted" "$work/acentric-machine" enrol --server "$url" \
  --id "$(echo "$made" | field .machine.id)" --token "$(echo "$made" | field .token)" 2> "$work/untrusted.txt"; then
  fail "a daemon enrolled with an engine whose certificate it has no authority for"
fi
echo "without it: $(head -c 160 "$work/untrusted.txt")"
# With it named by SSL_CERT_FILE, as for an organisation's own authority, it enrols and stays.
made=$(machine_of "trusted-$run")
machine=$(echo "$made" | field .machine.id)
export SSL_CERT_FILE="$work/root.crt" MACHINE_DIR="$work/machine" MACHINE_SHELL=none
rm -rf "$work/machine"
"$work/acentric-machine" enrol --server "$url" --id "$machine" --token "$(echo "$made" | field .token)"
"$work/acentric-machine" connect > "$work/daemon.log" 2>&1 &
daemon=$!
for attempt in $(seq 1 60); do
  [ "$(get -H "authorization: Bearer $key" "$url/v1/machines/$machine" | field .online)" = true ] && break
  [ "$attempt" = 60 ] && { cat "$work/daemon.log" >&2; fail "the machine did not come online"; }
  sleep 1
done
echo "machine $machine is online, through Caddy"

step "The server's own backup, taken when asked, in its volume"
taken=$(get -H "authorization: Bearer $key" -X POST "$url/v1/backups" | field .name)
compose exec -T server ls /backups | grep -qx "$taken" || fail "$taken is not in /backups"
echo "$taken is in /backups"

step "A backup taken beside the running server, checked, and put back with it stopped"
compose exec -T server acentric-server backup > "$work/backup.tar"
compose exec -T server acentric-server check-backup < "$work/backup.tar"
# What is done after the backup, which putting it back takes back.
machine_of "after-backup-$run" > /dev/null
compose stop server
compose run --rm --no-deps -T server acentric-server restore < "$work/backup.tar"
compose up --detach --wait --wait-timeout 180
machines=$(get -H "authorization: Bearer $key" "$url/v1/machines")
echo "$machines" | grep -q "\"trusted-$run\"" || fail "what was backed up is not there"
if echo "$machines" | grep -q "\"after-backup-$run\""; then fail "what came after the backup is still there"; fi
compose exec -T server sh -c 'ls -d /data/before-restore-*' || fail "what was there before is not kept"
echo "put back: what was backed up is there, what came after is not, and what was is kept aside"

step "Backups copied to a bucket, at a store that speaks S3's API, and one put back from it"
docker run --detach --rm --name "$s3" --network "${project}_default" --tmpfs /data \
  versity/versitygw:v1.10.0 --access test-access-key --secret test-secret-key posix /data > /dev/null
sleep 2
docker exec "$s3" mkdir /data/acentric-test
export ACENTRIC_BACKUP_URL=s3://acentric-test/acentric AWS_ENDPOINT_URL_S3="http://$s3:7070" \
  AWS_ACCESS_KEY_ID=test-access-key AWS_SECRET_ACCESS_KEY=test-secret-key AWS_REGION=us-east-1
compose up --detach --wait --wait-timeout 180
copied=$(get -H "authorization: Bearer $key" -X POST "$url/v1/backups" | field .name)
docker exec "$s3" ls /data/acentric-test/acentric | grep -qx "$copied" || fail "$copied is not in the bucket"
status=$(get -H "authorization: Bearer $key" "$url/v1/backups")
[ "$(echo "$status" | field .bucket.error)" = null ] || fail "the bucket is not reached: $status"
echo "$status" | field ".items.find((b) => b.name === '$copied').inBucket" | grep -qx true \
  || fail "$copied is not said to be in the bucket"
echo "$copied is in s3://acentric-test/acentric"
machine_of "after-copy-$run" > /dev/null
compose stop server
compose run --rm --no-deps -T server acentric-server restore "s3://acentric-test/acentric/$copied"
compose up --detach --wait --wait-timeout 180
machines=$(get -H "authorization: Bearer $key" "$url/v1/machines")
echo "$machines" | grep -q "\"trusted-$run\"" || fail "what was copied is not there"
if echo "$machines" | grep -q "\"after-copy-$run\""; then fail "what came after the copy is still there"; fi
echo "put back from the bucket"

step "Passed"
