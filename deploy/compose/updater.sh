#!/bin/sh
# The updater beside the Acentric server: it takes a newer version when asked to from the
# dashboard. The server writes what it is asked into the folder they share (/updates/request),
# and this reads it every few seconds, and writes what it is doing (/updates/status).
#
# It is what may restart the server, with Docker's socket, so what the server writes is checked
# again here: a plain version, newer than the recipe's, of this image alone. Its image is
# downloaded and its signature checked against the release workflow of acentricai/acentric
# before anything is changed. Taking it is the recipe's own way: ACENTRIC_VERSION in .env, and
# `docker compose up` of the server. When the new version does not become healthy, the one
# before is put back. Its backups before the database is changed are the server's, as ever.

set -u

dir=/updates
recipe=/recipe
image=ghcr.io/acentricai/acentric-server
cosign=ghcr.io/sigstore/cosign/cosign:v3.0.5
poll=${ACENTRIC_UPDATER_POLL:-5}
# How long the new version is waited for: its backup before it changes the database, of a large
# one, is most of it.
wait=${ACENTRIC_UPDATER_WAIT:-1800}

# The server writes its request here, as its own user (node, 1000).
mkdir -p "$dir"
chown 1000:1000 "$dir"
chmod 755 "$dir"

# Compose is run on the recipe where this machine has it, so that the paths it gives Docker,
# such as the secrets' files, are this machine's: the recipe's folder is seen at its own path.
self=$(hostname)
project=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project"}}' "$self")
there=$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/recipe"}}{{.Source}}{{end}}{{end}}' "$self")
if [ -z "$project" ] || [ -z "$there" ]; then
  echo "updater: not started by the recipe's compose.yaml: its project and folder are not known" >&2
  exit 1
fi
if [ "$there" != "$recipe" ] && [ ! -e "$there" ]; then
  mkdir -p "$(dirname "$there")"
  ln -s "$recipe" "$there"
fi
compose() { docker compose --project-name "$project" --project-directory "$there" "$@"; }

# What was asked last, and what was done with it.
id=''
version=''
handled=''
checked=''
waiting=''

# Writes what it is doing: state, version, when it takes it (seconds), what went wrong.
say() {
  error=$(printf '%s' "$4" | tr '\n\r' '  ' | cut -c 1-500)
  printf 'id=%s\nstate=%s\nversion=%s\nat=%s\nerror=%s\nchanged=%s\n' \
    "$id" "$1" "$2" "$3" "$error" "$(date +%s)" > "$dir/.status"
  chmod 644 "$dir/.status"
  mv "$dir/.status" "$dir/status"
  echo "updater: $1 $2${error:+: $error}"
}

# A value of the request, as it is written: name=value.
asked() { sed -n "s/^$1=//p" "$dir/request" 2>/dev/null | head -n 1; }

# Whether what is asked is still what was read, after a download: it may have been taken back,
# or asked in place of, meanwhile.
still() { [ -f "$dir/request" ] && [ "$(asked id)" = "$id" ]; }

# The version the recipe runs, from its .env.
current() { sed -n 's/^ACENTRIC_VERSION=//p' "$recipe/.env" | tail -n 1 | tr -d ' "'; }

