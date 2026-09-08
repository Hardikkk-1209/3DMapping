#!/usr/bin/env python3
"""Drone video -> COLMAP/SfM -> Gaussian Splat reconstruction worker."""
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
    out = subprocess.check_output([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_streams",
        "-show_format", str(path),
    ], text=True)
    data = json.loads(out)
    stream = next((s for s in data.get("streams", []) if s.get("codec_type") == "video"), {})
    rate = stream.get("r_frame_rate", "0/1")
    try:
        n, d = rate.split("/")
        fps = float(n) / float(d)
    except Exception:
        fps = 0.0
    duration = float(stream.get("duration") or data.get("format", {}).get("duration") or 0)
    frames = int(stream.get("nb_frames") or 0)
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "fps": round(fps, 3),
        "frames": frames,
        "duration_s": round(duration, 3),
        "codec": stream.get("codec_name", "unknown"),
    }


def write_result(job: Path, result: dict) -> None:
    tmp = job / "result.json.tmp"
    tmp.write_text(json.dumps(result, indent=2) + "\n")
    tmp.replace(job / "result.json")


def update(result: dict, job: Path, *, status: str | None = None, stage: str | None = None,
           progress: int | None = None, message: str | None = None) -> None:
    if status is not None:
        result["status"] = status
    if stage is not None:
        result["stage"] = stage
    if progress is not None:
        result["progress"] = max(0, min(100, int(progress)))
    if message is not None:
        result["message"] = message
    write_result(job, result)


def extract_frames(video: Path, images: Path, fps: float, max_frames: int) -> int:
    images.mkdir(parents=True, exist_ok=True)
    duration = max(0.0, float(ffprobe(video)["duration_s"]))
    requested = min(max_frames, max(12, int(duration * fps + 0.5)))
    effective_fps = requested / duration if duration > 0 else fps
    run([
        "ffmpeg", "-hide_banner", "-loglevel", "warning", "-y", "-i", str(video),
        "-vf", f"fps={effective_fps:.8f},scale='min(1920,iw)':-2",
        "-frames:v", str(max_frames), "-q:v", "2", str(images / "%06d.jpg"),
    ])
    return len(list(images.glob("*.jpg")))


def sparse_model(sparse_root: Path) -> Path:
    candidates = sorted(p for p in sparse_root.iterdir() if p.is_dir() and p.name.isdigit()) if sparse_root.exists() else []
    if not candidates:
        raise RuntimeError("COLMAP mapper produced no sparse model. The footage could not be registered.")
    return candidates[0]


def registered_images(model: Path) -> int:
    images_txt = model / "images.txt"
    if not images_txt.exists():
        return 0
    lines = images_txt.read_text(errors="ignore").splitlines()
    return sum(1 for line in lines if line and not line.startswith("#")) // 2


