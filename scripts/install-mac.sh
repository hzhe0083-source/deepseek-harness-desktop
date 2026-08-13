#!/bin/zsh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SRC="$ROOT/dist/mac-arm64/Deepseek desktop.app"
DEST="$HOME/Applications/Deepseek desktop.app"

if [[ ! -d "$SRC" ]]; then
  echo "先运行: cd \"$ROOT\" && npm install && npm run dist:mac"
  exit 1
fi

mkdir -p "$HOME/Applications"
rm -rf "$DEST"
cp -R "$SRC" "$DEST"
codesign --force --deep --sign - "$DEST" || true
xattr -cr "$DEST" || true
echo "已安装到: $DEST"
echo "启动: open \"$DEST\""
