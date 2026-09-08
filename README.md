# 3DMapping

A real drone-video-to-3D reconstruction platform.

## Goal

Upload general drone footage, analyze capture quality, reconstruct camera poses and scene geometry with established photogrammetry software, train a 3D Gaussian Splat, and visualize the resulting scene in a custom web frontend.

## Architecture

```text
Mac / Browser
    |
    | video upload
    v
GPU Reconstruction Worker (Linux + NVIDIA)
    |
    +-- FFmpeg / FFprobe
    +-- COLMAP feature extraction
    +-- COLMAP sequential matching
    +-- COLMAP SfM / registration gate
    +-- image undistortion
    +-- GraphDeco Gaussian Splatting
    |
    v
PLY / SPLAT model + result.json
    |
    v
Browser 3D viewer
```

- **Frontend:** Next.js / React / TypeScript
- **GPU worker:** Python orchestration + FFmpeg + COLMAP + Gaussian Splatting
- **Photogrammetry:** COLMAP (SfM/MVS tooling)
- **3D representation:** Gaussian Splatting
- **Development:** Native macOS/Linux tools; no Docker required

The Mac is the control station. It does not need CUDA, COLMAP, or Gaussian Splatting installed for the production workflow.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

The first analysis stage runs locally in the browser and measures resolution, exposure, detail, motion, and usable sampled views.

## GPU worker

The worker requires a Linux/NVIDIA machine with:

- FFmpeg + FFprobe
- COLMAP 4.x recommended
- NVIDIA CUDA drivers/toolkit as required by the installed COLMAP/3DGS builds
- Python 3.10+
- A GraphDeco Gaussian Splatting checkout with its CUDA/Python dependencies

Set the GraphDeco checkout for the reconstruction process:

```bash
export GS_REPO=/opt/gaussian-splatting
```

### Direct reconstruction test

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job /tmp/3dmapping-job
```

COLMAP-only validation:

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job /tmp/3dmapping-job \
  --skip-splat
```

### HTTP worker gateway

Start the worker service on the GPU machine:

```bash
export WORKER_ROOT=/opt/3dmapping-worker
python3 worker/server.py
```

It exposes:

- `GET /health` — worker health
- `POST /jobs` — multipart upload using field `video`; returns a job id
- `GET /jobs/{job_id}` — reconstruction status and result metadata

Useful environment variables:

```bash
export WORKER_PORT=8080
export RECONSTRUCTION_FPS=4
export RECONSTRUCTION_MAX_FRAMES=160
export SPLAT_ITERATIONS=30000
```

The frontend can be pointed at this service with a public/reachable worker URL when the web-to-worker integration is enabled.

## Reconstruction gate

A browser capture score is only a preprocessing signal. The worker uses the **COLMAP registered-image ratio** as the authoritative SfM gate. If too few views register, expensive splat training is stopped and a diagnostic result is returned.

This prevents the application from presenting a visually plausible but invalid reconstruction result.

## Current milestone

Implemented:

1. Browser-local video decoding and capture analysis.
2. Real FFmpeg frame extraction worker.
3. Real COLMAP feature extraction, sequential matching, SfM, and registration validation.
4. GPU-worker HTTP job gateway.
5. Gaussian Splatting integration point.

Next:

- Connect the browser upload directly to the worker API.
- Stream/poll reconstruction progress into the UI.
- Serve generated `.ply/.splat` assets securely.
- Add the interactive Gaussian Splat viewer.
- Validate the complete pipeline on multiple drone captures.

## Important limitation

No 3D reconstruction system can guarantee a perfect model from literally every drone video. Successful reconstruction requires sufficient overlap, texture, viewpoint diversity, and image quality. The application therefore diagnoses weak captures instead of pretending a reconstruction succeeded.

Reconstruction engines are invoked as external workers rather than reimplemented from scratch.
