# Reconstruction Worker

This worker is the compute-heavy half of 3DMapping. It is intentionally independent of the Mac frontend.

## Pipeline

1. Decode the uploaded drone video with FFmpeg.
2. Extract motion-aware JPEG keyframes into `images/`.
3. Run COLMAP feature extraction.
4. Use COLMAP sequential matching for video footage.
5. Run incremental SfM and validate the registered-image count.
6. Undistort the registered model for dense/splat reconstruction.
7. Optionally run the GraphDeco 3D Gaussian Splatting trainer.
8. Emit a machine-readable `result.json` plus the trained model directory.

COLMAP is invoked through its CLI rather than through Python bindings. The worker therefore has no OpenCV dependency and can run on a dedicated Linux/NVIDIA machine.

## System dependencies

- `ffmpeg`
- `colmap` 4.x recommended
- NVIDIA CUDA driver/toolkit for GPU COLMAP and Gaussian Splatting
- Python 3.10+ for the orchestration script
- GraphDeco Gaussian Splatting checkout for the final splat stage

Set:

```bash
export GS_REPO=/opt/gaussian-splatting
```

The GraphDeco checkout must contain `train.py` and its normal Python/CUDA dependencies. The reference implementation is not vendored into this repository because it has its own license and heavyweight CUDA dependencies.

## Run

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job /tmp/3dmapping-job
```

For a COLMAP-only validation run:

```bash
python3 worker/reconstruct.py \
  --input /path/to/drone.mp4 \
  --job /tmp/3dmapping-job \
  --skip-splat
```

The worker uses a conservative default of 4 extracted frames/second, capped at 160 frames. For video, sequential matching is used because temporal adjacency is valuable; the mapper then determines which views can actually register into the scene.

## Output

```text
job/
  input.mp4
  images/
  database.db
  sparse/0/
  dense/
  splat/
  result.json
```

`result.json` contains the job status, input metadata, extracted image count, registered image count, sparse model path, dense workspace path, and splat output path when training succeeds.

## Important

A successful capture-quality score does not guarantee SfM. The worker treats the registered-image ratio as the authoritative reconstruction gate. If too few images register, it stops before expensive dense/splat training and returns a diagnostic failure instead of producing a misleading model.
