# 3DMapping

A real drone-video-to-3D reconstruction platform.

## Goal

Upload general drone footage, automatically analyze and extract useful frames, reconstruct camera poses/3D geometry with established photogrammetry software, and visualize the resulting scene in a custom web frontend.

## Architecture

- **Frontend:** Next.js / React / TypeScript
- **API:** FastAPI
- **Video processing:** FFmpeg + OpenCV
- **Photogrammetry:** COLMAP (SfM/MVS)
- **3D representation:** Gaussian Splatting integration
- **Development:** Native macOS/Linux tools; no Docker required

## Local development

### 1. Backend

From the repository root:

```bash
cd backend
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

The API will be available at `http://localhost:8000`.

### 2. Frontend

Open another terminal from the repository root:

```bash
cd frontend
npm install
npm run dev
```

The web application will be available at `http://localhost:3000`.

### 3. Run both

Keep the backend and frontend terminals running simultaneously. The frontend uses `http://localhost:8000` as the local API endpoint.

## Current milestone

The current implementation accepts drone video uploads and performs basic video metadata analysis. The next pipeline stages are frame extraction/quality analysis, COLMAP reconstruction, Gaussian Splatting, job progress tracking, and browser-based 3D model viewing.

## Important limitation

No 3D reconstruction system can guarantee a perfect model from literally every drone video. Footage needs sufficient overlap, texture, viewpoint diversity, and image quality. The application therefore performs capture-quality analysis and reports actionable problems instead of pretending a reconstruction succeeded.

Reconstruction engines are invoked as external workers rather than reimplemented from scratch.
