'use strict';

const logger = require('../utils/logger');
const { captureFrameFromCamera } = require('../utils/cameraFrameCapture');
const { parseCameraList } = require('../utils/cameraUrls');

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const PREVIEW_INTERVAL_MS = parsePositiveInt(process.env.CAMERA_PREVIEW_INTERVAL_MS, 900);
const PREVIEW_TIMEOUT_MS = parsePositiveInt(process.env.CAMERA_PREVIEW_TIMEOUT_MS, 3500);

/** @type {Map<string, { active: boolean, timer: NodeJS.Timeout | null, inFlight: boolean }>} */
const loops = new Map();
let frameCallback = null;
let started = false;
let activeCameras = [];

function getCamerasFromConfig(config = {}) {
  return parseCameraList(config);
}

function scheduleTick(camera, delayMs) {
  const state = loops.get(camera.id);
  if (!state?.active) return;

  state.timer = setTimeout(() => runTick(camera), delayMs);
  if (state.timer.unref) state.timer.unref();
}

async function runTick(camera) {
  const state = loops.get(camera.id);
  if (!state?.active || state.inFlight) {
    if (state?.active) scheduleTick(camera, PREVIEW_INTERVAL_MS);
    return;
  }

  state.inFlight = true;
  try {
    const buffer = await captureFrameFromCamera(camera, PREVIEW_TIMEOUT_MS);

    if (typeof frameCallback === 'function') {
      frameCallback(camera.id, buffer.toString('base64'));
    }
  } catch (err) {
    logger.debug('Multi-camera preview frame failed', {
      camera: camera.label,
      message: err.message,
    });
  } finally {
    state.inFlight = false;
    if (state.active) scheduleTick(camera, PREVIEW_INTERVAL_MS);
  }
}

function start(config, onFrame) {
  const cameras = getCamerasFromConfig(config);
  if (!cameras.length) {
    throw new Error('No cameras configured — set CAMERA_RTSP_URLS in .env');
  }

  if (started) {
    frameCallback = onFrame;
    return activeCameras.length ? activeCameras : cameras;
  }

  stop();
  frameCallback = onFrame;

  cameras.forEach((camera, index) => {
    loops.set(camera.id, { active: true, timer: null, inFlight: false });
    scheduleTick(camera, 300 + index * 400);
  });

  started = true;
  activeCameras = cameras;
  logger.info('Multi-camera preview started', {
    count: cameras.length,
    cameras: cameras.map((c) => c.label),
  });
  return cameras;
}

function stop() {
  for (const state of loops.values()) {
    state.active = false;
    if (state.timer) clearTimeout(state.timer);
  }
  loops.clear();
  frameCallback = null;
  started = false;
  activeCameras = [];
}

function isStarted() {
  return started;
}

module.exports = {
  start,
  stop,
  isStarted,
  getActiveCameras: () => activeCameras,
  getCamerasFromConfig,
};
