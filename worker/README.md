# Reconstruction Worker

This directory is the compute-heavy half of 3DMapping. The Mac runs only the Next.js control station; video reconstruction runs on a Linux/NVIDIA host.

## End-to-end pipeline

1. Browser decodes a few local samples and reports capture quality.
2. Browser uploads the original video to this worker.
3. FFmpeg extracts reconstruction frames at a conservative configurable rate.
4. COLMAP extracts GPU-accelerated local features.
5. COLMAP sequentially matches adjacent/nearby video frames; this matching mode is intended for sequential image acquisition such as video.
6. COLMAP incremental SfM estimates camera poses and sparse geometry.
7. The worker checks the registered-frame ratio and stops early when coverage is insufficient.
8. COLMAP undistorts the registered scene into a Gaussian-Splatting-ready dataset.
9. GraphDeco Gaussian Splatting trains the scene on the NVIDIA GPU.
10. The resulting `point_cloud.ply` is exposed through a range-enabled artifact endpoint.
11. The browser loads the PLY into `@mkkellogg/gaussian-splats-3d` and provides an interactive WebGL viewer.

## System requirements

- Linux machine with a supported NVIDIA GPU/driver for the intended CUDA stack
- `ffmpeg` / `ffprobe`
- COLMAP 4.x recommended
- Python 3.10+
- GraphDeco Gaussian Splatting checkout and its CUDA/PyTorch dependencies

The GraphDeco repository is intentionally **not vendored** here because it has its own license and heavyweight CUDA dependencies.

Set the trainer location:

```bash
export GS_REPO=/opt/gaussian-splatting
```

The checkout must contain `train.py` and its normal upstream dependencies.

## Install / validate the worker

From the repository root on the GPU machine:

```bash
chmod +x worker/setup-linux.sh
./worker/setup-linux.sh
```

Then launch the HTTP gateway:

```bash
export WORKER_ROOT="$PWD"
export GS_REPO=/opt/gaussian-splatting
export RECONSTRUCTION_FPS=4
export RECONSTRUCTION_MAX_FRAMES=160
export SPLAT_ITERATIONS=30000
python3 worker/server.py
```

The worker listens on `http://0.0.0.0:8080` by default.

Health check:

```bash
curl http://127.0.0.1:8080/health
```

## Connect the Mac control station

In `frontend/.env.local`:

```bash
NEXT_PUBLIC_WORKER_URL=http://<GPU-HOST>:8080
```

Restart `npm run dev` after changing the environment variable.

The browser must be able to reach the worker directly. The worker returns CORS headers for this control-station use case.

## Manual reconstruction

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job "$PWD/jobs/manual-test"
```

COLMAP-only validation:

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job "$PWD/jobs/colmap-test" \
  --skip-splat
```

## Job state

Every job exposes `result.json` with:

- `status`: `queued`, `running`, `completed`, `colmap_ready`, `insufficient_registration`, or `failed`
- `stage`: `extract`, `features`, `matching`, `sfm`, `prepare`, `splat`, `complete`
- `progress`: coarse 0–100 pipeline progress
- input metadata from `ffprobe`
- extracted frame count
- registered-frame count and registration ratio
- sparse/dense workspace paths
- final Gaussian PLY path when training succeeds
- human-readable `message` and failure `error`

The HTTP gateway exposes:

```text
GET  /health
POST /jobs
GET  /jobs/{job_id}
GET  /jobs/{job_id}/artifact/{relative_path}
```

Artifact downloads support HTTP byte ranges so large PLY files do not need to be loaded into RAM by the gateway.

## Output layout

```text
jobs/<job-id>/
  input.mp4
  images/
  database.db
  sparse/0/
  sparse_text/
  dense/
  splat/
    point_cloud/
      iteration_30000/
        point_cloud.ply
  result.json
```

## Reconstruction quality gate

The browser's capture score is only an early warning signal. The worker's registered-image ratio is the authoritative SfM gate. If too few frames register, expensive splat training is skipped and the user gets a diagnostic instead of a fake/empty 3D model.

A short clip, low-texture scene, motion blur, repeated frames, rolling-shutter distortion, or insufficient viewpoint coverage can still fail even when the local browser score is high. No general photogrammetry system can guarantee successful reconstruction from every arbitrary drone video.
