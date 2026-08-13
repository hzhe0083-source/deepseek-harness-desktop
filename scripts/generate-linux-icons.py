#!/usr/bin/env python3
"""Resize assets/icon.png into the Linux hicolor sizes electron-builder expects."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "icon.png"
DEST_DIR = ROOT / "assets" / "linux-icons"
SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    DEST_DIR.mkdir(parents=True, exist_ok=True)
    for size in SIZES:
        resized = image.resize((size, size), Image.Resampling.LANCZOS)
        dest = DEST_DIR / f"{size}x{size}.png"
        resized.save(dest, format="PNG", optimize=True)
        print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
