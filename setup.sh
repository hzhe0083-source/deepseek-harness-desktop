#!/bin/sh
# DeepSeek Harness Desktop bootstrap (macOS / Linux).
# Checks for Node.js 18+. If it is missing or too old, downloads an official
# LTS build into the user cache and then runs: npx deepseek-harness-desktop
#
# Does not replace a system Node install and does not need sudo.

set -eu

MIN_MAJOR=18
FALLBACK_NODE_VERSION="v22.18.0"
NODE_MIRROR="${DSH_NODE_MIRROR:-https://nodejs.org/dist}"
REPO="hzhe0083-source/deepseek-harness-desktop"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1 (need curl and tar)"
}

node_major() {
  node -p "process.versions.node.split('.')[0]" 2>/dev/null || printf '0'
}

system_node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  command -v npx >/dev/null 2>&1 || return 1
  major="$(node_major)"
  case "$major" in
    ''|*[!0-9]*) return 1 ;;
  esac
  [ "$major" -ge "$MIN_MAJOR" ]
}

detect_target() {
  sys="$(uname -s)"
  mach="$(uname -m)"
  case "$sys:$mach" in
    Linux:x86_64|Linux:amd64) printf 'linux-x64' ;;
    Linux:aarch64|Linux:arm64) printf 'linux-arm64' ;;
    Darwin:arm64) printf 'darwin-arm64' ;;
    Darwin:x86_64) printf 'darwin-x64' ;;
    *) die "unsupported platform: $sys $mach" ;;
  esac
}

data_home() {
  if [ -n "${XDG_DATA_HOME:-}" ]; then
    printf '%s' "$XDG_DATA_HOME"
  else
    printf '%s' "${HOME:?HOME is not set}/.local/share"
  fi
}

latest_lts_version() {
  if command -v python3 >/dev/null 2>&1; then
    curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
      --location --retry 3 "$NODE_MIRROR/index.json" |
      python3 -c '
import json, sys
releases = json.load(sys.stdin)
for release in releases:
    if release.get("lts"):
        print(release["version"])
        break
'
    return 0
  fi
  printf '%s' "$FALLBACK_NODE_VERSION"
}

ensure_local_node() {
  target="$(detect_target)"
  version="$(latest_lts_version)"
  case "$version" in
    v[0-9]*) ;;
    *) version="$FALLBACK_NODE_VERSION" ;;
  esac

  prefix="$(data_home)/deepseek-harness-desktop/runtime-node/$version-$target"
  bin="$prefix/bin/node"
  if [ -x "$bin" ]; then
    printf 'Using cached Node.js %s (%s).\n' "$version" "$prefix" >&2
    printf '%s' "$prefix/bin"
    return 0
  fi

  require_command curl
  require_command tar

  archive="node-${version}-${target}.tar.gz"
  url="$NODE_MIRROR/$version/$archive"
  mkdir -p "$(data_home)/deepseek-harness-desktop"
  staging="$(mktemp -d "$(data_home)/deepseek-harness-desktop/.node.XXXXXX")"

  printf 'Node.js 18+ not found. Downloading official %s for %s…\n' "$version" "$target" >&2
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 "$url" --output "$staging/$archive"

  sums="$staging/SHASUMS256.txt"
  if curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 "$NODE_MIRROR/$version/SHASUMS256.txt" --output "$sums"; then
    expected="$(awk -v name="$archive" '$2 == name { print $1; exit }' "$sums")"
    if [ -n "$expected" ]; then
      if command -v sha256sum >/dev/null 2>&1; then
        actual="$(sha256sum "$staging/$archive" | awk '{ print $1 }')"
      else
        actual="$(shasum -a 256 "$staging/$archive" | awk '{ print $1 }')"
      fi
      [ "$actual" = "$expected" ] || die "Node.js checksum mismatch for $archive"
    fi
  fi

  tar -xzf "$staging/$archive" -C "$staging"
  extracted="$staging/node-${version}-${target}"
  [ -x "$extracted/bin/node" ] || die "downloaded Node.js archive is missing bin/node"

  rm -rf "$prefix"
  mkdir -p "$(dirname "$prefix")"
  mv "$extracted" "$prefix"
  rm -rf "$staging"

  printf 'Installed local Node.js %s (does not replace system Node).\n' "$("$prefix/bin/node" -v)" >&2
  printf '%s' "$prefix/bin"
}

print_check() {
  if system_node_ok; then
    printf 'Node.js %s at %s — OK (>= %s)\n' "$(node -v 2>/dev/null)" "$(command -v node)" "$MIN_MAJOR"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    printf 'Node.js %s is too old. Need %s+.\n' "$(node -v 2>/dev/null || printf unknown)" "$MIN_MAJOR"
  else
    printf 'Node.js is not installed. Need %s+.\n' "$MIN_MAJOR"
  fi
  return 2
}

if [ "${1:-}" = "--check" ]; then
  print_check
  exit $?
fi

[ -n "${HOME:-}" ] || die "HOME is not set"

if system_node_ok; then
  printf 'Using Node.js %s.\n' "$(node -v)"
else
  node_bin_dir="$(ensure_local_node)"
  PATH="$node_bin_dir:$PATH"
  export PATH
  system_node_ok || die "downloaded Node.js still does not satisfy $MIN_MAJOR+"
fi

exec npx --yes deepseek-harness-desktop "$@"