def analyze_model(model: Path) -> str:
    try:
        output = subprocess.check_output(["colmap", "model_analyzer", "--path", str(model)], text=True, stderr=subprocess.STDOUT)
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
        sys.executable, str(train), "-s", str(dataset), "-m", str(output),
        "--iterations", str(iterations),
        "--save_iterations", str(iterations),
        "--disable_viewer",
    ], cwd=gs_repo)
    point_cloud = output / "point_cloud" / f"iteration_{iterations}" / "point_cloud.ply"
    if not point_cloud.exists():
        raise RuntimeError(f"Gaussian Splatting finished without {point_cloud}")
    return point_cloud


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
    for binary in ("ffmpeg", "ffprobe", "colmap"):
        require(binary)
    if not args.input.exists():
        raise RuntimeError(f"Input video does not exist: {args.input}")

    job = args.job.resolve()
    job.mkdir(parents=True, exist_ok=True)
    video = job / f"input{args.input.suffix.lower()}"
    if args.input.resolve() != video.resolve():
        shutil.copy2(args.input, video)

    result = {
        "status": "queued", "stage": "queued", "progress": 0,
        "message": "Job accepted by reconstruction worker.", "job": str(job),
        "input": ffprobe(video), "started_at_unix": started,
    }
    write_result(job, result)

    try:
        images = job / "images"
        sparse = job / "sparse"
        dense = job / "dense"
        database = job / "database.db"

        update(result, job, status="running", stage="extract", progress=8, message="Extracting sharp, evenly spaced frames from the drone video.")
        extracted = extract_frames(video, images, args.fps, args.max_frames)
        if extracted < 12:
            raise RuntimeError(f"Only {extracted} frames were extracted; at least 12 are required.")
        result["extracted_frames"] = extracted

        update(result, job, stage="features", progress=22, message=f"Finding visual features in {extracted} reconstruction frames.")
        run(["colmap", "feature_extractor", "--database_path", str(database), "--image_path", str(images), "--ImageReader.single_camera", "1", "--FeatureExtraction.use_gpu", "1"])

        update(result, job, stage="matching", progress=36, message="Matching neighboring video frames with sequential overlap.")
        run(["colmap", "sequential_matcher", "--database_path", str(database), "--SequentialMatching.overlap", "10", "--FeatureMatching.use_gpu", "1"])

        update(result, job, stage="sfm", progress=50, message="Estimating camera poses and building the sparse 3D model.")
        sparse.mkdir(parents=True, exist_ok=True)
        run(["colmap", "mapper", "--database_path", str(database), "--image_path", str(images), "--output_path", str(sparse)])
        model = sparse_model(sparse)
        result["sparse_model"] = str(model)
        result["model_analysis"] = analyze_model(model)

        text_model = job / "sparse_text"
        text_model.mkdir(exist_ok=True)
        run(["colmap", "model_converter", "--input_path", str(model), "--output_path", str(text_model), "--output_type", "TXT"])
        reg = registered_images(text_model)
        result["registered_images"] = reg
        result["registration_ratio"] = round(reg / extracted, 4)
        update(result, job, stage="sfm", progress=58, message=f"Registered {reg}/{extracted} frames ({result['registration_ratio']:.0%}).")

        if result["registration_ratio"] < args.min_registration:
            result["error"] = f"Only {reg}/{extracted} frames registered in SfM. The capture needs more overlap, slower motion, texture, or additional viewpoints."
            update(result, job, status="insufficient_registration", stage="sfm", progress=58, message=result["error"])
            return 2

        update(result, job, stage="prepare", progress=68, message="Preparing the COLMAP scene for Gaussian Splatting.")
        run(["colmap", "image_undistorter", "--image_path", str(images), "--input_path", str(model), "--output_path", str(dense), "--output_type", "COLMAP"])
        result["dense_workspace"] = str(dense)

        if args.skip_splat:
            update(result, job, status="colmap_ready", stage="prepare", progress=72, message="COLMAP reconstruction is ready; Gaussian Splatting was skipped.")
            result["duration_s"] = round(time.time() - started, 2)
            write_result(job, result)
            return 0

        gs_repo_env = os.environ.get("GS_REPO")
        if not gs_repo_env:
            result["splat_error"] = "GS_REPO is not configured; COLMAP reconstruction completed."
            update(result, job, status="colmap_ready", stage="prepare", progress=72, message="COLMAP is ready. Configure GS_REPO on the GPU worker to train the Gaussian scene.")
            result["duration_s"] = round(time.time() - started, 2)
            write_result(job, result)
            return 0

        update(result, job, stage="splat", progress=76, message=f"Training the Gaussian scene for {args.iterations:,} iterations.")
        point_cloud = train_splat(dense, job / "splat", Path(gs_repo_env), args.iterations)
        result["splat_output"] = str(point_cloud)
        result["artifact"] = str(point_cloud.relative_to(job))
        result["artifact_name"] = point_cloud.name
        result["duration_s"] = round(time.time() - started, 2)
        update(result, job, status="completed", stage="complete", progress=100, message="Reconstruction completed. The Gaussian scene is ready for the web viewer.")
        return 0
    except subprocess.CalledProcessError as exc:
        result["duration_s"] = round(time.time() - started, 2)
        result["error"] = f"Command failed with exit code {exc.returncode}"
        update(result, job, status="failed", progress=result.get("progress", 0), message=result["error"])
        return exc.returncode or 1
    except Exception as exc:
        result["duration_s"] = round(time.time() - started, 2)
        result["error"] = str(exc)
        update(result, job, status="failed", progress=result.get("progress", 0), message=str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
