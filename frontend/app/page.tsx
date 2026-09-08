'use client';

import dynamic from 'next/dynamic';
import { useEffect, useRef, useState } from 'react';

type Report = {
  filename: string;
  bytes: number;
  status: 'browser-analyzed';
  video: { width: number; height: number; fps: number; frames: number; duration_s: number };
  sampling: { sampled_frames: number; usable_keyframes: number; target_keyframes: number };
  quality: {
    score: number;
    average_sharpness: number;
    average_brightness: number;
    average_motion: number;
    usable_ratio: number;
    warnings: string[];
  };
};

type WorkerJob = {
  job_id: string;
  filename?: string;
  status: string;
  stage?: string;
  progress?: number;
  message?: string;
  error?: string;
  artifact_url?: string;
  extracted_frames?: number;
  registered_images?: number;
  registration_ratio?: number;
  input?: { width?: number; height?: number; fps?: number; frames?: number; duration_s?: number; codec?: string };
  duration_s?: number;
};

const SplatViewer = dynamic(() => import('./components/SplatViewer'), { ssr: false });
const SAMPLE_COUNT = 12;
const WORKER_URL = (process.env.NEXT_PUBLIC_WORKER_URL || 'http://localhost:8080').replace(/\/$/, '');
const WORKER_KEY = process.env.NEXT_PUBLIC_WORKER_API_KEY || '';

function workerHeaders() {
  return WORKER_KEY ? { 'X-3DMapping-Key': WORKER_KEY } : {};
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
}

function frameMetrics(ctx: CanvasRenderingContext2D, width: number, height: number, previous: Uint8ClampedArray | null) {
  const image = ctx.getImageData(0, 0, width, height);
  const data = image.data;
  const gray = new Uint8ClampedArray(width * height);
  let brightness = 0;
  let motion = 0;

  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    const g = Math.round(data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114);
    gray[p] = g;
    brightness += g;
    if (previous) motion += Math.abs(g - previous[p]);
  }

  brightness /= gray.length;
  motion = previous ? motion / gray.length : 0;

  let edgeEnergy = 0;
  let count = 0;
  const step = Math.max(2, Math.floor(Math.min(width, height) / 180));
  for (let y = step; y < height - step; y += step) {
    for (let x = step; x < width - step; x += step) {
      const c = gray[y * width + x];
      const dx = gray[y * width + x + step] - c;
      const dy = gray[(y + step) * width + x] - c;
      edgeEnergy += dx * dx + dy * dy;
      count++;
    }
  }

  return { gray, brightness, motion, sharpness: count ? edgeEnergy / count : 0 };
}

async function waitForEvent(video: HTMLVideoElement, eventName: string, timeoutMs = 10000) {
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error(`Video decoding timed out while waiting for ${eventName}.`)); }, timeoutMs);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('The browser could not decode this video.')); };
    const cleanup = () => { window.clearTimeout(timer); video.removeEventListener(eventName, done); video.removeEventListener('error', fail); };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

async function seek(video: HTMLVideoElement, time: number) {
  const target = Math.min(time, Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - target) < 0.02 && video.readyState >= 2) return;
  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => { cleanup(); reject(new Error('The browser could not seek to a sampled frame. Try a standard H.264 MP4.')); }, 10000);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('The browser could not seek through this video.')); };
    const cleanup = () => { window.clearTimeout(timer); video.removeEventListener('seeked', done); video.removeEventListener('error', fail); };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = target;
  });
}

