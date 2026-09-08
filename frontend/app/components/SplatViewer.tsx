'use client';

import { useEffect, useRef, useState } from 'react';

type Props = { url: string };

type ViewerLike = {
  addSplatScene: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  update: () => void;
  render: () => void;
  dispose?: () => void;
};

type RendererLike = {
  setPixelRatio: (value: number) => void;
  setSize: (width: number, height: number, updateStyle?: boolean) => void;
  dispose: () => void;
  domElement: HTMLCanvasElement;
};

type CameraLike = { aspect: number; updateProjectionMatrix: () => void };

export default function SplatViewer({ url }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('Loading reconstructed Gaussian scene…');

  useEffect(() => {
    let disposed = false;
    let viewer: ViewerLike | null = null;
    let renderer: RendererLike | null = null;
    let camera: CameraLike | null = null;
    let frame = 0;

    async function mount() {
      if (!hostRef.current) return;
      setState('loading');
      setMessage('Loading reconstructed Gaussian scene…');

      try {
        const GaussianSplats3D = await import('@mkkellogg/gaussian-splats-3d');
        const THREE = await import('three');
        if (disposed || !hostRef.current) return;

        const width = Math.max(320, hostRef.current.clientWidth || 960);
        const height = Math.max(360, hostRef.current.clientHeight || 620);
        const webgl = new THREE.WebGLRenderer({ antialias: false, alpha: true });
        webgl.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        webgl.setSize(width, height, false);
        renderer = webgl;
        hostRef.current.appendChild(webgl.domElement);

        const threeScene = new THREE.Scene();
        const threeCamera = new THREE.PerspectiveCamera(65, width / height, 0.01, 5000);
        threeCamera.position.set(0, 0, 4);
        threeCamera.lookAt(0, 0, 0);
        camera = threeCamera;

        viewer = new GaussianSplats3D.Viewer({
          selfDrivenMode: false,
          threeScene,
          renderer: webgl,
          camera: threeCamera,
          useBuiltInControls: true,
          sharedMemoryForWorkers: false,
          gpuAcceleratedSort: false,
          integerBasedSort: false,
          sceneRevealMode: GaussianSplats3D.SceneRevealMode.Instant,
          renderMode: GaussianSplats3D.RenderMode.Always,
          logLevel: GaussianSplats3D.LogLevel.None,
          sphericalHarmonicsDegree: 0,
        }) as unknown as ViewerLike;

        setMessage('Streaming Gaussian splats into the viewer…');
        await viewer.addSplatScene(url, {
          showLoadingUI: false,
          progressiveLoad: true,
          splatAlphaRemovalThreshold: 2,
        });

        if (disposed) return;
        setState('ready');
        setMessage('3D scene ready — drag to orbit, right-drag to pan, scroll to zoom.');

        const animate = () => {
          if (disposed || !viewer) return;
          frame = requestAnimationFrame(animate);
          viewer.update();
          viewer.render();
        };
        animate();
      } catch (error) {
        if (disposed) return;
        setState('error');
        setMessage(error instanceof Error ? error.message : 'The browser could not load the Gaussian scene.');
      }
    }

    mount();

    const resize = () => {
      if (!hostRef.current || !renderer || !camera) return;
      const width = Math.max(320, hostRef.current.clientWidth);
      const height = Math.max(360, hostRef.current.clientHeight);
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', resize);
      try { viewer?.dispose?.(); } catch {}
      try { renderer?.dispose(); } catch {}
      if (renderer?.domElement.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
    };
  }, [url]);

  return (
    <div className={`splatViewer splatViewer-${state}`}>
      <div ref={hostRef} className="splatCanvas" />
      <div className="splatOverlay">
        <span className={state === 'ready' ? 'liveDot' : ''} />
        {message}
      </div>
    </div>
  );
}
