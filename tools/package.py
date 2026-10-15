"""Builds the Chrome Web Store upload: dist/fsrcnnx-upscaler-chrome-<version>.zip.

Checks the manifest limits the store enforces on upload, so a rejected
package shows up here instead of after the upload.

Usage: python tools/package.py
"""
import json
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTENSION_DIR = ROOT / "extension"
DIST_DIR = ROOT / "dist"
PACKAGE_NAME = "fsrcnnx-upscaler-chrome"
# The extension's own license lives in the repo root; ship it with the code.
EXTRA_FILES = (ROOT / "LICENSE",)
# Chrome Web Store limits for manifest fields, in characters.
FIELD_LIMITS = {"name": 75, "short_name": 12, "description": 132}


def check_manifest(manifest: dict) -> list[str]:
    problems = []
    for field, limit in FIELD_LIMITS.items():
        value = manifest.get(field)
        if value is not None and len(value) > limit:
            problems.append(f"{field}: {len(value)} characters, limit {limit}")
    return problems


def build_zip(version: str) -> Path:
    DIST_DIR.mkdir(exist_ok=True)
    target = DIST_DIR / f"{PACKAGE_NAME}-{version}.zip"
    with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in sorted(EXTENSION_DIR.rglob("*")):
            if path.is_file():
                archive.write(path, path.relative_to(EXTENSION_DIR).as_posix())
        for path in EXTRA_FILES:
            archive.write(path, path.name)
    return target


def main() -> int:
    manifest = json.loads((EXTENSION_DIR / "manifest.json").read_text(encoding="utf-8"))
    problems = check_manifest(manifest)
    if problems:
        print("manifest.json exceeds Chrome Web Store limits:", *problems, sep="\n  ")
        return 1
    target = build_zip(manifest["version"])
    print(f"{target.relative_to(ROOT)} ({target.stat().st_size / 1024:.0f} KiB)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
