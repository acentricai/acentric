#!/bin/sh
# Installs the acentric command from the engine that serves this script. The engine puts its own
# address in SERVER, below, when it serves it, and the command remembers it, so that
# `acentric login` needs no address:
#
#   curl -fsSL https://<engine>/install-cli.sh | sh
#
# Run again, it updates the command to the engine's. `--uninstall` removes it.
#
# It needs curl, and Node 24 or later: without it, Node is fetched from nodejs.org into
# ~/.acentric (ACENTRIC_DIR), for the command alone. Nothing needs root.

set -eu

SERVER='__SERVER__'
DIR="${ACENTRIC_DIR:-$HOME/.acentric}"
BIN="$DIR/bin"

uninstall=0
while [ $# -gt 0 ]; do
  case "$1" in
    --uninstall) uninstall=1; shift ;;
    *) echo "install-cli.sh: unknown option $1" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
fail() { printf 'install-cli.sh: %s\n' "$*" >&2; exit 1; }

if [ "$uninstall" = 1 ]; then
  rm -f "$BIN/acentric" "$BIN/acentric.mjs"
  for folder in "$HOME/.local/bin" "$HOME/bin"; do
    [ -L "$folder/acentric" ] && rm -f "$folder/acentric"
  done
  say "Removed the acentric command. Its sign-in, if any, is kept in ~/.config/acentric."
  exit 0
fi

os=$(uname -s)
case "$os" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) fail "this machine runs $os: only macOS and Linux are supported" ;;
esac
command -v curl >/dev/null 2>&1 || fail "it needs curl"
mkdir -p "$BIN"

# Node: the one on the PATH when it is new enough, else one of its own.
node=''
if command -v node >/dev/null 2>&1; then
  version=$(node -p 'process.versions.node' 2>/dev/null || echo 0)
  major=${version%%.*}
  if [ "$major" -ge 24 ]; then node=$(command -v node); fi
fi
if [ -z "$node" ] && [ -x "$DIR/node/bin/node" ]; then node="$DIR/node/bin/node"; fi
if [ -z "$node" ]; then
  case $(uname -m) in
    x86_64|amd64) arch=x64 ;;
    arm64|aarch64) arch=arm64 ;;
    *) fail "this machine's processor, $(uname -m), has no Node to fetch" ;;
  esac
  base='https://nodejs.org/dist/latest-v24.x'
  say "Fetching Node 24 from nodejs.org…"
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(printf '%s\n' "$sums" | awk '{print $2}' | grep "^node-v.*-$os-$arch\.tar\.gz$" | head -n 1)
  [ -n "$file" ] || fail "nodejs.org has no Node 24 for $os-$arch"
  work=$(mktemp -d)
  curl -fsSL "$base/$file" -o "$work/$file"
  want=$(printf '%s\n' "$sums" | awk -v f="$file" '$2 == f {print $1}')
  if command -v sha256sum >/dev/null 2>&1; then got=$(sha256sum "$work/$file" | awk '{print $1}')
  else got=$(shasum -a 256 "$work/$file" | awk '{print $1}'); fi
  [ "$want" = "$got" ] || { rm -rf "$work"; fail "the Node download does not match its checksum"; }
  rm -rf "$DIR/node" && mkdir -p "$DIR/node"
  tar -xzf "$work/$file" -C "$DIR/node" --strip-components=1
  rm -rf "$work"
  node="$DIR/node/bin/node"
fi

curl -fsSL "$SERVER/acentric.mjs" -o "$BIN/acentric.mjs.new"
mv "$BIN/acentric.mjs.new" "$BIN/acentric.mjs"
cat > "$BIN/acentric" <<EOF
#!/bin/sh
ACENTRIC_ENGINE="\${ACENTRIC_ENGINE:-$SERVER}" exec "$node" "$BIN/acentric.mjs" "\$@"
EOF
chmod +x "$BIN/acentric"
linked=''
for folder in "$HOME/.local/bin" "$HOME/bin"; do
  if [ -d "$folder" ]; then ln -sf "$BIN/acentric" "$folder/acentric"; linked="$folder"; break; fi
done
say "Installed acentric, with Node $("$node" --version), from $SERVER."
if [ -z "$linked" ]; then say "Add $BIN to your PATH, or run $BIN/acentric."; fi
say "Next: acentric login"
