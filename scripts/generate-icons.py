#!/usr/bin/env python3
"""Generate Linux PNG sizes and the Windows multi-size ICO from assets/icon.png."""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "icon.png"
LINUX_DIR = ROOT / "assets" / "linux-icons"
WINDOWS_ICO = ROOT / "assets" / "icon.ico"
LINUX_SIZES = (16, 24, 32, 48, 64, 128, 256, 512, 1024)
WINDOWS_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))


def main() -> None:
    image = Image.open(SOURCE).convert("RGBA")
    LINUX_DIR.mkdir(parents=True, exist_ok=True)
    for size in LINUX_SIZES:
        resized = image.resize((size, size), Image.Resampling.LANCZOS)
        dest = LINUX_DIR / f"{size}x{size}.png"
        resized.save(dest, format="PNG", optimize=True)
        print(f"wrote {dest.relative_to(ROOT)} ({dest.stat().st_size} bytes)")
    image.save(WINDOWS_ICO, format="ICO", sizes=WINDOWS_SIZES)
    print(f"wrote {WINDOWS_ICO.relative_to(ROOT)} ({WINDOWS_ICO.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
