'use client';

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

const SAMPLE_COUNT = 12;

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
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error(`Video decoding timed out while waiting for ${eventName}.`));
    }, timeoutMs);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('The browser could not decode this video.')); };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener(eventName, done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener(eventName, done, { once: true });
    video.addEventListener('error', fail, { once: true });
  });
}

async function seek(video: HTMLVideoElement, time: number) {
  const target = Math.min(time, Math.max(0, video.duration - 0.05));
  if (Math.abs(video.currentTime - target) < 0.02 && video.readyState >= 2) return;

  await new Promise<void>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      cleanup();
      reject(new Error('The browser could not seek to a sampled frame. Try a standard H.264 MP4.'));
    }, 10000);
    const done = () => { cleanup(); resolve(); };
    const fail = () => { cleanup(); reject(new Error('The browser could not seek through this video.')); };
    const cleanup = () => {
      window.clearTimeout(timer);
      video.removeEventListener('seeked', done);
      video.removeEventListener('error', fail);
    };
    video.addEventListener('seeked', done, { once: true });
    video.addEventListener('error', fail, { once: true });
    video.currentTime = target;
  });
}

async function analyzeInBrowser(file: File, onProgress: (value: number) => void): Promise<Report> {
  const url = URL.createObjectURL(file);
  const video = document.createElement('video');
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  video.src = url;

  try {
    await waitForEvent(video, 'loadedmetadata');
    await waitForEvent(video, 'loadeddata');

    const width = video.videoWidth;
    const height = video.videoHeight;
    const duration = video.duration || 0;
    if (!width || !height || !Number.isFinite(duration) || duration <= 0) {
      throw new Error('Video metadata is incomplete.');
    }

    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 640 / width);
    canvas.width = Math.max(160, Math.round(width * scale));
    canvas.height = Math.max(90, Math.round(height * scale));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('Canvas analysis is unavailable in this browser.');

    const count = Math.min(SAMPLE_COUNT, Math.max(6, Math.ceil(duration * 1.5)));
    const times = Array.from({ length: count }, (_, i) => duration * (i + 0.5) / count);
    const sharpness: number[] = [];
    const brightness: number[] = [];
    const motion: number[] = [];
    let previous: Uint8ClampedArray | null = null;
    let usable = 0;

    for (let i = 0; i < times.length; i++) {
      onProgress(12 + Math.round((i / count) * 78));
      await seek(video, times[i]);
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const metrics = frameMetrics(ctx, canvas.width, canvas.height, previous);
      sharpness.push(metrics.sharpness);
      brightness.push(metrics.brightness);
      motion.push(metrics.motion);
      previous = metrics.gray;
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
      filename: file.name,
      bytes: file.size,
      status: 'browser-analyzed',
      video: { width, height, fps: 0, frames: 0, duration_s: Math.round(duration * 100) / 100 },
      sampling: { sampled_frames: count, usable_keyframes: usable, target_keyframes: Math.min(160, Math.max(24, Math.round(duration * 4))) },
      quality: {
        score,
        average_sharpness: Math.round(avgSharpness * 10) / 10,
        average_brightness: Math.round(avgBrightness * 10) / 10,
        average_motion: Math.round(avgMotion * 10) / 10,
        usable_ratio: Math.round(usableRatio * 1000) / 1000,
        warnings,
      },
    };
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute('src');
    video.load();
  }
}

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const prevent = (event: DragEvent) => event.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => { window.removeEventListener('dragover', prevent); window.removeEventListener('drop', prevent); };
  }, []);

  async function analyze() {
    if (!file || busy) return;
    setBusy(true); setError(''); setResult(null); setProgress(5);
    try {
      const data = await analyzeInBrowser(file, setProgress);
      setResult(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setBusy(false);
    }
  }

  const score = result?.quality.score ?? 0;
  const verdict = score >= 75 ? 'RECONSTRUCTION READY' : score >= 50 ? 'REVIEW CAPTURE' : 'LOW CONFIDENCE';

  return <main>
    <nav><strong>3D<span>MAPPING</span></strong><div>DRONE RECONSTRUCTION · 05</div></nav>
    <section className="hero">
      <p className="eyebrow">DRONE → 3D RECONSTRUCTION</p>
      <h1>Turn aerial footage<br/><i>into a 3D world.</i></h1>
      <p className="sub">Upload ordinary drone footage. The browser performs the first capture-quality pass locally. Reconstruction itself remains a separate GPU worker.</p>
      <div className="drop" onClick={() => inputRef.current?.click()} onDrop={e => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) setFile(f); }}>
        <input ref={inputRef} type="file" accept="video/mp4,video/quicktime,video/x-m4v,video/x-msvideo,video/x-matroska" hidden onChange={e => { setFile(e.target.files?.[0] || null); setResult(null); setError(''); }} />
        <div className="plus">+</div>
        <div>{file ? file.name : 'DROP DRONE VIDEO HERE'}</div>
        <small>MP4 · MOV · M4V · AVI · MKV</small>
      </div>
      <button disabled={!file || busy} onClick={analyze}>{busy ? `ANALYZING FOOTAGE ${progress}%…` : 'ANALYZE FOOTAGE →'}</button>
      {busy && <p className="note">Decoding sampled video frames in your browser. This can take a few seconds.</p>}
      {error && <p className="error">{error}</p>}
    </section>

    {result && <section className="result">
      <div className="reportHead">
        <div><p className="eyebrow">LOCAL CAPTURE REPORT</p><h2>{result.filename}</h2></div>
        <div className="verdict"><b>{score}</b><small>{verdict}</small></div>
      </div>
      <div className="stats">
        <div><b>{result.video.width}×{result.video.height}</b><small>RESOLUTION</small></div>
        <div><b>—</b><small>FPS · METADATA WORKER</small></div>
        <div><b>—</b><small>FRAME COUNT · METADATA WORKER</small></div>
        <div><b>{result.video.duration_s}s</b><small>DURATION</small></div>
        <div><b>{result.sampling.usable_keyframes}</b><small>USABLE SAMPLED VIEWS</small></div>
      </div>
      <div className="metrics">
        <div><span>DETAIL ENERGY</span><strong>{result.quality.average_sharpness}</strong></div>
        <div><span>SCENE MOTION</span><strong>{result.quality.average_motion}</strong></div>
        <div><span>USABLE RATIO</span><strong>{Math.round(result.quality.usable_ratio * 100)}%</strong></div>
      </div>
      <div className="pipeline"><span>01 CAPTURE ✓</span><span>02 LOCAL ANALYSIS ✓</span><span>03 COLMAP / SfM</span><span>04 GAUSSIAN SPLAT</span><span>05 3D VIEWER</span></div>
      {result.quality.warnings.length > 0 && <div className="warnings"><b>CAPTURE NOTES</b>{result.quality.warnings.map((w, i) => <p key={i}>↳ {w}</p>)}</div>}
      {result.quality.warnings.length === 0 && <p className="note">No obvious capture-quality problems were detected in the sampled views. The footage can proceed to photogrammetry.</p>}
      <p className="note">This local report is a preprocessing signal, not a guarantee of reconstruction success. Full FPS/frame metadata and final geometry will come from the reconstruction worker.</p>
    </section>}
    <footer>3DMAPPING / RESEARCH BUILD · LOCAL-FIRST ANALYSIS</footer>
  </main>;
}
