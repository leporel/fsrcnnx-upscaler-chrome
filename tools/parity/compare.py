"""Diffs two PNG sets rendered by the parity pages.

Pass criterion per image and channel: max abs diff <= 2/255 and mean <= 0.3/255.

Usage: python tools/parity/compare.py <dir> [prefix_a] [prefix_b]
"""
import sys
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

MAX_ABS = 2
MAX_MEAN = 0.3


def compare_pair(path_a: Path, path_b: Path) -> tuple[bool, str]:
    a = Image.open(path_a).convert("RGB")
    b = Image.open(path_b).convert("RGB")
    if a.size != b.size:
        return False, f"size {a.size} vs {b.size}"
    diff = ImageChops.difference(a, b)
    maxima = [hi for _, hi in diff.getextrema()]
    means = ImageStat.Stat(diff).mean
    ok = max(maxima) <= MAX_ABS and max(means) <= MAX_MEAN
    stats = " ".join(f"{c}:max={m} mean={u:.3f}" for c, m, u in zip("RGB", maxima, means))
    return ok, stats


def compare_dirs(directory: Path, prefix_a: str, prefix_b: str) -> bool:
    files_a = sorted(directory.glob(f"{prefix_a}-*.png"))
    if not files_a:
        print(f"no {prefix_a}-*.png images in {directory}")
        return False
    all_ok = True
    for path_a in files_a:
        label = path_a.name[len(prefix_a) + 1:]
        path_b = directory / f"{prefix_b}-{label}"
        if not path_b.exists():
            print(f"FAIL {label}: missing {path_b.name}")
            all_ok = False
            continue
        ok, stats = compare_pair(path_a, path_b)
        all_ok &= ok
        print(f"{'PASS' if ok else 'FAIL'} {label}: {stats}")
    print("parity", "PASSED" if all_ok else "FAILED")
    return all_ok


def main() -> None:
    directory = Path(sys.argv[1])
    prefix_a = sys.argv[2] if len(sys.argv) > 2 else "webgl-baseline"
    prefix_b = sys.argv[3] if len(sys.argv) > 3 else "webgpu"
    sys.exit(0 if compare_dirs(directory, prefix_a, prefix_b) else 1)


if __name__ == "__main__":
    main()
