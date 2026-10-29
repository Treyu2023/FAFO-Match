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
from concurrent.futures import ThreadPoolExecutor, as_completed
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
MIME = {
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".ogv": "video/ogg",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".bmp": "image/bmp",
}

_lock = threading.Lock()
_last_ping = time.time()
_allowed: set[Path] = set()
_job: dict = {"phase": "idle", "done": 0, "total": 0, "items": [], "error": ""}


def touch() -> None:
    global _last_ping
    _last_ping = time.time()


def ffmpeg_bin() -> str | None:
    return shutil.which("ffmpeg")


def parse_byte_range(header: str | None, size: int) -> tuple[int, int] | None:
    """Inclusive byte range. None means send the whole file. ValueError means 416."""
    if size <= 0 or not header or not header.lower().startswith("bytes="):
        return None
    spec = header.split("=", 1)[1].split(",")[0].strip()
    if "-" not in spec:
        return None
    start_s, end_s = spec.split("-", 1)
    if start_s == "" and end_s == "":
        return None
    if start_s == "":
        length = int(end_s)
        if length <= 0:
            raise ValueError("empty")
        start = max(0, size - length)
        end = size - 1
    else:
        start = int(start_s)
        end = int(end_s) if end_s else size - 1
    if start >= size or end < start or start < 0:
        raise ValueError("unsatisfiable")
    return start, min(end, size - 1)


def content_type(path: Path) -> str:
    return MIME.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "application/octet-stream"


def grab_mosaic(path: Path, kind: str) -> list[list[int]]:
    """A few tiny frames from the start of the file. Never seeks to the end."""
    ffmpeg = ffmpeg_bin()
    if not ffmpeg:
        return []
    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-analyzeduration",
        "2000000",
        "-probesize",
        "5000000",
    ]
    if kind == "video":
        cmd += ["-ss", "0.2"]
    cmd += [
        "-i",
        str(path),
        "-an",
        "-sn",
        "-dn",
        "-frames:v",
        "3" if kind == "video" else "1",
        "-vf",
        "fps=2,scale=16:9:flags=fast_bilinear" if kind == "video" else "scale=16:9:flags=fast_bilinear",
        "-f",
        "rawvideo",
        "-pix_fmt",
        "gray",
        "-",
    ]
    try:
        raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=8)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        return []
    frames: list[list[int]] = []
    for offset in range(0, len(raw) - 143, 144):
        frames.append([int(b) for b in raw[offset : offset + 144]])
        if len(frames) == 3:
            break
    return frames


_thumbs: dict[tuple, bytes] = {}


def thumb_jpeg(path: Path, stamp: float) -> bytes | None:
    key = (str(path), path.stat().st_mtime_ns, round(stamp, 1))
    cached = _thumbs.get(key)
    if cached is not None:
        return cached
    ffmpeg = ffmpeg_bin()
    if not ffmpeg:
        return None
    cmd = [
        ffmpeg,
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-ss",
        f"{max(0.0, stamp):.3f}",
        "-i",
        str(path),
        "-an",
        "-sn",
        "-frames:v",
        "1",
        "-vf",
        "scale=160:-2:flags=fast_bilinear",
        "-f",
        "image2pipe",
        "-vcodec",
        "mjpeg",
        "-",
    ]
    try:
        raw = subprocess.check_output(cmd, stderr=subprocess.DEVNULL, timeout=6)
    except (subprocess.TimeoutExpired, subprocess.CalledProcessError, OSError):
        return None
    if not raw:
        return None
    if len(_thumbs) > 400:
        _thumbs.clear()
    _thumbs[key] = raw
    return raw


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
    items: list[dict] = []
    total = len(files)

    def one(index: int, path: Path) -> dict | None:
        try:
            stat = path.stat()
        except OSError:
            return None
        kind = "video" if path.suffix.lower() in VIDEO else "image"
        return {
            "index": index,
            "name": path.name,
            "path": str(path),
            "size": stat.st_size,
            "mtime": int(stat.st_mtime * 1000),
            "kind": kind,
            "duration": 0.0,
            "byteHash": byte_hash(path, stat.st_size),
            "mosaics": grab_mosaic(path, kind),
            "dhashes": [],
            "width": 0,
            "height": 0,
        }

    with _lock:
        _allowed.add(root)
        _job = {"phase": "scan", "done": 0, "total": total, "items": [], "error": "", "root": str(root), "file": ""}
    done = 0
    with ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(one, index, path): path for index, path in enumerate(files, start=1)}
        for future in as_completed(futures):
            path = futures[future]
            done += 1
            try:
                item = future.result()
            except Exception:
                item = None
            if item:
                items.append(item)
            with _lock:
                _job = {**_job, "phase": "scan", "done": done, "total": total, "file": path.name, "items": []}
    items.sort(key=lambda item: item.get("index", 0))
    for item in items:
        item.pop("index", None)
    with _lock:
        _job = {**_job, "phase": "done", "done": total, "total": total, "file": "", "items": items, "ffmpeg": bool(ffmpeg_bin())}


