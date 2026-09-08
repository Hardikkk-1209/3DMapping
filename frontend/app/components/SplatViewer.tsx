'use client';

import { useEffect, useRef, useState } from 'react';

type Props = { url: string };

type ViewerLike = {
  addSplatScene: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  dispose?: () => void;
};

export default function SplatViewer({ url }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [message, setMessage] = useState('Loading reconstructed Gaussian scene…');

  useEffect(() => {
    let disposed = false;
    let viewer: ViewerLike | null = null;
    let renderer: { dispose?: () => void; domElement?: HTMLCanvasElement } | null = null;
    let camera: unknown = null;

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
        renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
        renderer.setSize(width, height, false);
        hostRef.current.appendChild(renderer.domElement);

        const threeScene = new THREE.Scene();
        camera = new THREE.PerspectiveCamera(65, width / height, 0.01, 5000);
        const threeCamera = camera as InstanceType<typeof THREE.PerspectiveCamera>;
        threeCamera.position.set(0, 0, 4);
        threeCamera.lookAt(0, 0, 0);

        viewer = new GaussianSplats3D.Viewer({
          selfDrivenMode: false,
          threeScene,
          renderer,
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
          if (disposed || !viewer || !renderer) return;
          requestAnimationFrame(animate);
          const v = viewer as unknown as { update: () => void; render: () => void };
          v.update();
          v.render();
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
      const c = camera as { aspect: number; updateProjectionMatrix: () => void };
      c.aspect = width / height;
      c.updateProjectionMatrix();
    };
    window.addEventListener('resize', resize);

    return () => {
      disposed = true;
      window.removeEventListener('resize', resize);
      try { viewer?.dispose?.(); } catch {}
      try { renderer?.dispose?.(); } catch {}
      if (renderer?.domElement?.parentElement) renderer.domElement.parentElement.removeChild(renderer.domElement);
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
