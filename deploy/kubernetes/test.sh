#!/bin/sh
# Puts this recipe's server on the cluster kubectl is set to, as it is, and checks what it is
# used for, through a port-forward to its Service:
#
#   ACENTRIC_VERSION=test deploy/kubernetes/test.sh
#
# The image ghcr.io/acentricai/acentric-server:$ACENTRIC_VERSION must be one the cluster has or
# can pull. It needs kubectl, curl, openssl and Node 24 or newer. It makes the namespace
# acentric, and removes it at the end, with its volume. The command it installs, and the
# machine program it runs, go in a folder of their own.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
version=${ACENTRIC_VERSION:?the image version to test, such as 0.15.0}
port=${PORT:-4710}
url="http://127.0.0.1:$port"
work=${WORK:-${TMPDIR:-/tmp}/acentric-kubernetes-test}
rm -rf "$work" && mkdir -p "$work/overlay" && cp -R "$here/base" "$work/base"
key=$(openssl rand -hex 24)
step() { printf '\n== %s\n' "$*"; }
fail() {
  printf 'FAILED: %s\n' "$*" >&2
  kubectl -n acentric get pods -o wide >&2 || true
  kubectl -n acentric logs statefulset/acentric --tail 40 >&2 || true
  exit 1
}
forward=''
daemon=''
cleanup() {
  [ -n "$daemon" ] && kill "$daemon" 2>/dev/null || true
  [ -n "$forward" ] && kill "$forward" 2>/dev/null || true
  kubectl delete namespace acentric --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

# The recipe as it is, with only the version, and where the test reaches it, of its own.
cat > "$work/overlay/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - ../base
images:
  - name: ghcr.io/acentricai/acentric-server
    newTag: $version
configMapGenerator:
  - name: acentric-settings
    behavior: replace
    literals:
      - ACENTRIC_PUBLIC_URL=$url
EOF

step "The namespace, the secrets, and the server"
kubectl create namespace acentric --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n acentric create secret generic acentric-secrets \
  --from-literal=ACENTRIC_SECRET_KEY="$(openssl rand -hex 32)" \
  --from-literal=ACENTRIC_ADMIN_KEY="$key"
kubectl apply -k "$work/overlay"
kubectl -n acentric rollout status statefulset/acentric --timeout 240s || fail "the server did not start"

forwarded() {
  kubectl -n acentric port-forward service/acentric "$port:80" > "$work/forward.log" 2>&1 &
  forward=$!
  for attempt in $(seq 1 30); do
    curl --fail --silent --output /dev/null "$url/health" && return 0
    sleep 1
  done
  fail "no answer through the port-forward"
}
forwarded
get() { curl --fail --silent --show-error -H "authorization: Bearer $key" "$@"; }
json() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(eval('JSON.parse(s)'+process.argv[1])))" "$1"; }

step "Its version, and its dashboard"
health=$(get "$url/health")
echo "$health"
echo "$health" | grep -q '"ok":true' || fail "the server is not up"
get "$url/setup" | grep -q '<div id="root">' || fail "no dashboard"
get "$url/install-cli.sh" | grep -q "SERVER='$url'" || fail "install-cli.sh has another address"

step "The command, installed from the server, makes a project and deploys its agent"
home="$work/home"
mkdir -p "$home"
(
  export HOME="$home" ACENTRIC_DIR="$home/.acentric" ENGINE_URL="$url" ENGINE_API_KEY="$key"
  get "$url/install-cli.sh" | sh
  cd "$work" && "$home/.acentric/bin/acentric" init project --agent hello
  cd "$work/project" && "$home/.acentric/bin/acentric" deploy
)
agent=$(get "$url/v1/agents?name=hello" | json '.items[0].id')
actor=$(get -H 'content-type: application/json' -d '{}' "$url/v1/agents/$agent/actors" | json '.actor.id')
echo "agent $agent, actor $actor"
curl --silent --no-buffer --max-time 5 -H "authorization: Bearer $key" \
  "$url/v1/actors/$actor/events" > "$work/events.txt" || true
