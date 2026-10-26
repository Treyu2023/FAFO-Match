"""FAFO Match local server.

Binds to 127.0.0.1 only. Scans a folder you name, hashes copies, and
(when ffmpeg is installed) shrinks a few frames so renamed upscales still pair.
Exits about 90 seconds after the page stops pinging, so it does not stay
running in the background.
"""

from __future__ import annotations

import hashlib
import json
import mimetypes
import os
import shutil
import subprocess
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

HOST = "127.0.0.1"
PORT = 18766
IDLE_SEC = 90
ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
VIDEO = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".ogv"}
IMAGE = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"}
SKIP = {"thumbs.db", ".ds_store", "desktop.ini"}

_lock = threading.Lock()
_last_ping = time.time()
_allowed: set[Path] = set()
_job: dict = {"phase": "idle", "done": 0, "total": 0, "items": [], "error": ""}


def touch() -> None:
    global _last_ping
    _last_ping = time.time()


def ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


def ffprobe_bin() -> str | None:
    return shutil.which("ffprobe")


def duration_of(path: Path) -> float:
    probe = ffprobe_bin()
    if not probe:
        return 0.0
    try:
        out = subprocess.check_output(
            [
                probe,
                "-v",
                "error",
                "-show_entries",
                "format=duration",
                "-of",
                "csv=p=0",
                str(path),
            ],
            stderr=subprocess.DEVNULL,
            timeout=20,
        )
        return max(0.0, float(out.decode().strip() or 0))
    except Exception:
        return 0.0


def mosaics_of(path: Path, duration: float) -> list[list[int]]:
    ffmpeg = ffmpeg_bin()
    if not ffmpeg:
        return []
    stamps = [0.2, 0.5, 0.8] if duration <= 0 else [duration * t for t in (0.2, 0.5, 0.8)]
    frames: list[list[int]] = []
    for stamp in stamps:
        try:
            raw = subprocess.check_output(
                [
                    ffmpeg,
                    "-hide_banner",
                    "-loglevel",
                    "error",
                    "-ss",
                    f"{max(0.0, stamp):.3f}",
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=16:9",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "gray",
                    "-",
                ],
                stderr=subprocess.DEVNULL,
                timeout=30,
            )
        except Exception:
            continue
        if len(raw) >= 144:
            frames.append([int(b) for b in raw[:144]])
    return frames


def byte_hash(path: Path, size: int) -> str:
    h = hashlib.sha256()
    with path.open("rb") as handle:
        if size <= 24 * 1024 * 1024:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                h.update(chunk)
            return h.hexdigest()
        chunk = 1024 * 1024
        h.update(handle.read(chunk))
        mid = max(0, size // 2 - chunk // 2)
        handle.seek(mid)
        h.update(handle.read(chunk))
        handle.seek(max(0, size - chunk))
        h.update(handle.read(chunk))
    return "q:" + h.hexdigest()


def safe_path(raw: str) -> Path | None:
    try:
        path = Path(raw).expanduser().resolve()
    except OSError:
        return None
    if not path.exists() or not path.is_file():
        return None
    for root in list(_allowed):
        try:
            path.relative_to(root)
            return path
        except ValueError:
            continue
    return None


def scan(folder: str) -> None:
    global _job
    root = Path(folder).expanduser().resolve()
    if not root.is_dir():
        with _lock:
            _job = {"phase": "error", "done": 0, "total": 0, "items": [], "error": "That folder does not exist."}
        return
    files: list[Path] = []
    for dirpath, dirnames, names in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for name in names:
            if name.startswith(".") or name.lower() in SKIP:
                continue
            ext = Path(name).suffix.lower()
            if ext in VIDEO or ext in IMAGE:
                files.append(Path(dirpath) / name)
    items = []
    total = len(files)
    with _lock:
        _allowed.add(root)
        _job = {"phase": "scan", "done": 0, "total": total, "items": [], "error": "", "root": str(root)}
    for index, path in enumerate(files, start=1):
        try:
            stat = path.stat()
            kind = "video" if path.suffix.lower() in VIDEO else "image"
            dur = duration_of(path) if kind == "video" else 0.0
            mosaics = mosaics_of(path, dur) if kind == "video" else []
            if kind == "image" and ffmpeg_bin():
                mosaics = mosaics_of(path, 0)
            items.append(
                {
                    "name": path.name,
                    "path": str(path),
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime * 1000),
                    "kind": kind,
                    "duration": dur,
                    "byteHash": byte_hash(path, stat.st_size),
                    "mosaics": mosaics,
                    "dhashes": [],
                    "width": 0,
                    "height": 0,
                }
            )
        except OSError:
            continue
        if index % 5 == 0 or index == total:
            with _lock:
                _job = {**_job, "phase": "scan", "done": index, "total": total, "items": items}
    with _lock:
        _job = {**_job, "phase": "done", "done": total, "total": total, "items": items, "ffmpeg": bool(ffmpeg_bin())}


