'use client';
import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

type Report = {
  job_id: string;
  filename: string;
  bytes: number;
  status: string;
  video: { width: number; height: number; fps: number; frames: number; duration_s: number };
  sampling: { sampled_frames: number; usable_keyframes: number; stride: number; target_keyframes: number };
  quality: { score: number; average_sharpness: number; average_brightness: number; average_motion: number; usable_ratio: number; warnings: string[] };
};

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<Report | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function analyze() {
    if (!file) return;
    setBusy(true); setError(''); setResult(null);
    const body = new FormData(); body.append('file', file);
    try {
      const r = await fetch(`${API}/api/analyze`, { method: 'POST', body });
      const data = await r.json();
      if (!r.ok) throw new Error(data.detail || 'Analysis failed');
      setResult(data);
    } catch (e: any) { setError(e.message); }
    finally { setBusy(false); }
  }

  const score = result?.quality.score ?? 0;
  const verdict = score >= 75 ? 'RECONSTRUCTION READY' : score >= 50 ? 'REVIEW CAPTURE' : 'LOW CONFIDENCE';

  return <main>
    <nav><strong>3D<span>MAPPING</span></strong><div>DRONE RECONSTRUCTION · 02</div></nav>
    <section className="hero">
      <p className="eyebrow">DRONE → 3D RECONSTRUCTION</p>
      <h1>Turn aerial footage<br/><i>into a 3D world.</i></h1>
      <p className="sub">Upload ordinary drone footage. The capture analyzer samples useful views, measures blur and motion, and prepares a clean image set for photogrammetry.</p>
      <div className="drop" onClick={() => document.getElementById('video')?.click()}>
        <input id="video" type="file" accept="video/*" hidden onChange={e => { setFile(e.target.files?.[0] || null); setResult(null); }} />
        <div className="plus">+</div>
        <div>{file ? file.name : 'DROP DRONE VIDEO HERE'}</div>
        <small>MP4 · MOV · M4V · AVI · MKV</small>
      </div>
      <button disabled={!file || busy} onClick={analyze}>{busy ? 'ANALYZING FRAMES…' : 'ANALYZE FOOTAGE →'}</button>
      {error && <p className="error">{error}</p>}
    </section>

    {result && <section className="result">
      <div className="reportHead">
        <div><p className="eyebrow">CAPTURE REPORT</p><h2>{result.filename}</h2></div>
        <div className="verdict"><b>{score}</b><small>{verdict}</small></div>
      </div>
      <div className="stats">
        <div><b>{result.video.width}×{result.video.height}</b><small>RESOLUTION</small></div>
        <div><b>{result.video.fps}</b><small>FPS</small></div>
        <div><b>{result.video.frames}</b><small>SOURCE FRAMES</small></div>
        <div><b>{result.video.duration_s}s</b><small>DURATION</small></div>
        <div><b>{result.sampling.usable_keyframes}</b><small>USABLE KEYFRAMES</small></div>
      </div>
      <div className="metrics">
        <div><span>SHARPNESS</span><strong>{result.quality.average_sharpness}</strong></div>
        <div><span>SCENE MOTION</span><strong>{result.quality.average_motion}</strong></div>
        <div><span>USABLE RATIO</span><strong>{Math.round(result.quality.usable_ratio * 100)}%</strong></div>
      </div>
      <div className="pipeline"><span>01 UPLOAD ✓</span><span>02 FRAME ANALYSIS ✓</span><span>03 COLMAP / SfM</span><span>04 GAUSSIAN SPLAT</span><span>05 3D VIEWER</span></div>
      {result.quality.warnings.length > 0 && <div className="warnings"><b>CAPTURE NOTES</b>{result.quality.warnings.map((w, i) => <p key={i}>↳ {w}</p>)}</div>}
      {result.quality.warnings.length === 0 && <p className="note">No obvious capture-quality problems detected. This image set is ready for the next photogrammetry stage.</p>}
    </section>}
    <footer>3DMAPPING / RESEARCH BUILD</footer>
  </main>;
}
