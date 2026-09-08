#!/usr/bin/env bash
set -euo pipefail

# This script installs the lightweight orchestration dependencies only.
# CUDA, COLMAP, FFmpeg, PyTorch and the GraphDeco repository should be
# installed according to the target GPU host image/driver stack.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

command -v ffmpeg >/dev/null || { echo "Install ffmpeg first"; exit 1; }
command -v ffprobe >/dev/null || { echo "Install ffmpeg/ffprobe first"; exit 1; }
command -v colmap >/dev/null || { echo "Install COLMAP 4.x first"; exit 1; }
python3 --version

mkdir -p "$ROOT/jobs"

echo
echo "Worker prerequisites found."
echo "Set GS_REPO=/opt/gaussian-splatting when the GraphDeco trainer is installed."
echo "Run: python3 worker/reconstruct.py --input /path/video.mp4 --job $ROOT/jobs/test --skip-splat"
