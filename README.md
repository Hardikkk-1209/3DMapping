# 3DMapping

A drone-video-to-3D reconstruction platform built around a lightweight web control station and a real COLMAP + Gaussian Splatting reconstruction pipeline.

## $0 / Free GPU path

If you do not have a local NVIDIA GPU, use the included Google Colab notebook:

```text
colab/3dmapping_free_colab.ipynb
```

Open it in Google Colab, select a free GPU runtime when one is available, upload a drone video, and run the cells in order. The notebook uses FFmpeg + COLMAP for camera reconstruction and Nerfstudio/Splatfacto for Gaussian Splat training, then exports a `.ply` for the project's browser viewer.

Free Colab GPU availability and runtime limits vary, so this is intended for development/testing rather than a permanent worker. Download the generated `.ply` before the runtime ends.

## Architecture

```text
Mac / Browser
    |
    | local capture analysis
    | original video upload
    v
GPU Reconstruction
    |
    +-- FFmpeg / FFprobe
    +-- COLMAP feature extraction
    +-- COLMAP sequential matching
    +-- COLMAP SfM + registration gate
    +-- Gaussian Splatting
    |
    v
result.json + Gaussian PLY
    |
    v
Browser WebGL Gaussian Splat viewer
```

For the production-style HTTP workflow, the reconstruction worker runs on Linux/NVIDIA. The Mac is only the control station and does not need CUDA, COLMAP, FFmpeg, or Gaussian Splatting installed locally.

## Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:3000`.

The browser performs a small local capture-quality pass, then can upload the original video to a configured GPU worker. The UI polls real worker state and, when training succeeds, opens the generated Gaussian PLY in the browser viewer.

### Configure the worker

Copy `frontend/.env.example` to `frontend/.env.local` and set:

```bash
NEXT_PUBLIC_WORKER_URL=http://<GPU-HOST>:8080
```

For a worker on the same machine as the browser, use `http://localhost:8080`.

Restart `npm run dev` after changing the environment variable.

## Free Colab workflow

1. Open `colab/3dmapping_free_colab.ipynb` in Google Colab.
2. Select a free GPU runtime if available.
3. Run the setup/check cells.
4. Upload `Stockflue Flyaround.mp4` or another test video.
5. Run frame extraction, COLMAP, Splatfacto, and export cells in order.
6. Download the resulting `.ply`.
7. Load that `.ply` in the 3DMapping viewer.

The notebook starts with a conservative 3 FPS / 15,000-iteration configuration so the first test has a realistic chance of fitting within a free runtime. Once the pipeline works, increase frame rate or training iterations for quality.

## GPU worker

Run the worker on a Linux/NVIDIA machine when a persistent HTTP reconstruction service is required. Required host software:

- FFmpeg + FFprobe
- COLMAP 4.x recommended
- compatible NVIDIA driver/CUDA stack
- Python 3.10+
- GraphDeco Gaussian Splatting checkout with its upstream Python/CUDA dependencies

The GraphDeco repository is intentionally not vendored into this project because it has its own license and heavyweight CUDA dependencies.

Set:

```bash
export GS_REPO=/opt/gaussian-splatting
```

Validate the worker host:

```bash
chmod +x worker/setup-linux.sh
./worker/setup-linux.sh
```

Start the HTTP worker:

```bash
export WORKER_ROOT=/opt/3dmapping-worker
export GS_REPO=/opt/gaussian-splatting
export RECONSTRUCTION_FPS=4
export RECONSTRUCTION_MAX_FRAMES=160
export SPLAT_ITERATIONS=30000
python3 worker/server.py
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

### Worker API

```text
GET  /health
POST /jobs
GET  /jobs/{job_id}
GET  /jobs/{job_id}/artifact/{relative_path}
```

`POST /jobs` accepts a multipart upload in the `video` field. The job endpoint returns real stage/progress information. The artifact endpoint supports HTTP byte ranges for large Gaussian PLY files.

## Manual reconstruction

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

## Reconstruction pipeline

1. Decode and inspect the uploaded video.
2. Extract a bounded set of reconstruction frames.
3. Extract local visual features with COLMAP.
4. Sequentially match video frames.
5. Estimate camera poses and sparse geometry with SfM.
6. Measure the registered-image ratio.
7. Stop early with a diagnostic if registration is insufficient.
8. Undistort the registered scene.
9. Train Gaussian Splatting on the NVIDIA GPU.
10. Expose the final `point_cloud.ply` to the browser.
11. Render the scene interactively with the web Gaussian Splat viewer.

## Quality gate

The browser's capture score is only an early warning signal. The authoritative reconstruction gate is the number of video views that COLMAP can actually register into one consistent camera/scene solution.

Weak footage can still fail because of motion blur, low texture, repeated viewpoints, rolling-shutter effects, insufficient overlap, or too little viewpoint diversity. The system reports those failures rather than presenting an empty or fabricated 3D result.

## Repository layout

```text
frontend/                 Next.js control station + WebGL viewer
worker/reconstruct.py     FFmpeg + COLMAP + 3DGS orchestration
worker/server.py          upload, job status, and artifact HTTP gateway
worker/setup-linux.sh     GPU host prerequisite validation
colab/3dmapping_free_colab.ipynb
                          free Colab reconstruction path
```

No Docker is required.