def recycle(paths: list[str]) -> dict:
    moved = []
    failed = []
    for raw in paths:
        path = safe_path(raw)
        if path is None:
            failed.append(raw)
            continue
        if os.name == "nt":
            script = (
                "Add-Type -AssemblyName Microsoft.VisualBasic; "
                f"[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile('{str(path).replace(chr(39), chr(39)*2)}', 'OnlyErrorDialogs', 'SendToRecycleBin')"
            )
            result = subprocess.run(
                ["powershell", "-NoProfile", "-Command", script],
                capture_output=True,
                text=True,
            )
            if result.returncode == 0:
                moved.append(str(path))
            else:
                failed.append(str(path))
        else:
            failed.append(str(path))
    return {"recycled": moved, "failed": failed}


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def _send(self, code: int, body: bytes, content_type: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _json(self, code: int, payload: dict) -> None:
        self._send(code, json.dumps(payload).encode(), "application/json")

    def _read_json(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(min(length, 2_000_000))
        try:
            data = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            return {}
        return data if isinstance(data, dict) else {}

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        touch()
        parsed = urlparse(self.path)
        if parsed.path in ("/", "/index.html"):
            data = (WEB / "index.html").read_bytes()
            self._send(200, data, "text/html; charset=utf-8")
            return
        name = Path(parsed.path).name
        if name in {"styles.css", "app.js", "match-core.js", "index.html"}:
            target = WEB / name
            if target.is_file():
                ctype = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
                self._send(200, target.read_bytes(), ctype)
                return
        if parsed.path == "/api/health":
            self._json(200, {"ok": True, "port": PORT, "ffmpeg": bool(ffmpeg_bin()), "idleSec": IDLE_SEC})
            return
        if parsed.path == "/api/scan":
            with _lock:
                snap = dict(_job)
            self._json(200, snap)
            return
        if parsed.path == "/media":
            query = parse_qs(parsed.query)
            raw = (query.get("path") or [""])[0]
            path = safe_path(raw)
            if path is None:
                self._json(404, {"error": "That file is not in a folder you scanned."})
                return
            ctype = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
            data = path.read_bytes()
            self._send(200, data, ctype)
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        touch()
        parsed = urlparse(self.path)
        body = self._read_json()
        if parsed.path == "/api/heartbeat":
            self._json(200, {"ok": True})
            return
        if parsed.path == "/api/scan":
            folder = str(body.get("path") or "").strip()
            if not folder:
                self._json(400, {"error": "Give a folder path."})
                return
            threading.Thread(target=scan, args=(folder,), daemon=True).start()
            self._json(200, {"ok": True})
            return
        if parsed.path == "/api/recycle":
            paths = body.get("paths") if isinstance(body.get("paths"), list) else []
            self._json(200, recycle([str(p) for p in paths]))
            return
        self._json(404, {"error": "not found"})


def idle_watch() -> None:
    while True:
        time.sleep(5)
        if time.time() - _last_ping > IDLE_SEC:
            os._exit(0)


def main() -> None:
    touch()
    threading.Thread(target=idle_watch, daemon=True).start()
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"FAFO Match  http://{HOST}:{PORT}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        traceback.print_exc()
        raise
