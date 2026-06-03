import React, { useEffect, useRef, useState } from 'react';
import { deviceAPI, subscribe } from '../../api/ipc.js';

const frameCache = new Map();

export default function RtspPreview({
  className,
  cameraId,
  label,
  onReady,
  onError,
  /** When true, parent MultiRtspPreview already called startCameraPreview */
  sharedPreview = false,
}) {
  const cacheKey = cameraId || 'default';
  const [frameSrc, setFrameSrc] = useState(() => frameCache.get(cacheKey) || null);
  const [error, setError] = useState(null);
  const gotFrameRef = useRef(false);

  useEffect(() => {
    let active = true;

    const unsub = subscribe('device:cameraFrame', (payload) => {
      if (!active || !payload?.frame) return;
      if (cameraId && payload.cameraId !== cameraId) return;
      gotFrameRef.current = true;
      const nextFrame = `data:image/jpeg;base64,${payload.frame}`;
      frameCache.set(cacheKey, nextFrame);
      setFrameSrc(nextFrame);
      setError(null);
      onReady?.();
    });

    if (!sharedPreview) {
      deviceAPI
        .startCameraPreview()
        .then((result) => {
          if (!active) return;
          if (!result?.ok) {
            const message = result?.error || 'Could not start camera preview';
            setError(message);
            onError?.(message);
          }
        })
        .catch((err) => {
          if (!active) return;
          const message =
            err?.message ||
            'Could not start camera preview — check CAMERA_RTSP_URLS in .env';
          setError(message);
          onError?.(message);
        });
    }

    const frameTimeout = setTimeout(() => {
      if (!active || gotFrameRef.current) return;
      setError('No signal — check camera network and RTSP URL');
    }, 35000);

    return () => {
      active = false;
      clearTimeout(frameTimeout);
      unsub();
      if (!sharedPreview) {
        deviceAPI.stopCameraPreview().catch(() => {});
      }
    };
  }, [cacheKey, cameraId, onError, onReady, sharedPreview]);

  if (error) {
    return (
      <div
        className={`flex items-center justify-center p-2 text-center ${className || ''}`}
      >
        <p className="text-red-300 text-xs">{error}</p>
      </div>
    );
  }

  if (!frameSrc) {
    return (
      <div className={`flex items-center justify-center ${className || ''}`}>
        <span className="text-slate-500 text-xs">Connecting…</span>
      </div>
    );
  }

  return (
    <img src={frameSrc} alt={label || cameraId || 'Live camera'} className={className} />
  );
}
