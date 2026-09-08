#!/usr/bin/env python3
"""HTTP gateway for the Linux/NVIDIA reconstruction worker."""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import threading
import uuid
from email.parser import BytesParser
from email.policy import default
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, unquote

ROOT = Path(os.environ.get("WORKER_ROOT", "/opt/3dmapping-worker")).resolve()
JOBS = ROOT / "jobs"
RECONSTRUCT = ROOT / "worker" / "reconstruct.py"
HOST = os.environ.get("WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WORKER_PORT", "8080"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024)))
CORS = os.environ.get("WORKER_CORS", "*")
API_KEY = os.environ.get("WORKER_API_KEY", "")
JOBS.mkdir(parents=True, exist_ok=True)


def read_json(path: Path) -> dict:
    try:
        return json.loads(path.read_text())
    except Exception:
        return {"status": "unknown"}


def launch(job_id: str, video: Path, job_dir: Path) -> None:
    result = job_dir / "result.json"
    try:
        cmd = [
            os.environ.get("PYTHON", "python3"), str(RECONSTRUCT),
            "--input", str(video), "--job", str(job_dir),
            "--fps", os.environ.get("RECONSTRUCTION_FPS", "4"),
            "--max-frames", os.environ.get("RECONSTRUCTION_MAX_FRAMES", "160"),
            "--iterations", os.environ.get("SPLAT_ITERATIONS", "30000"),
        ]
        subprocess.run(cmd, cwd=ROOT, check=False)
    except Exception as exc:
        result.write_text(json.dumps({"status": "failed", "stage": "worker", "progress": 0, "message": str(exc), "error": str(exc)}, indent=2))


def safe_artifact(job_dir: Path, relative: str) -> Path | None:
    try:
        candidate = (job_dir / unquote(relative)).resolve()
        candidate.relative_to(job_dir.resolve())
        if candidate.is_file():
            return candidate
    except (OSError, ValueError):
        pass
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "3DMappingWorker/0.3"

    def authorized(self) -> bool:
        if not API_KEY:
            return True
        return self.headers.get("X-3DMapping-Key", "") == API_KEY

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", CORS)
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-3DMapping-Key")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def send_file(self, path: Path) -> None:
        size = path.stat().st_size
        start, end = 0, size - 1
        range_header = self.headers.get("Range", "")
        if range_header.startswith("bytes="):
            try:
                value = range_header[6:].split(",", 1)[0]
                left, right = value.split("-", 1)
                if left:
                    start = int(left)
                    end = int(right) if right else end
                else:
                    start = max(0, size - int(right))
                start, end = max(0, start), min(size - 1, end)
                if start > end:
                    raise ValueError
            except ValueError:
                self.send_response(416)
                self.end_headers()
                return

        length = max(0, end - start + 1)
        self.send_response(206 if range_header else 200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(length))
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Access-Control-Allow-Origin", CORS)
        self.send_header("Cache-Control", "public, max-age=3600")
        if range_header:
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        self.end_headers()
        with path.open("rb") as handle:
            handle.seek(start)
            remaining = length
            while remaining:
                chunk = handle.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok", "service": "3dmapping-worker", "version": "0.3", "auth_enabled": bool(API_KEY)})
            return
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return

        parts = parsed.path.strip("/").split("/")
        if len(parts) >= 4 and parts[0] == "jobs" and parts[2] == "artifact":
            job_id = parts[1]
            job_dir = JOBS / job_id
            artifact = safe_artifact(job_dir, "/".join(parts[3:])) if job_dir.is_dir() else None
            if artifact is None:
                self.send_json(404, {"error": "artifact not found"})
                return
            self.send_file(artifact)
            return

        if len(parts) == 2 and parts[0] == "jobs":
            job_id = parts[1]
            job_dir = JOBS / job_id
            if not job_dir.is_dir():
                self.send_json(404, {"error": "job not found"})
                return
            payload = read_json(job_dir / "result.json")
            payload["job_id"] = job_id
            artifact = payload.get("artifact")
            if artifact:
                payload["artifact_url"] = f"/jobs/{job_id}/artifact/{artifact}"
            self.send_json(200, payload)
            return

        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        if not self.authorized():
            self.send_json(401, {"error": "unauthorized"})
            return
        parsed = urlparse(self.path)
        if parsed.path != "/jobs":
            self.send_json(404, {"error": "not found"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_UPLOAD:
            self.send_json(413, {"error": "invalid or oversized upload"})
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_json(415, {"error": "upload must be multipart/form-data with field 'video'"})
            return

        raw = self.rfile.read(length)
        msg = BytesParser(policy=default).parsebytes((f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n").encode() + raw)
        part = next((p for p in msg.iter_parts() if p.get_param("name", header="Content-Disposition") == "video"), None)
        if part is None:
            self.send_json(400, {"error": "missing multipart field 'video'"})
            return

        filename = Path(part.get_filename() or "drone.mp4").name
        suffix = Path(filename).suffix.lower()
        if suffix not in {".mp4", ".mov", ".m4v", ".avi", ".mkv"}:
            self.send_json(400, {"error": "unsupported video format"})
            return

        job_id = uuid.uuid4().hex
        job_dir = JOBS / job_id
        job_dir.mkdir(parents=True)
        video = job_dir / f"input{suffix}"
        video.write_bytes(part.get_payload(decode=True) or b"")
        if video.stat().st_size == 0:
            shutil.rmtree(job_dir, ignore_errors=True)
            self.send_json(400, {"error": "empty upload"})
            return

        (job_dir / "result.json").write_text(json.dumps({
            "status": "queued", "stage": "queued", "progress": 0,
            "message": "Upload received; waiting for reconstruction process.",
            "job_id": job_id, "filename": filename,
        }, indent=2))
        threading.Thread(target=launch, args=(job_id, video, job_dir), daemon=True).start()
        self.send_json(202, {"job_id": job_id, "status": "queued"})


if __name__ == "__main__":
    print(f"3DMapping worker listening on http://{HOST}:{PORT} (auth={'on' if API_KEY else 'off'})", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
