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

is_png() {
  [ -f "$1" ] && [ -s "$1" ] || return 1
  [ "$(od -An -tx1 -N8 "$1" | tr -d '[:space:]')" = "89504e470d0a1a0a" ]
}

write_desktop_entry() {
  appimage="$1"
  icon="$2"
  desktop="$3"
  [ -n "$appimage" ] && [ -n "$desktop" ] || die "write_desktop_entry requires <appimage> <icon> <desktop>"

  desktop_dir="$(dirname "$desktop")"
  mkdir -p "$desktop_dir"

  icon_key="deepseek-harness-desktop"
  if [ -n "$icon" ] && is_png "$icon"; then
    icon_key="$icon"
  fi

  exec_key="$appimage"
  case "$appimage" in
    *[!/0-9A-Za-z._-]*) exec_key="\"$appimage\"" ;;
  esac

  cat > "$desktop" <<EOF
[Desktop Entry]
Name=DeepSeek Harness Desktop
Comment=Desktop shell for the local DeepSeek Harness
Exec=$exec_key
TryExec=$appimage
Icon=$icon_key
Terminal=false
Type=Application
Categories=Development;
StartupWMClass=deepseek-harness-desktop
StartupNotify=false
Keywords=DeepSeek;DSH;Harness;
EOF
  chmod 0644 "$desktop"
}

ensure_app_icon() {
  dest="$1"
  appimage="$2"
  if is_png "$dest"; then
    return 0
  fi

  dest_dir="$(dirname "$dest")"
  mkdir -p "$dest_dir"

  if command -v 7z >/dev/null 2>&1 && [ -f "$appimage" ]; then
    extract_dir="$(mktemp -d "$dest_dir/.icon.XXXXXX")"
    for icon_path in \
      "usr/share/icons/hicolor/256x256/apps/deepseek-harness-desktop.png" \
      "usr/share/icons/hicolor/1024x1024/apps/deepseek-harness-desktop.png"
    do
      if 7z e -y -o"$extract_dir" "$appimage" "$icon_path" >/dev/null 2>&1 &&
        is_png "$extract_dir/deepseek-harness-desktop.png"; then
        mv -f "$extract_dir/deepseek-harness-desktop.png" "$dest"
        rm -rf "$extract_dir"
        return 0
      fi
    done
    rm -rf "$extract_dir"
  fi

  tmp_icon="$(mktemp "$dest_dir/.icon.XXXXXX")"
  if curl --proto '=https' --tlsv1.2 --fail --silent --show-error \
    --location --retry 3 \
    "https://raw.githubusercontent.com/$REPOSITORY/main/assets/icon.png" \
    --output "$tmp_icon" && is_png "$tmp_icon"; then
    mv -f "$tmp_icon" "$dest"
    return 0
  fi
  rm -f "$tmp_icon"
  return 1
}

install_desktop_integration() {
  exec_path="$1"
  appimage="$2"
  apps_dir="$DATA_HOME/applications"
  icon_file="$APP_DIR/deepseek-harness-desktop.png"
  desktop_file="$apps_dir/deepseek-harness-desktop.desktop"

  mkdir -p "$apps_dir" "$APP_DIR"
  if ! ensure_app_icon "$icon_file" "$appimage"; then
    printf 'warning: could not install application icon; launcher will use a generic icon.\n' >&2
    icon_file=""
  fi

  write_desktop_entry "$exec_path" "$icon_file" "$desktop_file"

  if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database "$apps_dir" >/dev/null 2>&1 || true
  fi
  if command -v xdg-desktop-menu >/dev/null 2>&1; then
    xdg-desktop-menu forceupdate >/dev/null 2>&1 || true
  fi

  printf 'Desktop:  %s\n' "$desktop_file"
}

shell_single_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

fuse2_available() {
  [ -e /lib/x86_64-linux-gnu/libfuse.so.2 ] && return 0
  [ -e /usr/lib/x86_64-linux-gnu/libfuse.so.2 ] && return 0
  [ -e /lib64/libfuse.so.2 ] && return 0
  ldconfig -p 2>/dev/null | grep -q 'libfuse\.so\.2 ' && return 0
  return 1
}