async function analyzeInBrowser(file: File, onProgress: (value: number) => void): Promise<Report> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto'; video.muted = true; video.playsInline = true; video.src = url;

  try {
    await waitForEvent(video, 'loadedmetadata');
    await waitForEvent(video, 'loadeddata');
    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration || 0;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) throw new Error('Video metadata is incomplete.');

    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 640 / width);
    canvas.width = Math.max(160, Math.round(width * scale));
    canvas.height = Math.max(90, Math.round(height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas analysis is unavailable in this browser.');

    const count = Math.min(SAMPLE_COUNT, Math.max(6, Math.ceil(duration * 1.5)));
    const times = Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count);
    const sharpness: number[] = [], brightness: number[] = [], motion: number[] = [];
    let previous: Uint8ClampedArray | null = null;
    let usable = 0;

    for (let i = 0; i < times.length; i++) {
      onProgress(12 + Math.round((i / count) * 78));
      await seek(video, times[i]);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const metrics = frameMetrics(ctx, canvas.width, canvas.height, previous);
      sharpness.push(metrics.sharpness); brightness.push(metrics.brightness); motion.push(metrics.motion); previous = metrics.gray;
      if (metrics.brightness > 28 && metrics.brightness < 228 && metrics.sharpness > 70) usable++;
    }

    const avgSharpness = sharpness.reduce((a, b) => a + b, 0) / sharpness.length;
    const avgBrightness = brightness.reduce((a, b) => a + b, 0) / brightness.length;
    const avgMotion = motion.slice(1).reduce((a, b) => a + b, 0) / Math.max(1, motion.length - 1);
    const usableRatio = usable / count;
    const sharpScore = clamp((avgSharpness - 35) / 220, 0, 1);
    const exposureScore = clamp(1 - Math.abs(avgBrightness - 128) / 128, 0, 1);
    const motionScore = clamp(avgMotion / 28, 0, 1);
    const coverageScore = clamp(usableRatio, 0, 1);
    const score = Math.round(100 * (sharpScore * 0.42 + exposureScore * 0.18 + motionScore * 0.18 + coverageScore * 0.22));
    const warnings: string[] = [];
    if (usableRatio < 0.5) warnings.push('Many sampled views have low detail or poor exposure.');
    if (avgSharpness < 70) warnings.push('Footage appears soft; slower camera motion and sharper frames improve reconstruction.');
    if (avgBrightness < 45) warnings.push('Capture is relatively dark.');
    if (avgBrightness > 215) warnings.push('Capture is relatively bright or overexposed.');
    if (avgMotion < 2) warnings.push('Very little scene change was detected; ensure the camera moves around the subject.');
    if (duration < 10) warnings.push('Short footage may provide limited viewpoint coverage.');

    onProgress(100);
    return {
      filename: file.name, bytes: file.size, status: 'browser-analyzed',
      video: { width, height, fps: 0, frames: 0, duration_s: Math.round(duration * 100) / 100 },
      sampling: { sampled_frames: count, usable_keyframes: usable, target_keyframes: Math.min(160, Math.max(24, Math.round(duration * 4))) },
      quality: { score, average_sharpness: Math.round(avgSharpness * 10) / 10, average_brightness: Math.round(avgBrightness * 10) / 10, average_motion: Math.round(avgMotion * 10) / 10, usable_ratio: Math.round(usableRatio * 1000) / 1000, warnings },
    };
  } finally {
    URL.revokeObjectURL(url); video.removeAttribute('src'); video.load();
  }
}

async function createWorkerJob(file: File): Promise<string> {
  const body = new FormData(); body.append('video', file, file.name);
  const response = await fetch(`${WORKER_URL}/jobs`, { method: 'POST', body, headers: workerHeaders() });
  if (!response.ok) { const detail = await response.text().catch(() => ''); throw new Error(detail || `GPU worker rejected the upload (${response.status}).`); }
  const data = await response.json() as { job_id?: string };
  if (!data.job_id) throw new Error('GPU worker did not return a job id.');
  return data.job_id;
}

