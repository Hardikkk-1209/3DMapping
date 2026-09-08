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
- **Deployment:** Docker-friendly local/GPU worker architecture

## Important limitation

No 3D reconstruction system can guarantee a perfect model from literally every drone video. Footage needs sufficient overlap, texture, viewpoint diversity, and image quality. The application therefore performs capture-quality analysis and reports actionable problems instead of pretending a reconstruction succeeded.

## Development

The repository is intentionally starting clean. The first milestone establishes the project architecture and API contract; reconstruction engines are invoked as external workers rather than reimplemented from scratch.