# Whether $1 is a plain version, such as 0.16.1.
plain() { printf '%s' "$1" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$'; }

# Whether version $1 is newer than $2.
newer() {
  a1=${1%%.*}; rest=${1#*.}; a2=${rest%%.*}; a3=${rest#*.}
  b1=${2%%.*}; rest=${2#*.}; b2=${rest%%.*}; b3=${rest#*.}
  [ "$a1" -gt "$b1" ] && return 0; [ "$a1" -lt "$b1" ] && return 1
  [ "$a2" -gt "$b2" ] && return 0; [ "$a2" -lt "$b2" ] && return 1
  [ "$a3" -gt "$b3" ]
}

# Sets ACENTRIC_VERSION in .env to $1.
pin() {
  if grep -q '^ACENTRIC_VERSION=' "$recipe/.env"; then
    sed -i "s/^ACENTRIC_VERSION=.*/ACENTRIC_VERSION=$1/" "$recipe/.env"
  else
    printf 'ACENTRIC_VERSION=%s\n' "$1" >> "$recipe/.env"
  fi
}

# Downloads the image of version $1 and checks its signature, once a version.
fetch() {
  [ "$checked" = "$1" ] && return 0
  say downloading "$1" 0 ''
  if ! out=$(docker pull "$image:$1" 2>&1); then
    say failed "$1" 0 "the image did not download: $(printf '%s' "$out" | tail -n 1)"
    return 1
  fi
  if ! out=$(docker run --rm "$cosign" verify "$image:$1" \
    --certificate-identity "https://github.com/acentricai/acentric/.github/workflows/release.yml@refs/tags/v$1" \
    --certificate-oidc-issuer https://token.actions.githubusercontent.com 2>&1); then
    say failed "$1" 0 "the image's signature is not the release workflow's: $(printf '%s' "$out" | tail -n 1)"
    return 1
  fi
  checked=$1
}

# Takes version $1: the recipe's server on it, and healthy, or the one before back.
take() {
  from=$(current)
  say updating "$1" 0 ''
  pin "$1"
  if out=$(compose up --detach --wait --wait-timeout "$wait" server 2>&1) &&
    wget -qO- http://server:4000/health 2>/dev/null | grep -q "\"version\":\"$1\""; then
    say done "$1" 0 ''
    return 0
  fi
  why=$(compose logs --tail 3 server 2>/dev/null | tail -n 1)
  pin "$from"
  compose up --detach --wait --wait-timeout "$wait" server >/dev/null 2>&1
  say failed "$1" 0 "it did not become healthy, and $from is back: ${why:-$(printf '%s' "$out" | tail -n 1)}"
}

echo "updater: watching $dir for project $project, at $there"
# That it is there, every few seconds, while it downloads and takes a version too: the server
# offers to take one only while it is.
(
  while :; do
    date +%s > "$dir/.alive" && chmod 644 "$dir/.alive" && mv "$dir/.alive" "$dir/alive"
    sleep "$poll"
  done
) &
while :; do
  if [ ! -f "$dir/request" ]; then
    # Taken back before it was done.
    if [ -n "$id" ] && [ "$handled" != "$id" ]; then
      say cancelled "$version" 0 ''
      handled=$id
    fi
    sleep "$poll"
    continue
  fi
  id=$(asked id)
  if [ "$handled" = "$id" ]; then
    still && rm -f "$dir/request"
    sleep "$poll"
    continue
  fi
  action=$(asked action)
  version=$(asked version)
  at=$(asked at)
  now=$(current)
  if ! plain "$version" || ! plain "$now"; then
    say failed "$version" 0 "not a plain version: $version, from $now"
    handled=$id
  elif ! newer "$version" "$now"; then
    say failed "$version" 0 "not newer than $now, which the recipe runs"
    handled=$id
  elif [ "$action" != download ] && [ "$action" != install ]; then
    say failed "$version" 0 "not something it does: $action"
    handled=$id
  elif ! fetch "$version"; then
    handled=$id
  elif ! still; then
    # Taken back, or asked in place of, while it downloaded: what is asked now is read next.
    [ -f "$dir/request" ] || { say cancelled "$version" 0 ''; handled=$id; }
  elif [ "$action" = download ]; then
    say downloaded "$version" 0 ''
    handled=$id
  elif printf '%s' "$at" | grep -Eq '^[0-9]+$' && [ "$at" -gt "$(date +%s)" ]; then
    # Set for later: waited for, a few seconds at a time, so it can be taken back.
    if [ "$waiting" != "$id" ]; then
      say waiting "$version" "$at" ''
      waiting=$id
    fi
  else
    take "$version"
    handled=$id
  fi
  # Done with, it is not done again: not when the updater starts again either. One asked in
  # its place meanwhile is kept.
  if [ "$handled" = "$id" ] && still; then
    rm -f "$dir/request"
  fi
  sleep "$poll"
done
