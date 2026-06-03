'use strict';

const { captureRtspFrame, captureHttpSnapshot } = require('./ffmpeg');

function getSnapshotCandidates(camera) {
  const list = [
    ...(Array.isArray(camera.httpSnapshotUrls) ? camera.httpSnapshotUrls : []),
    camera.httpSnapshotUrl,
  ]
    .map((u) => String(u || '').trim())
    .filter(Boolean);
  return [...new Set(list)];
}

/**
 * Capture a single JPEG frame from one camera (HTTP snapshot first, then RTSP).
 * @param {object} camera
 * @param {number} timeoutMs
 * @returns {Promise<Buffer>}
 */
async function captureFrameFromCamera(camera, timeoutMs = 20000) {
  const snapshotCandidates = getSnapshotCandidates(camera);

  for (const snapshotUrl of snapshotCandidates) {
    try {
      return await captureHttpSnapshot(snapshotUrl, timeoutMs);
    } catch (_e) {
      /* try next snapshot URL */
    }
  }

  return captureRtspFrame(camera.rtspUrl, {
    timeoutMs,
    exactUrlOnly: true,
    transports: ['tcp'],
  });
}

module.exports = { captureFrameFromCamera, getSnapshotCandidates };