def stamp_name(name: str, pid: str) -> str:
    pid = pid.lower()
    if len(pid) != 8:
        return name
    dot = name.rfind(".")
    stem, ext = (name[:dot], name[dot:]) if dot > 0 else (name, "")
    if f"_PID_{pid}" in stem.lower():
        return name
    import re

    stem = re.sub(r"_PID_[0-9a-fA-F]{8}", "", stem).rstrip("._- ") or "clip"
    return f"{stem}_PID_{pid}{ext}"


def stamp_files(pid: str, paths: list[str]) -> dict:
    pid = str(pid or "").lower().strip()
    if len(pid) != 8 or any(ch not in "0123456789abcdef" for ch in pid):
        return {"error": "Process id must be 8 hex characters."}
    renamed = []
    failed = []
    for raw in paths:
        path = safe_path(raw)
        if path is None:
            failed.append(raw)
            continue
        dest = path.with_name(stamp_name(path.name, pid))
        try:
            if dest != path:
                if dest.exists():
                    failed.append(str(path))
                    continue
                path.rename(dest)
            renamed.append(str(dest))
        except OSError:
            failed.append(str(path))
    return {"renamed": renamed, "failed": failed, "pid": pid}


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
            self._serve_media(parsed, write_body=True)
            return
        if parsed.path == "/thumb":
            self._serve_thumb(parsed)
            return
        self._json(404, {"error": "not found"})

    def do_HEAD(self) -> None:
        touch()
        parsed = urlparse(self.path)
        if parsed.path == "/media":
            self._serve_media(parsed, write_body=False)
            return
        self.send_response(404)
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _serve_thumb(self, parsed) -> None:
        query = parse_qs(parsed.query)
        path = safe_path((query.get("path") or [""])[0])
        if path is None:
            self._json(404, {"error": "That file is not in a folder you scanned."})
            return
        try:
            stamp = float((query.get("t") or ["0.4"])[0])
        except ValueError:
            stamp = 0.4
        data = thumb_jpeg(path, stamp)
        if not data:
            self._json(404, {"error": "No still for that file."})
            return
        self.send_response(200)
        self.send_header("Content-Type", "image/jpeg")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "private, max-age=86400")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        try:
            self.wfile.write(data)
        except OSError:
            return

    def _serve_media(self, parsed, write_body: bool) -> None:
        query = parse_qs(parsed.query)
        path = safe_path((query.get("path") or [""])[0])
        if path is None:
            self._json(404, {"error": "That file is not in a folder you scanned."})
            return
        try:
            size = path.stat().st_size
        except OSError:
            self._json(404, {"error": "That file is not in a folder you scanned."})
            return
        try:
            span = parse_byte_range(self.headers.get("Range"), size)
        except ValueError:
            self.send_response(416)
            self.send_header("Content-Range", f"bytes */{size}")
            self.send_header("Accept-Ranges", "bytes")
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        start, end = (0, max(0, size - 1)) if span is None else span
        length = 0 if size == 0 else end - start + 1
        status = 206 if span is not None else 200
        self.send_response(status)
        self.send_header("Content-Type", content_type(path))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == 206:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Cache-Control", "private, max-age=3600")
        self.end_headers()
        if not write_body or length <= 0:
            return
        try:
            with path.open("rb") as handle:
                handle.seek(start)
                remaining = length
                while remaining > 0:
                    chunk = handle.read(min(256 * 1024, remaining))
                    if not chunk:
                        break
                    self.wfile.write(chunk)
                    remaining -= len(chunk)
        except OSError:
            return

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
        if parsed.path == "/api/stamp":
            paths = body.get("paths") if isinstance(body.get("paths"), list) else []
            self._json(200, stamp_files(str(body.get("pid") or ""), [str(p) for p in paths]))
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
