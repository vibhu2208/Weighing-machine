import React, { useEffect, useMemo, useRef, useState } from 'react';
import { deviceAPI, subscribe } from '../../api/ipc.js';
import RtspPreview from './RtspPreview.jsx';

export default function MultiRtspPreview({ cameras: camerasProp }) {
  const [cameras, setCameras] = useState(camerasProp || []);
  const startedRef = useRef(false);
  const [lastFrameAt, setLastFrameAt] = useState({});

  const cameraIds = useMemo(() => cameras.map((c) => c.id), [cameras]);

  useEffect(() => {
    if (camerasProp?.length) {
      setCameras(camerasProp);
    } else {
      deviceAPI
        .getCameraList()
        .then((list) => setCameras(list || []))
        .catch(() => {});
    }
  }, [camerasProp]);

  useEffect(() => {
    let active = true;
    if (startedRef.current) return undefined;

    const unsub = subscribe('device:cameraFrame', (payload) => {
      if (!active || !payload?.cameraId || !payload?.frame) return;
      setLastFrameAt((prev) => ({
        ...prev,
        [payload.cameraId]: Date.now(),
      }));
    });

    deviceAPI
      .startCameraPreview()
      .then(() => {
        if (active) startedRef.current = true;
      })
      .catch(() => {});

    return () => {
      active = false;
      unsub();
      if (startedRef.current) {
        deviceAPI.stopCameraPreview().catch(() => {});
        startedRef.current = false;
      }
    };
  }, []);

  useEffect(() => {
    // Ensure keys exist so tiles don't look like they "come and go"
    if (!cameraIds.length) return;
    setLastFrameAt((prev) => {
      const next = { ...prev };
      for (const id of cameraIds) {
        if (next[id] == null) next[id] = 0;
      }
      return next;
    });
  }, [cameraIds]);

  if (!cameras.length) {
    return (
      <div className="flex items-center justify-center py-8">
        <span className="text-slate-500 text-sm">No cameras configured</span>
      </div>
    );
  }

  return (
    <div
      className={`grid gap-2 ${
        cameras.length >= 3
          ? 'grid-cols-1 sm:grid-cols-3'
          : cameras.length === 2
            ? 'grid-cols-1 sm:grid-cols-2'
            : 'grid-cols-1'
      }`}
    >
      {cameras.map((cam) => (
        <div key={cam.id} className="flex min-w-0 flex-col">
          <span className="mb-1 truncate text-xs font-medium text-slate-400">
            {cam.label}
          </span>
          <div className="relative aspect-video overflow-hidden rounded-lg bg-slate-900">
            <RtspPreview
              cameraId={cam.id}
              label={cam.label}
              className="h-full w-full object-cover"
              sharedPreview
            />
            <div className="absolute left-2 top-2 rounded bg-black/50 px-2 py-0.5 text-[10px] text-slate-200">
              {(() => {
                const t = lastFrameAt[cam.id] || 0;
                if (!t) return 'WAITING';
                const age = Date.now() - t;
                if (age < 4000) return 'LIVE';
                if (age < 15000) return 'LAGGING';
                return 'NO SIGNAL';
              })()}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
