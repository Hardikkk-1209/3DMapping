#!/usr/bin/env python3
"""Run the compute-heavy drone-video -> COLMAP -> Gaussian Splat pipeline.

The worker deliberately uses subprocesses instead of OpenCV/Python CV bindings so
it can run on a dedicated Linux GPU machine independently of the web frontend.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path


def run(cmd: list[str], *, cwd: Path | None = None, env: dict[str, str] | None = None) -> None:
    print("$", " ".join(cmd), flush=True)
    subprocess.run(cmd, cwd=cwd, env=env, check=True)


def require(binary: str) -> None:
    if shutil.which(binary) is None:
        raise RuntimeError(f"Required executable not found: {binary}")


def ffprobe(path: Path) -> dict:
    cmd = [
        "ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
        "-show_format", str(path),
    ]
    out = subprocess.check_output(cmd, text=True)
    data = json.loads(out)
    stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    rate = stream.get("r_frame_rate", "0/1")
    try:
        n, d = rate.split("/")
        fps = float(n) / float(d)
    except Exception:
        fps = 0.0
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": round(fps, 3),
        "duration_s": round(float(stream.get("duration") or data.get("format", {}).get("duration") or 0), 3),
        "codec": stream.get("codec_name", "unknown"),
    }


def extract_frames(video: Path, images: Path, fps: float, max_frames: int) -> int:
    images.mkdir(parents=True, exist_ok=True)
    duration = max(0.0, float(ffprobe(video)["duration_s"]))
    requested = min(max_frames, max(12, int(duration * fps + 0.5)))
    effective_fps = requested / duration if duration > 0 else fps
    # Avoid a huge burst of nearly identical frames. The extracted sequence is
    # intentionally numbered and deterministic so COLMAP can use sequential matching.
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y",
        "-i", str(video),
        "-vf", f"fps={effective_fps:.8f},scale='min(1920,iw)':-2",
        "-frames:v", str(max_frames),
        "-q:v", "2",
        str(images / "%06d.jpg"),
    ])
    return len(list(images.glob("*.jpg")))


def sparse_model(sparse_root: Path) -> Path:
    candidates = sorted(p for p in sparse_root.iterdir() if p.is_dir() and p.name.isdigit()) if sparse_root.exists() else []
    if not candidates:
        raise RuntimeError("COLMAP mapper produced no sparse model. The footage could not be registered.")
    return candidates[0]


def registered_images(model: Path) -> int:
    images_bin = model / "images.bin"
    images_txt = model / "images.txt"
    if images_txt.exists():
        lines = images_txt.read_text(errors="ignore").splitlines()
        # COLMAP text format has one non-comment line per registered image,
        # followed by its 2D points line.
        return sum(1 for line in lines if line and not line.startswith("#")) // 2
    if images_bin.exists():
        # Avoid a Python COLMAP database dependency. `model_analyzer` is used
        # as the authoritative parser below when available.
        return 0
    return 0


def analyze_model(model: Path) -> str:
    try:
        output = subprocess.check_output(
            ["colmap", "model_analyzer", "--path", str(model)],
            text=True,
            stderr=subprocess.STDOUT,
        )
        print(output, flush=True)
        return output
    except subprocess.CalledProcessError as exc:
        print(exc.output or "COLMAP model_analyzer failed", flush=True)
        return ""


def train_splat(dataset: Path, output: Path, gs_repo: Path, iterations: int) -> Path:
    train = gs_repo / "train.py"
    if not train.exists():
        raise RuntimeError(f"Gaussian Splatting trainer not found at {train}")
    output.mkdir(parents=True, exist_ok=True)
    run([
        sys.executable, str(train),
        "-s", str(dataset),
        "-m", str(output),
        "--iterations", str(iterations),
    ], cwd=gs_repo)
    return output


def write_result(job: Path, result: dict) -> None:
    tmp = job / "result.json.tmp"
    tmp.write_text(json.dumps(result, indent=2) + "\n")
    tmp.replace(job / "result.json")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--job", required=True, type=Path)
    parser.add_argument("--fps", type=float, default=4.0)
    parser.add_argument("--max-frames", type=int, default=160)
    parser.add_argument("--min-registration", type=float, default=0.35)
    parser.add_argument("--iterations", type=int, default=30000)
    parser.add_argument("--skip-splat", action="store_true")
    args = parser.parse_args()

    started = time.time()
    require("ffmpeg")
    require("ffprobe")
    require("colmap")
    if not args.input.exists():
        raise RuntimeError(f"Input video does not exist: {args.input}")

    job = args.job.resolve()
    job.mkdir(parents=True, exist_ok=True)
    video = job / "input" + args.input.suffix if False else job / f"input{args.input.suffix.lower()}"
    shutil.copy2(args.input, video)
    images = job / "images"
    sparse = job / "sparse"
    dense = job / "dense"
    database = job / "database.db"
    result = {
        "status": "running",
        "job": str(job),
        "input": ffprobe(video),
        "started_at_unix": started,
    }
    write_result(job, result)

    try:
        extracted = extract_frames(video, images, args.fps, args.max_frames)
        if extracted < 12:
            raise RuntimeError(f"Only {extracted} frames were extracted; at least 12 are required.")
        result["extracted_frames"] = extracted
        write_result(job, result)

        run([
            "colmap", "feature_extractor",
            "--database_path", str(database),
            "--image_path", str(images),
            "--ImageReader.single_camera", "1",
            "--FeatureExtraction.use_gpu", "1",
        ])
        run([
            "colmap", "sequential_matcher",
            "--database_path", str(database),
            "--SequentialMatching.overlap", "10",
            "--FeatureMatching.use_gpu", "1",
        ])
        sparse.mkdir(parents=True, exist_ok=True)
        run([
            "colmap", "mapper",
            "--database_path", str(database),
            "--image_path", str(images),
            "--output_path", str(sparse),
        ])
        model = sparse_model(sparse)
        analysis = analyze_model(model)
        result["sparse_model"] = str(model)
        result["model_analysis"] = analysis

        # Convert the binary model to text so registration count is inspectable
        # without adding a COLMAP Python package to this worker.
        text_model = job / "sparse_text"
        text_model.mkdir(exist_ok=True)
        run([
            "colmap", "model_converter",
            "--input_path", str(model),
            "--output_path", str(text_model),
            "--output_type", "TXT",
        ])
        reg = registered_images(text_model)
        result["registered_images"] = reg
        result["registration_ratio"] = round(reg / extracted, 4)
        write_result(job, result)

        if result["registration_ratio"] < args.min_registration:
            result["status"] = "insufficient_registration"
            result["error"] = (
                f"Only {reg}/{extracted} frames registered in SfM. "
                "The capture needs more overlap, slower motion, texture, or additional viewpoints."
            )
            write_result(job, result)
            return 2

        run([
            "colmap", "image_undistorter",
            "--image_path", str(images),
            "--input_path", str(model),
            "--output_path", str(dense),
            "--output_type", "COLMAP",
        ])
        result["dense_workspace"] = str(dense)

        if not args.skip_splat:
            gs_repo_env = os.environ.get("GS_REPO")
            if not gs_repo_env:
                result["status"] = "colmap_ready"
                result["splat_error"] = "GS_REPO is not configured; COLMAP reconstruction completed."
                write_result(job, result)
                return 0
            splat = train_splat(job, job / "splat", Path(gs_repo_env), args.iterations)
            result["splat_output"] = str(splat)
            result["status"] = "completed"
        else:
            result["status"] = "colmap_ready"

        result["duration_s"] = round(time.time() - started, 2)
        write_result(job, result)
        return 0
    except subprocess.CalledProcessError as exc:
        result["status"] = "failed"
        result["error"] = f"Command failed with exit code {exc.returncode}"
        write_result(job, result)
        return exc.returncode or 1
    except Exception as exc:
        result["status"] = "failed"
        result["error"] = str(exc)
        result["duration_s"] = round(time.time() - started, 2)
        write_result(job, result)
        print(f"ERROR: {exc}", file=sys.stderr, flush=True)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
