#!/usr/bin/env python3
"""Small HTTP gateway for the GPU reconstruction worker.

Runs on the Linux/NVIDIA machine. The Mac frontend can upload a video, receive a
job id, and poll its status without needing Python/CUDA locally.
"""
from __future__ import annotations

import json
import mimetypes
import os
import shutil
import subprocess
import tempfile
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(os.environ.get("WORKER_ROOT", "/opt/3dmapping-worker")).resolve()
JOBS = ROOT / "jobs"
RECONSTRUCT = ROOT / "worker" / "reconstruct.py"
HOST = os.environ.get("WORKER_HOST", "0.0.0.0")
PORT = int(os.environ.get("WORKER_PORT", "8080"))
MAX_UPLOAD = int(os.environ.get("MAX_UPLOAD_BYTES", str(2 * 1024 * 1024 * 1024)))
CORS = os.environ.get("WORKER_CORS", "*")
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
            os.environ.get("PYTHON", "python3"),
            str(RECONSTRUCT),
            "--input", str(video),
            "--job", str(job_dir),
            "--fps", os.environ.get("RECONSTRUCTION_FPS", "4"),
            "--max-frames", os.environ.get("RECONSTRUCTION_MAX_FRAMES", "160"),
            "--iterations", os.environ.get("SPLAT_ITERATIONS", "30000"),
        ]
        subprocess.run(cmd, cwd=ROOT, check=False)
    except Exception as exc:
        result.write_text(json.dumps({"status": "failed", "error": str(exc)}, indent=2))


class Handler(BaseHTTPRequestHandler):
    server_version = "3DMappingWorker/0.1"

    def send_json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", CORS)
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET,POST,OPTIONS")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_json(204, {})

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json(200, {"status": "ok", "service": "3dmapping-worker"})
            return
        parts = parsed.path.strip("/").split("/")
        if len(parts) == 2 and parts[0] == "jobs":
            job_id = parts[1]
            job_dir = JOBS / job_id
            if not job_dir.is_dir():
                self.send_json(404, {"error": "job not found"})
                return
            payload = read_json(job_dir / "result.json")
            payload["job_id"] = job_id
            self.send_json(200, payload)
            return
        if len(parts) == 3 and parts[0] == "jobs" and parts[2] in {"result.json"}:
            self.send_json(404, {"error": "use /jobs/{id}"})
            return
        self.send_json(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/jobs":
            self.send_json(404, {"error": "not found"})
            return
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_UPLOAD:
            self.send_json(413, {"error": "invalid or oversized upload"})
            return
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self.send_json(415, {"error": "upload must be multipart/form-data with field 'video'"})
            return

        # Use the standard library multipart parser via email's MIME machinery.
        from email.parser import BytesParser
        from email.policy import default
        raw = self.rfile.read(length)
        msg = BytesParser(policy=default).parsebytes(
            (f"Content-Type: {content_type}\r\nMIME-Version: 1.0\r\n\r\n").encode() + raw
        )
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
        (job_dir / "result.json").write_text(json.dumps({"status": "queued", "job_id": job_id, "filename": filename}, indent=2))
        threading.Thread(target=launch, args=(job_id, video, job_dir), daemon=True).start()
        self.send_json(202, {"job_id": job_id, "status": "queued"})


if __name__ == "__main__":
    print(f"3DMapping worker listening on http://{HOST}:{PORT}", flush=True)
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