grep -q '^event:' "$work/events.txt" || fail "no event came"
head -c 200 "$work/events.txt"; echo

step "A machine enrols, and its daemon stays connected"
case "$(uname -s)-$(uname -m)" in
  Linux-x86_64) system=linux-x64 ;;
  Linux-aarch64 | Linux-arm64) system=linux-arm64 ;;
  Darwin-x86_64) system=darwin-x64 ;;
  Darwin-arm64) system=darwin-arm64 ;;
  *) fail "no machine program for $(uname -s) $(uname -m)" ;;
esac
curl --fail --silent --show-error -o "$work/acentric-machine" "$url/machine/$system"
chmod +x "$work/acentric-machine"
made=$(get -H 'content-type: application/json' -d '{"name":"test-box","agents":"*"}' "$url/v1/machines")
machine=$(echo "$made" | json '.machine.id')
token=$(echo "$made" | json '.token')
export MACHINE_DIR="$work/machine" MACHINE_SHELL=none
"$work/acentric-machine" enrol --server "$url" --id "$machine" --token "$token"
"$work/acentric-machine" connect > "$work/daemon.log" 2>&1 &
daemon=$!
online() {
  for attempt in $(seq 1 60); do
    [ "$(get "$url/v1/machines/$machine" | json '.online')" = true ] && return 0
    sleep 1
  done
  return 1
}
online || fail "the machine did not come online"
echo "machine $machine is online"

step "Its pod is replaced: what it kept is there, and the daemon connects again"
kill "$forward" 2>/dev/null || true
kubectl -n acentric delete pod acentric-0 --wait=true
kubectl -n acentric rollout status statefulset/acentric --timeout 240s || fail "it did not start again"
forwarded
[ "$(get "$url/v1/agents?name=hello" | json '.items.length')" = 1 ] || fail "the agent is gone"
[ "$(get "$url/v1/actors/$actor" | json '.id')" = "$actor" ] || fail "the actor is gone"
online || { cat "$work/daemon.log" >&2; fail "the machine did not come back online"; }
echo "the agent, the actor and the machine are as they were"

step "A backup taken beside the running server, and put back by a pod of its own with it stopped"
kubectl -n acentric exec acentric-0 -- acentric-server backup > "$work/backup.tar"
get -H 'content-type: application/json' -d '{"name":"after-backup"}' "$url/v1/machines" > /dev/null
kill "$forward" 2>/dev/null || true
kubectl -n acentric scale statefulset/acentric --replicas=0
kubectl -n acentric wait --for=delete pod/acentric-0 --timeout=120s
image=$(kubectl -n acentric get statefulset/acentric -o jsonpath='{.spec.template.spec.containers[0].image}')
kubectl -n acentric run acentric-restore --image="$image" --restart=Never --rm -i --quiet \
  --overrides="$(cat <<JSON
{
  "spec": {
    "enableServiceLinks": false,
    "securityContext": { "runAsNonRoot": true, "runAsUser": 1000, "fsGroup": 1000 },
    "volumes": [{ "name": "data", "persistentVolumeClaim": { "claimName": "data-acentric-0" } }],
    "containers": [{
      "name": "acentric-restore",
      "image": "$image",
      "stdin": true,
      "stdinOnce": true,
      "command": ["acentric-server", "restore"],
      "envFrom": [{ "secretRef": { "name": "acentric-secrets" } }],
      "volumeMounts": [{ "name": "data", "mountPath": "/data" }]
    }]
  }
}
JSON
)" < "$work/backup.tar"
kubectl -n acentric scale statefulset/acentric --replicas=1
kubectl -n acentric rollout status statefulset/acentric --timeout 240s || fail "it did not start on what was put back"
forwarded
machines=$(get "$url/v1/machines")
echo "$machines" | grep -q '"test-box"' || fail "what was backed up is not there"
if echo "$machines" | grep -q '"after-backup"'; then fail "what came after the backup is still there"; fi
echo "put back: what was backed up is there, and what came after is not"

step "Passed"
