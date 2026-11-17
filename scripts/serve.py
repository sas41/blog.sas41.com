#!/usr/bin/env python3
"""Local-only preview server. Rebuild on source changes; retain the last good build."""

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import os
from pathlib import Path
import shutil
import tempfile
import threading

from build import BuildError, build, git


def fingerprint(root: Path) -> tuple:
    files = [root / "hugo.toml"]
    for name in ("content", "layouts", "assets", "static"):
        files.extend(path for path in (root / name).rglob("*") if path.is_file())
    # Git queries also support worktrees where .git is a file, not a directory.
    try:
        head = git(root, "rev-parse", "HEAD").strip()
    except BuildError:
        head = ""
    stamps = []
    for path in sorted(files):
        try:
            stat = path.stat()
        except FileNotFoundError:
            # Editors may atomically replace or delete a file while we scan.
            continue
        stamps.append((str(path.relative_to(root)), stat.st_mtime_ns, stat.st_size))
    return head, tuple(stamps)


def rebuild(root: Path, output: Path) -> bool:
    candidate = Path(tempfile.mkdtemp(prefix="build-", dir=output.parent))
    try:
        build(root, candidate, preview=True)
    except (BuildError, OSError) as error:
        print(f"Preview build failed (keeping the last successful build): {error}", flush=True)
        shutil.rmtree(candidate)
        return False
    previous = output.resolve() if output.is_symlink() else None
    link = output.with_name("next")
    link.symlink_to(candidate, target_is_directory=True)
    link.replace(output)
    if previous:
        shutil.rmtree(previous)
    return True


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bind", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8081)
    args = parser.parse_args()
    os.environ.setdefault("HUGO_BASEURL", f"http://localhost:{args.port}/")
    os.environ.setdefault("HUGO_PARAMS_DISABLECOMMENTS", "true")
    root = Path(__file__).resolve().parents[1]
    with tempfile.TemporaryDirectory(prefix="blog-preview-") as temp:
        output = Path(temp) / "public"
        state = fingerprint(root)
        if not rebuild(root, output):
            raise SystemExit(1)
        server = ThreadingHTTPServer((args.bind, args.port), partial(SimpleHTTPRequestHandler, directory=str(output)))
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        print(f"Preview listening on {args.bind}:{args.port}; watching for changes (refresh your browser).", flush=True)
        try:
            while thread.is_alive():
                thread.join(timeout=1)
                current = fingerprint(root)
                if current != state:
                    state = current
                    rebuild(root, output)
        except KeyboardInterrupt:
            pass
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    main()
