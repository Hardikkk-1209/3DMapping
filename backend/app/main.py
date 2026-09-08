from pathlib import Path
from uuid import uuid4
import json
import math
import os

import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parents[2]
STORAGE = Path(os.environ.get("STORAGE_ROOT", ROOT / "storage"))
UPLOADS = STORAGE / "uploads"
JOBS = STORAGE / "jobs"
UPLOADS.mkdir(parents=True, exist_ok=True)
JOBS.mkdir(parents=True, exist_ok=True)

ALLOWED = (".mp4", ".mov", ".m4v", ".avi", ".mkv")

app = FastAPI(title="3DMapping Reconstruction API", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


def sharpness(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(cv2.Laplacian(gray, cv2.CV_64F).var())


def brightness(frame):
    gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(gray.mean())


def histogram_distance(a, b):
    ah = cv2.calcHist([a], [0], None, [32], [0, 256])
    bh = cv2.calcHist([b], [0], None, [32], [0, 256])
    cv2.normalize(ah, ah)
    cv2.normalize(bh, bh)
    return float(cv2.compareHist(ah, bh, cv2.HISTCMP_BHATTACHARYYA))


def analyze_capture(video_path: Path, job_dir: Path):
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise ValueError("Could not decode the uploaded video")

    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = frames / fps if fps > 0 else 0

    # Keep enough temporal coverage for SfM without feeding thousands of near-duplicates.
    target = max(24, min(180, int(duration * 4)))
    stride = max(1, math.ceil(frames / target))
    frame_dir = job_dir / "frames"
    frame_dir.mkdir(parents=True, exist_ok=True)

    samples = []
    previous = None
    frame_index = 0
    selected = 0
    blur_values = []
    brightness_values = []
    motion_values = []

    while True:
        ok, frame = cap.read()
        if not ok:
            break
        if frame_index % stride != 0:
            frame_index += 1
            continue

        sharp = sharpness(frame)
        bright = brightness(frame)
        motion = histogram_distance(previous, frame) if previous is not None else 0.0
        previous = frame
        blur_values.append(sharp)
        brightness_values.append(bright)
        motion_values.append(motion)

        # Reject only obviously unusable frames. Selection remains conservative so
        # reconstruction gets broad coverage instead of just the sharpest moments.
        if sharp >= 35 and 12 <= bright <= 245:
            filename = f"frame_{frame_index:06d}.jpg"
            out = frame_dir / filename
            cv2.imwrite(str(out), frame, [cv2.IMWRITE_JPEG_QUALITY, 92])
            samples.append({
                "frame": frame_index,
                "time_s": round(frame_index / fps, 3) if fps else 0,
                "sharpness": round(sharp, 2),
                "brightness": round(bright, 2),
                "motion": round(motion, 4),
                "path": str(out.relative_to(job_dir)),
            })
            selected += 1
        frame_index += 1

    cap.release()

    avg_sharp = sum(blur_values) / len(blur_values) if blur_values else 0
    avg_motion = sum(motion_values) / len(motion_values) if motion_values else 0
    usable_ratio = selected / max(1, len(blur_values))

    # This is a capture-quality estimate, not a claim that reconstruction will succeed.
    score = 0
    if duration >= 8:
        score += 20
    if duration >= 15:
        score += 10
    if width * height >= 1280 * 720:
        score += 15
    if avg_sharp >= 80:
        score += 20
    elif avg_sharp >= 45:
        score += 12
    if usable_ratio >= 0.75:
        score += 15
    elif usable_ratio >= 0.45:
        score += 8
    if avg_motion >= 0.015:
        score += 20
    elif avg_motion >= 0.006:
        score += 12
    score = min(100, score)

    warnings = []
    if duration < 8:
        warnings.append("Very short capture; there may not be enough viewpoints for a complete model.")
    if avg_sharp < 45:
        warnings.append("Low average frame sharpness; motion blur may reduce feature matching.")
    if avg_motion < 0.006:
        warnings.append("Low measured scene change; the footage may contain too many redundant views.")
    if selected < 20:
        warnings.append("Fewer than 20 usable keyframes were found; reconstruction confidence is low.")
    if width < 960 or height < 540:
        warnings.append("Low source resolution may limit geometric and texture detail.")

    report = {
        "video": {
            "width": width,
            "height": height,
            "fps": round(fps, 2),
            "frames": frames,
            "duration_s": round(duration, 2),
        },
        "sampling": {
            "sampled_frames": len(blur_values),
            "usable_keyframes": selected,
            "stride": stride,
            "target_keyframes": target,
        },
        "quality": {
            "score": score,
            "average_sharpness": round(avg_sharp, 2),
            "average_brightness": round(sum(brightness_values) / len(brightness_values), 2) if brightness_values else 0,
            "average_motion": round(avg_motion, 4),
            "usable_ratio": round(usable_ratio, 3),
            "warnings": warnings,
        },
        "keyframes": samples,
    }
    (job_dir / "capture_report.json").write_text(json.dumps(report, indent=2))
    return report


@app.get("/health")
def health():
    return {"status": "ok", "service": "3dmapping-api", "version": "0.2.0"}


@app.post("/api/analyze")
async def analyze_video(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(ALLOWED):
        raise HTTPException(400, "Upload a supported video: MP4, MOV, M4V, AVI or MKV")

    job_id = uuid4().hex
    job_dir = JOBS / job_id
    job_dir.mkdir(parents=True, exist_ok=True)
    path = UPLOADS / f"{job_id}_{Path(file.filename).name}"

    try:
        with path.open("wb") as out:
            while chunk := await file.read(1024 * 1024):
                out.write(chunk)
        report = analyze_capture(path, job_dir)
    except ValueError as exc:
        path.unlink(missing_ok=True)
        job_dir.rmdir()
        raise HTTPException(400, str(exc)) from exc
    except Exception as exc:
        path.unlink(missing_ok=True)
        raise HTTPException(500, f"Capture analysis failed: {exc}") from exc

    return {
        "job_id": job_id,
        "filename": file.filename,
        "bytes": path.stat().st_size,
        "status": "analyzed",
        "next": "reconstruction",
        **report,
    }


@app.get("/api/jobs/{job_id}")
def job_status(job_id: str):
    report_path = JOBS / job_id / "capture_report.json"
    if not report_path.exists():
        raise HTTPException(404, "Job not found")
    report = json.loads(report_path.read_text())
    return {"job_id": job_id, "status": "analyzed", "next": "reconstruction", **report}