write_launcher() {
  appimage="$1"
  launcher="$2"
  log="$3"
  extracted="${4:-}"
  [ -n "$appimage" ] && [ -n "$launcher" ] && [ -n "$log" ] || die "write_launcher requires <appimage> <launcher> <log> [extracted]"

  mkdir -p "$(dirname "$launcher")" "$(dirname "$log")"
  cat > "$launcher" <<EOF
#!/bin/sh
# deepseek-harness-desktop launcher
appimage=$(shell_single_quote "$appimage")
extracted=$(shell_single_quote "$extracted")
log=$(shell_single_quote "$log")
mkdir -p "\$(dirname "\$log")"
# GNOME may pass an empty %U; this app does not open files.
set --
if [ -x "\$extracted" ]; then
  echo "\$(date -Iseconds) exec extracted \$extracted" >>"\$log"
  APPIMAGE=\${APPIMAGE:-\$appimage}
  APPDIR=\${APPDIR:-\$(dirname "\$extracted")}
  export APPIMAGE APPDIR
  exec "\$extracted" --no-sandbox >>"\$log" 2>&1
fi
if [ -z "\${APPIMAGE_EXTRACT_AND_RUN:-}" ]; then
  if [ ! -e /lib/x86_64-linux-gnu/libfuse.so.2 ] &&
     [ ! -e /usr/lib/x86_64-linux-gnu/libfuse.so.2 ] &&
     [ ! -e /lib64/libfuse.so.2 ] &&
     ! ldconfig -p 2>/dev/null | grep -q 'libfuse\\.so\\.2 '; then
    APPIMAGE_EXTRACT_AND_RUN=1
    export APPIMAGE_EXTRACT_AND_RUN
  fi
fi
echo "\$(date -Iseconds) exec appimage \$appimage" >>"\$log"
exec "\$appimage" >>"\$log" 2>&1
EOF
  chmod 0755 "$launcher"
}

is_our_launcher() {
  [ -L "$1" ] && return 0
  [ -f "$1" ] || return 1
  grep -q '^# deepseek-harness-desktop launcher$' "$1" && return 0
  head -n 1 "$1" | grep -q '^#!' && grep -q 'deepseek-harness-desktop' "$1"
}

extract_appimage_if_needed() {
  appimage="$1"
  dest="$2"
  if fuse2_available; then
    return 0
  fi
  if [ -x "$dest/AppRun" ]; then
    return 0
  fi
  [ -f "$appimage" ] || return 1

  tmp="$(mktemp -d "$(dirname "$dest")/.extract.XXXXXX")"
  if (
    cd "$tmp" &&
      APPIMAGE_EXTRACT_AND_RUN=1 "$appimage" --appimage-extract >/dev/null
  ) && [ -x "$tmp/squashfs-root/AppRun" ]; then
    rm -rf "$dest"
    mv "$tmp/squashfs-root" "$dest"
    rm -rf "$tmp"
    return 0
  fi
  rm -rf "$tmp"
  return 1
}

if [ "${1:-}" = "--write-desktop-entry" ]; then
  write_desktop_entry "${2:-}" "${3:-}" "${4:-}"
  exit 0
fi

if [ "${1:-}" = "--write-launcher" ]; then
  write_launcher "${2:-}" "${3:-}" "${4:-}" "${5:-}"
  exit 0
fi

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

EXTRACTED_APP=""
EXTRACT_DIR="$APP_DIR/squashfs-root"
if extract_appimage_if_needed "$TARGET" "$EXTRACT_DIR"; then
  # Prefer the Electron binary. AppRun uses an EXIT trap that GNOME
  # startup-notification can interrupt before the window appears.
  if [ -x "$EXTRACT_DIR/deepseek-harness-desktop" ]; then
    EXTRACTED_APP="$EXTRACT_DIR/deepseek-harness-desktop"
    printf 'Extracted AppImage for systems without libfuse2.\n'
  elif [ -x "$EXTRACT_DIR/AppRun" ]; then
    EXTRACTED_APP="$EXTRACT_DIR/AppRun"
    printf 'Extracted AppImage for systems without libfuse2.\n'
  fi
fi

if [ -e "$LAUNCHER" ] && ! is_our_launcher "$LAUNCHER"; then
  printf 'warning: launcher already exists and was not replaced: %s\n' "$LAUNCHER" >&2
else
  write_launcher "$TARGET" "$LAUNCHER" "$LAUNCH_LOG" "$EXTRACTED_APP"
fi

printf 'AppImage: %s\n' "$TARGET"
printf 'Command:  %s\n' "$LAUNCHER"
install_desktop_integration "$LAUNCHER" "$TARGET"

case ":${PATH:-}:" in
  *":$BIN_HOME:"*) ;;
  *) printf 'note: add %s to PATH to use the command by name.\n' "$BIN_HOME" ;;
esac

if [ "${DSH_DESKTOP_NO_LAUNCH:-0}" = "1" ]; then
  exit 0
fi

nohup "$LAUNCHER" </dev/null >/dev/null 2>&1 &
printf 'Started DeepSeek Harness Desktop (log: %s).\n' "$LAUNCH_LOG"
