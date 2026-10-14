"""Bundles the extension's .glsl shaders into shaders.gen.js so the parity
pages can load them from file:// without fetch (blocked for file URLs).

Usage: python tools/parity/gen_shaders.py
"""
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SHADER_DIR = HERE.parent.parent / "extension" / "shaders"


def main() -> None:
    sources = {p.name: p.read_text(encoding="utf-8") for p in sorted(SHADER_DIR.glob("*.glsl"))}
    (HERE / "shaders.gen.js").write_text("window.SHADERS = " + json.dumps(sources) + ";\n", encoding="utf-8")


if __name__ == "__main__":
    main()