async function pollWorkerJob(jobId: string, onJob: (job: WorkerJob) => void) {
  for (;;) {
    const response = await fetch(`${WORKER_URL}/jobs/${jobId}`, { cache: 'no-store', headers: workerHeaders() });
    if (!response.ok) throw new Error(`GPU worker status request failed (${response.status}).`);
    const job = await response.json() as WorkerJob;
    onJob(job);
    if (['completed', 'failed', 'insufficient_registration', 'colmap_ready'].includes(job.status)) return job;
    await new Promise(resolve => window.setTimeout(resolve, 1800));
  }
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [job, setJob] = useState<WorkerJob | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent); window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);

  async function analyzeAndReconstruct() {
    if (!file || busy) return;
    setBusy(true); setError(''); setResult(null); setJob(null); setProgress(5);
    try {
      const data = await analyzeInBrowser(file, setProgress);
      setResult(data); setProgress(100);
      const jobId = await createWorkerJob(file);
      setJob({ job_id: jobId, status: 'queued', stage: 'queued', progress: 0, message: 'Video uploaded to GPU worker.' });
      const finalJob = await pollWorkerJob(jobId, setJob);
      if (finalJob.status === 'failed') throw new Error(finalJob.error || finalJob.message || 'GPU reconstruction failed.');
      if (finalJob.status === 'insufficient_registration') throw new Error(finalJob.error || finalJob.message || 'The footage did not register well enough for reconstruction.');
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Pipeline failed');
    } finally { setBusy(false); }
  }

  const score = result?.quality.score ?? 0;
  const verdict = score >= 75 ? 'RECONSTRUCTION READY' : score >= 50 ? 'REVIEW CAPTURE' : 'LOW CONFIDENCE';
  const gpuProgress = job?.progress ?? 0;
  const completed = job?.status === 'completed' && !!job.artifact_url;
  const artifactUrl = job?.artifact_url ? `${WORKER_URL}${job.artifact_url}` : '';
  const stage = job?.stage || 'idle';

  return <main>
    <nav><strong>3D<span>MAPPING</span></strong><div>DRONE RECONSTRUCTION · 05</div></nav>
    <section className="hero">
      <p className="eyebrow">DRONE → 3D RECONSTRUCTION</p>
      <h1>Turn aerial footage<br/><i>into a 3D world.</i></h1>
      <p className="sub">Upload ordinary drone footage. The browser checks capture quality first, then sends the original video to the GPU worker for COLMAP camera recovery and Gaussian Splat training.</p>
      <div className="drop" onClick={() => inputRef.current?.click()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}>
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/x-m4v,video/x-msvideo,video/x-matroska" hidden onChange={e => { setFile(e.target.files?.[0] || null); setResult(null); setJob(null); setError(''); }} />
        <div className="plus">+</div><div>{file ? file.name : 'DROP DRONE VIDEO HERE'}</div><small>MP4 · MOV · M4V · AVI · MKV</small>
      </div>
      <button disabled={!file || busy} onClick={analyzeAndReconstruct}>{busy ? `RECONSTRUCTING ${Math.max(progress, gpuProgress)}%…` : 'ANALYZE + RECONSTRUCT →'}</button>
      {busy && <p className="note">Local capture analysis is followed by a real GPU reconstruction job. The worker status below updates as each stage finishes.</p>}
      {error && <p className="error">{error}</p>}
    </section>

    {result && <section className="result">
      <div className="reportHead"><div><p className="eyebrow">CAPTURE + RECONSTRUCTION REPORT</p><h2>{result.filename}</h2></div><div className="verdict"><b>{score}</b><small>{verdict}</small></div></div>
      <div className="stats">
        <div><b>{job?.input?.width || result.video.width}×{job?.input?.height || result.video.height}</b><small>RESOLUTION</small></div>
        <div><b>{job?.input?.fps ? `${job.input.fps}` : '—'}</b><small>FPS · GPU METADATA</small></div>
        <div><b>{job?.input?.frames || '—'}</b><small>FRAME COUNT · GPU METADATA</small></div>
        <div><b>{job?.input?.duration_s || result.video.duration_s}s</b><small>DURATION</small></div>
        <div><b>{result.sampling.usable_keyframes}</b><small>USABLE LOCAL VIEWS</small></div>
      </div>
      <div className="metrics"><div><span>DETAIL ENERGY</span><strong>{result.quality.average_sharpness}</strong></div><div><span>SCENE MOTION</span><strong>{result.quality.average_motion}</strong></div><div><span>USABLE RATIO</span><strong>{Math.round(result.quality.usable_ratio * 100)}%</strong></div></div>
      <div className="pipeline">
        <span>01 CAPTURE ✓</span><span>02 LOCAL ANALYSIS ✓</span>
        <span className={['sfm', 'matching', 'features', 'extract'].includes(stage) ? 'active' : job?.registered_images ? 'done' : ''}>03 COLMAP / SfM {job?.registered_images ? '✓' : ''}</span>
        <span className={stage === 'splat' ? 'active' : completed ? 'done' : ''}>04 GAUSSIAN SPLAT {completed ? '✓' : ''}</span><span className={completed ? 'done' : ''}>05 3D VIEWER {completed ? '✓' : ''}</span>
      </div>
      {job && <div className="workerPanel"><div className="workerTop"><div><b>GPU RECONSTRUCTION</b><span>{job.status.replaceAll('_', ' ').toUpperCase()}</span></div><strong>{gpuProgress}%</strong></div><div className="progressTrack"><div style={{ width: `${gpuProgress}%` }} /></div><p>{job.message || 'Worker is processing the reconstruction.'}</p>{job.registered_images !== undefined && job.extracted_frames !== undefined && <small>CAMERA REGISTRATION · {job.registered_images}/{job.extracted_frames} FRAMES · {Math.round((job.registration_ratio || 0) * 100)}%</small>}</div>}
      {result.quality.warnings.length > 0 && <div className="warnings"><b>CAPTURE NOTES</b>{result.quality.warnings.map((w, i) => <p key={i}>↳ {w}</p>)}</div>}
      {result.quality.warnings.length === 0 && <p className="note">No obvious capture-quality problems were detected in the sampled views. Final registration still depends on scene texture, overlap and camera motion.</p>}
      {completed && artifactUrl && <div className="viewerSection"><div className="viewerHeader"><div><p className="eyebrow">RECONSTRUCTED SCENE</p><h3>Explore the 3D world.</h3></div><span>GAUSSIAN PLY · WEBGL</span></div><SplatViewer url={artifactUrl} /></div>}
      {!completed && job?.status === 'colmap_ready' && <div className="warnings"><b>COLMAP COMPLETE</b><p>Camera poses and sparse geometry were recovered, but Gaussian Splat training is not configured on this worker yet. Set <code>GS_REPO</code> on the GPU host and run the job again.</p></div>}
      <p className="note">The capture score is a preprocessing signal, not a guarantee of geometry quality. A valid reconstruction requires enough overlapping, textured viewpoints for SfM to register the scene.</p>
    </section>}
    <footer>3DMAPPING / RESEARCH BUILD · LOCAL CONTROL STATION + NVIDIA GPU WORKER</footer>
  </main>;
}
