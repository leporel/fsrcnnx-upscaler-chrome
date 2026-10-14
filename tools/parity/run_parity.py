"""Renders the parity pages in headless Chrome and compares WebGPU to WebGL2.

Each page is served over http from the repo root and POSTs {log, images} back
(headless --virtual-time-budget stalls navigator.gpu.requestAdapter, so
--dump-dom cannot be used for WebGPU). PNGs land in <out_dir>/<page>-<case>.png.

Usage:
  python tools/parity/run_parity.py [out_dir] [--gpu] [--chrome PATH] [--page NAME]

  --gpu     use the real GPU instead of SwiftShader (needs a GPU visible to
            headless Chrome); SwiftShader has no shader-f16 / is slow but
            deterministic
  --page    render only tools/parity/NAME.html (no comparison), e.g. framegen
            or "framegen?scale=4&shift=8" (query passed to the page)
Manual alternative: `python -m http.server` in the repo root and open
http://127.0.0.1:8000/tools/parity/webgpu.html in normal Chrome.
"""
import argparse
import base64
import http.server
import json
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent.parent
DEFAULT_CHROME = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
PAGES = ["webgl-baseline", "webgpu"]
PAGE_TIMEOUT_S = 900

sys.path.insert(0, str(HERE))
import compare  # noqa: E402
import gen_shaders  # noqa: E402


class ResultServer:
    """Serves ROOT and keeps the first POSTed body."""

    def __init__(self) -> None:
        self.body = b""
        self.done = threading.Event()
        owner = self

        class Handler(http.server.SimpleHTTPRequestHandler):
            def __init__(self, *args, **kwargs):
                super().__init__(*args, directory=str(ROOT), **kwargs)

            def do_POST(self):
                owner.body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                self.send_response(200)
                self.end_headers()
                owner.done.set()

            def log_message(self, format, *args):  # noqa: A002 - base class signature
                del format, args  # request logging would drown the test output

        self.httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    @property
    def port(self) -> int:
        return self.httpd.server_address[1]

    def close(self) -> None:
        self.httpd.shutdown()


def chrome_flags(page: str, use_gpu: bool) -> list[str]:
    if page != "webgl-baseline":
        return ["--enable-unsafe-webgpu"] + ([] if use_gpu else ["--use-webgpu-adapter=swiftshader"])
    return [] if use_gpu else ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"]


def render_page(chrome: str, page: str, use_gpu: bool, out_dir: Path) -> bool:
    server = ResultServer()
    with tempfile.TemporaryDirectory() as profile:
        name, _, query = page.partition("?")
        url = f"http://127.0.0.1:{server.port}/tools/parity/{name}.html" + (f"?{query}" if query else "")
        cmd = [chrome, "--headless=new", f"--user-data-dir={profile}", *chrome_flags(name, use_gpu), url]
        proc = subprocess.Popen(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        try:
            finished = server.done.wait(PAGE_TIMEOUT_S)
        finally:
            proc.kill()
            proc.wait()
            server.close()
    if not finished:
        print(f"[{page}] timed out")
        return False
    result = json.loads(server.body)
    print(f"[{page}]\n{result['log']}")
    out_dir.mkdir(parents=True, exist_ok=True)
    for label, url in result["images"].items():
        (out_dir / f"{page.partition('?')[0]}-{label}.png").write_bytes(base64.b64decode(url.split(",", 1)[1]))
    return "DONE" in result["log"]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("out_dir", nargs="?", default=str(HERE / "out"))
    parser.add_argument("--gpu", action="store_true")
    parser.add_argument("--chrome", default=DEFAULT_CHROME)
    parser.add_argument("--page")
    args = parser.parse_args()
    out_dir = Path(args.out_dir)

    gen_shaders.main()
    if args.page:
        sys.exit(0 if render_page(args.chrome, args.page, args.gpu, out_dir) else 1)
    ok = all([render_page(args.chrome, page, args.gpu, out_dir) for page in PAGES])
    ok = compare.compare_dirs(out_dir, PAGES[0], PAGES[1]) and ok
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
