'use client';
import { useState } from 'react';

const API = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:8000';

export default function Home() {
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<any>(null);
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

  return <main>
    <nav><strong>3D<span>MAPPING</span></strong><div>DRONE RECONSTRUCTION · 01</div></nav>
    <section className="hero">
      <p className="eyebrow">DRONE → 3D RECONSTRUCTION</p>
      <h1>Turn aerial footage<br/><i>into a 3D world.</i></h1>
      <p className="sub">Upload ordinary drone footage. Our pipeline analyzes the capture, recovers camera motion with photogrammetry, and prepares a navigable 3D reconstruction.</p>
      <div className="drop" onClick={() => document.getElementById('video')?.click()}>
        <input id="video" type="file" accept="video/*" hidden onChange={e => setFile(e.target.files?.[0] || null)} />
        <div className="plus">+</div>
        <div>{file ? file.name : 'DROP DRONE VIDEO HERE'}</div>
        <small>MP4 · MOV · M4V · AVI · MKV</small>
      </div>
      <button disabled={!file || busy} onClick={analyze}>{busy ? 'ANALYZING…' : 'ANALYZE FOOTAGE →'}</button>
      {error && <p className="error">{error}</p>}
    </section>
    {result && <section className="result">
      <div><p className="eyebrow">CAPTURE REPORT</p><h2>{result.filename}</h2></div>
      <div className="stats"><div><b>{result.video.width}×{result.video.height}</b><small>RESOLUTION</small></div><div><b>{result.video.fps}</b><small>FPS</small></div><div><b>{result.video.frames}</b><small>FRAMES</small></div><div><b>{result.video.duration_s}s</b><small>DURATION</small></div></div>
      <div className="pipeline"><span>01 UPLOAD ✓</span><span>02 FRAME ANALYSIS</span><span>03 COLMAP / SfM</span><span>04 GAUSSIAN SPLAT</span><span>05 3D VIEWER</span></div>
      <p className="note">Video ingestion is live. The reconstruction worker is deliberately separated from the web app so COLMAP and GPU Gaussian Splatting can run locally or on a GPU worker.</p>
    </section>}
    <footer>3DMAPPING / RESEARCH BUILD</footer>
  </main>;
}
