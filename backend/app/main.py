from pathlib import Path
from uuid import uuid4
import cv2
from fastapi import FastAPI, File, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware

ROOT = Path(__file__).resolve().parents[2]
STORAGE = Path(__import__('os').environ.get('STORAGE_ROOT', ROOT / 'storage'))
UPLOADS = STORAGE / 'uploads'
UPLOADS.mkdir(parents=True, exist_ok=True)

app = FastAPI(title='3DMapping Reconstruction API', version='0.1.0')
app.add_middleware(CORSMiddleware, allow_origins=['*'], allow_methods=['*'], allow_headers=['*'])

@app.get('/health')
def health():
    return {'status': 'ok', 'service': '3dmapping-api'}

@app.post('/api/analyze')
async def analyze_video(file: UploadFile = File(...)):
    if not file.filename or not file.filename.lower().endswith(('.mp4', '.mov', '.m4v', '.avi', '.mkv')):
        raise HTTPException(400, 'Upload a supported video: MP4, MOV, M4V, AVI or MKV')
    job_id = uuid4().hex
    path = UPLOADS / f'{job_id}_{Path(file.filename).name}'
    with path.open('wb') as out:
        while chunk := await file.read(1024 * 1024):
            out.write(chunk)
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        path.unlink(missing_ok=True)
        raise HTTPException(400, 'Could not decode the uploaded video')
    fps = cap.get(cv2.CAP_PROP_FPS) or 0
    frames = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH) or 0)
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT) or 0)
    duration = frames / fps if fps > 0 else 0
    cap.release()
    return {
        'job_id': job_id, 'filename': file.filename, 'bytes': path.stat().st_size,
        'video': {'width': width, 'height': height, 'fps': round(fps, 2), 'frames': frames, 'duration_s': round(duration, 2)},
        'status': 'uploaded',
        'next': 'frame-analysis'
    }

@app.get('/api/jobs/{job_id}')
def job_status(job_id: str):
    matches = list(UPLOADS.glob(f'{job_id}_*'))
    if not matches:
        raise HTTPException(404, 'Job not found')
    return {'job_id': job_id, 'status': 'uploaded', 'message': 'Reconstruction worker integration is the next pipeline stage.'}
