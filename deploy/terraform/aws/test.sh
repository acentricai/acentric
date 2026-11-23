#!/bin/sh
# Makes this recipe in an AWS account, as it is, checks what a server made by it is for, makes
# its instance again as an upgrade does, and removes everything it made:
#
#   AWS_PROFILE=<profile> AWS_REGION=eu-west-1 deploy/terraform/aws/test.sh
#
# It costs a few cents: an instance for a quarter of an hour, and what it keeps. It needs
# Terraform 1.6 or newer (or OpenTofu, as TERRAFORM=tofu), the AWS CLI, curl and Node 24 or
# newer, with credentials that may make all of it. The server's name is <its address>.sslip.io,
# and Caddy gets a certificate from Let's Encrypt for it.

set -eu
here=$(cd "$(dirname "$0")" && pwd)
terraform=${TERRAFORM:-terraform}
region=${AWS_REGION:?the region to test in, such as eu-west-1}
version=${ACENTRIC_VERSION:-0.15.0}
run=$(date +%s)
name=acentric-test-$run
work=${WORK:-${TMPDIR:-/tmp}/acentric-terraform-test-$run}
# A copy of the recipe, and of the systemd recipe's files it reads, with its state beside it.
mkdir -p "$work/deploy/terraform/aws" "$work/deploy/systemd"
cp "$here"/*.tf "$here"/*.tftpl "$here/.terraform.lock.hcl" "$work/deploy/terraform/aws/"
cp "$here/../../systemd/acentric.service" "$here/../../systemd/Caddyfile" "$work/deploy/systemd/"

tf() { "$terraform" -chdir="$work/deploy/terraform/aws" "$@"; }
out() { tf output -raw "$1"; }
step() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAILED: %s\n' "$*" >&2; exit 1; }
vars="-var region=$region -var name=$name -var acentric_version=$version -var bucket_force_destroy=true -var instance_type=t4g.small"
# Whatever happens, what it made is removed: and the snapshot the data volume leaves when it
# is, which the recipe keeps for a server that is removed, and a test does not need.
cleanup() {
  step "Removing what it made"
  # shellcheck disable=SC2086
  if tf destroy -auto-approve -input=false $vars > "$work/destroy.log" 2>&1; then
    for snapshot in $(aws ec2 describe-snapshots --region "$region" --owner-ids self \
      --filters "Name=tag:acentric:name,Values=$name" --query 'Snapshots[].SnapshotId' --output text); do
      aws ec2 delete-snapshot --region "$region" --snapshot-id "$snapshot"
    done
    echo removed
  else
    tail -30 "$work/destroy.log" >&2
    echo "NOT ALL REMOVED: see $work" >&2
  fi
}
trap cleanup EXIT

field() { node -e "let s='';process.stdin.on('data',(d)=>s+=d).on('end',()=>console.log(JSON.parse(s)$1))"; }

step "Made, as $name in $region"
tf init -input=false > "$work/init.log"
# shellcheck disable=SC2086
tf apply -auto-approve -input=false $vars > "$work/apply.log" 2>&1 || { tail -40 "$work/apply.log" >&2; fail "it was not made"; }
url=$(out url)
key=$(sh -c "$(out admin_key_command)")
echo "$url, instance $(out instance_id)"
get() { curl --fail --silent --show-error --max-time 20 "$@"; }

step "HTTPS, with a certificate of Let's Encrypt's, to the server's version"
for attempt in $(seq 1 90); do
  health=$(get "$url/health" 2>/dev/null) && break
  [ "$attempt" = 90 ] && fail "no answer at $url/health in 15 minutes"
  sleep 10
done
echo "$health"
echo "$health" | grep -q "\"version\":\"$version\"" || fail "it is not $version"

step "The dashboard, and the scripts that install the command and the machine program"
get "$url/setup" | grep -q '<div id="root">' || fail "no dashboard"
get "$url/install-cli.sh" | grep -q "SERVER='$url'" || fail "install-cli.sh has another address"

step "What it keeps: a machine, made with the admin key from Parameter Store"
machine=$(get -H "authorization: Bearer $key" -H 'content-type: application/json' \
  -d "{\"name\":\"kept-$run\",\"agents\":\"*\"}" "$url/v1/machines" | field .machine.id)
echo "machine $machine"

step "A backup, in the bucket, by the instance's role"
taken=$(get -H "authorization: Bearer $key" -X POST "$url/v1/backups" | field .name)
aws s3 ls "$(out backup_url)/$taken" > /dev/null || fail "$taken is not in $(out backup_url)"
status=$(get -H "authorization: Bearer $key" "$url/v1/backups")
[ "$(echo "$status" | field .bucket.error)" = null ] || fail "the bucket is not reached: $status"
echo "$taken is in $(out backup_url)"

step "The instance made again, as for another version: what it kept is there"
old=$(out instance_id)
# shellcheck disable=SC2086
tf apply -auto-approve -input=false $vars -replace=aws_instance.server > "$work/replace.log" 2>&1 \
  || { tail -40 "$work/replace.log" >&2; fail "it was not made again"; }
[ "$(out instance_id)" != "$old" ] || fail "the instance is the same"
for attempt in $(seq 1 90); do
  get "$url/health" > /dev/null 2>&1 && break
  [ "$attempt" = 90 ] && fail "no answer at $url/health after it was made again"
  sleep 10
done
get -H "authorization: Bearer $key" "$url/v1/machines/$machine" | grep -q "\"kept-$run\"" \
  || fail "the machine is not there on the new instance"
echo "instance $(out instance_id), with machine $machine"

step "The data volume's snapshots are scheduled"
aws dlm get-lifecycle-policies --region "$region" --target-tags "acentric:snapshots=$name" \
  --query 'Policies[0].State' --output text | grep -qx ENABLED || fail "no snapshots"
echo "every day"

step "Passed"
