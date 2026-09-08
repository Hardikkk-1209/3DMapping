#!/usr/bin/env bash
set -euo pipefail

# Run this on the Linux/NVIDIA machine that will perform reconstruction.
# This script intentionally does not install CUDA or a specific COLMAP build;
# those must match the host GPU driver/toolchain.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

check() {
  command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1"; exit 1; }
  echo "found: $1 -> $(command -v "$1")"
}

check ffmpeg
check ffprobe
check colmap
check python3

python3 - <<'PY'
import sys
print('python:', sys.version.split()[0])
PY

if command -v nvidia-smi >/dev/null 2>&1; then
  nvidia-smi --query-gpu=name,driver_version,memory.total --format=csv,noheader
else
  echo "WARNING: nvidia-smi was not found. GPU Gaussian Splatting will not be available on this host."
fi

mkdir -p "$ROOT/jobs"

if [[ -z "${GS_REPO:-}" ]]; then
  echo
  echo "GS_REPO is not set. COLMAP-only jobs can still run."
  echo "For Gaussian Splatting, install the GraphDeco repository and export:"
  echo "  export GS_REPO=/opt/gaussian-splatting"
else
  test -f "$GS_REPO/train.py" || { echo "GS_REPO does not contain train.py: $GS_REPO"; exit 1; }
  echo "found GraphDeco trainer: $GS_REPO/train.py"
fi

echo
echo "Worker prerequisites validated."
echo "Start API:"
echo "  WORKER_ROOT=$ROOT python3 worker/server.py"
echo
echo "Then point the Next.js control station at this host:"
echo "  NEXT_PUBLIC_WORKER_URL=http://<worker-host>:8080"
