#!/bin/sh

set -eu

REPOSITORY="hzhe0083-source/deepseek-harness-desktop"

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "required command not found: $1"
}

sha512_hex() {
  sha512sum "$1" | awk '{ print $1 }'
}

[ -n "${HOME:-}" ] || die "HOME is not set"

case "$(uname -s):$(uname -m)" in
  Linux:x86_64|Linux:amd64) ;;
  Darwin:arm64)
    die "macOS arm64 installation is not available yet"
    ;;
  *)
    die "unsupported platform: $(uname -s) $(uname -m)"
    ;;
esac

for command_name in curl awk base64 od tr sha512sum mktemp; do
  require_command "$command_name"
done

VERSION="${DSH_DESKTOP_VERSION:-latest}"
REQUESTED_VERSION=""

case "$VERSION" in
  latest)
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/latest/download"
    ;;
  *)
    REQUESTED_VERSION="${VERSION#v}"
    case "$REQUESTED_VERSION" in
      [0-9]*) ;;
      *) die "invalid version: $VERSION" ;;
    esac
    case "$REQUESTED_VERSION" in
      *[!A-Za-z0-9._-]*) die "invalid version: $VERSION" ;;
    esac
    RELEASE_BASE="https://github.com/$REPOSITORY/releases/download/v$REQUESTED_VERSION"
    ;;
esac

if ! MANIFEST="$(
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 "$RELEASE_BASE/latest-linux.yml"
)"; then
  die "failed to download the release manifest"
fi

ASSET="$(printf '%s\n' "$MANIFEST" | awk -F ': ' '
  /^path: / { sub(/\r$/, "", $2); print $2; exit }
')"
EXPECTED_B64="$(printf '%s\n' "$MANIFEST" | awk -F ': ' '
  /^sha512: / { sub(/\r$/, "", $2); print $2; exit }
')"
MANIFEST_VERSION="$(printf '%s\n' "$MANIFEST" | awk -F ': ' '
  /^version: / { sub(/\r$/, "", $2); print $2; exit }
')"

case "$ASSET" in
  *.AppImage) ;;
  *) die "release manifest does not select an AppImage" ;;
esac
case "$ASSET" in
  *[!A-Za-z0-9._-]*) die "unsafe asset name in release manifest: $ASSET" ;;
esac
[ -n "$EXPECTED_B64" ] || die "release manifest has no SHA-512 checksum"
[ -n "$MANIFEST_VERSION" ] || die "release manifest has no version"

if [ -n "$REQUESTED_VERSION" ] && [ "$MANIFEST_VERSION" != "$REQUESTED_VERSION" ]; then
  die "release manifest version mismatch: expected $REQUESTED_VERSION, got $MANIFEST_VERSION"
fi

EXPECTED_HEX="$(
  printf '%s' "$EXPECTED_B64" |
    base64 -d 2>/dev/null |
    od -An -tx1 |
    tr -d '[:space:]'
)"
[ "${#EXPECTED_HEX}" -eq 128 ] || die "invalid SHA-512 checksum in release manifest"

DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
BIN_HOME="${XDG_BIN_HOME:-$HOME/.local/bin}"
case "$DATA_HOME" in
  /*) ;;
  *) die "XDG_DATA_HOME must be an absolute path" ;;
esac
case "$BIN_HOME" in
  /*) ;;
  *) die "XDG_BIN_HOME must be an absolute path" ;;
esac
APP_DIR="$DATA_HOME/deepseek-harness-desktop"
TARGET="$APP_DIR/DeepSeek-Harness-Desktop.AppImage"
LAUNCHER="$BIN_HOME/deepseek-harness-desktop"
LAUNCH_LOG="$APP_DIR/launch.log"

mkdir -p "$APP_DIR" "$BIN_HOME"

CURRENT_HEX=""
if [ -f "$TARGET" ]; then
  CURRENT_HEX="$(sha512_hex "$TARGET" 2>/dev/null || true)"
fi

TEMP=""
cleanup() {
  if [ -n "$TEMP" ]; then
    rm -f "$TEMP"
  fi
}
trap cleanup 0
trap 'exit 1' HUP INT TERM

if [ "$CURRENT_HEX" = "$EXPECTED_HEX" ]; then
  printf 'DeepSeek Harness Desktop %s is already installed.\n' "$MANIFEST_VERSION"
else
  TEMP="$(mktemp "$APP_DIR/.install.XXXXXX")"
  curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 "$RELEASE_BASE/$ASSET" --output "$TEMP"

  ACTUAL_HEX="$(sha512_hex "$TEMP")"
  if [ "$ACTUAL_HEX" != "$EXPECTED_HEX" ]; then
    die "download checksum mismatch"
  fi

  chmod 0755 "$TEMP"
  mv -f "$TEMP" "$TARGET"
  TEMP=""
  printf 'Installed DeepSeek Harness Desktop %s.\n' "$MANIFEST_VERSION"
fi

chmod 0755 "$TARGET"

if [ -L "$LAUNCHER" ]; then
  rm -f "$LAUNCHER"
elif [ -e "$LAUNCHER" ]; then
  printf 'warning: launcher already exists and was not replaced: %s\n' "$LAUNCHER" >&2
fi

if [ ! -e "$LAUNCHER" ]; then
  ln -s "$TARGET" "$LAUNCHER"
fi

printf 'AppImage: %s\n' "$TARGET"
printf 'Command:  %s\n' "$LAUNCHER"

case ":${PATH:-}:" in
  *":$BIN_HOME:"*) ;;
  *) printf 'note: add %s to PATH to use the command by name.\n' "$BIN_HOME" ;;
esac

if [ "${DSH_DESKTOP_NO_LAUNCH:-0}" = "1" ]; then
  exit 0
fi

nohup "$TARGET" </dev/null >"$LAUNCH_LOG" 2>&1 &
printf 'Started DeepSeek Harness Desktop (log: %s).\n' "$LAUNCH_LOG"
