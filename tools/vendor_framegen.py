"""Downloads the pinned Framegen runtime + weights into extension/vendor/framegen
and verifies every file against the SHA-256 recorded in VERSION.

Usage: python tools/vendor_framegen.py
"""
import hashlib
import sys
import urllib.request
from pathlib import Path

COMMIT = "4cc26b80ea096be0ab3efd940ae91243068d60ed"  # tag v1.5.3
BASE = f"https://raw.githubusercontent.com/MONZikWasTaken/Framegen/{COMMIT}"
DEST = Path(__file__).resolve().parent.parent / "extension" / "vendor" / "framegen"
FILES = {
    "rt.js": ("web/rt/rt.js", "3e70f2ebc2fb0378bc2d014737614d842dc6abdd368cd7ffbc620216aea8ebb6"),
    "weights/rt_v7s.bin": ("extension/assets/rt_v7s.bin", "76428e1769f742a2aaad79996f2eb57cc29388a6dc21c242386ca9110c0bb397"),
    "weights/rt_v7s.json": ("extension/assets/rt_v7s.json", "6fa80133638949109d11fec3efb0421fbbc556f9bcff2fe2239b410154d8e7e3"),
    "LICENSE": ("LICENSE", "b40a2868b660d4e5f827d0d4255ad9093bd57b446dc3d03911d95866a404f415"),
    "WEIGHTS_LICENSE.md": ("WEIGHTS_LICENSE.md", "8a639ace26979f31cccc684ae2d1db9efd99bf2e72361e7f933f19de34a4d7bd"),
}


def main() -> None:
    for local, (remote, expected) in FILES.items():
        with urllib.request.urlopen(f"{BASE}/{remote}", timeout=60) as response:
            data = response.read()
        actual = hashlib.sha256(data).hexdigest()
        if actual != expected:
            sys.exit(f"hash mismatch for {remote}: {actual} (expected {expected})")
        target = DEST / local
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        print(f"ok {local} ({len(data)} bytes)")


if __name__ == "__main__":
    main()
