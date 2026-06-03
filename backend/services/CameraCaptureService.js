'use strict';

const logger = require('../utils/logger');
const { captureFrameFromCamera } = require('../utils/cameraFrameCapture');
const { saveCameraImage } = require('../utils/fileStorage');
const { parseCameraList } = require('../utils/cameraUrls');
const DeviceMonitorService = require('./DeviceMonitorService');

const CAPTURE_TIMEOUT_MS = parseInt(process.env.CAMERA_CAPTURE_TIMEOUT_MS || '20000', 10);

function getCamerasFromConfig(config = {}) {
  return parseCameraList(config);
}

/**
 * Capture snapshots from every configured camera for a transaction.
 * @returns {Promise<Array<{ id: string, label: string, path: string }>>}
 */
async function captureAllSnapshots(transactionId) {
  if (!transactionId) {
    throw new Error('transactionId is required for camera capture');
  }

  const config = DeviceMonitorService.getCameraConfig();
  const cameras = getCamerasFromConfig(config);
  if (!cameras.length) {
    return [];
  }

  const results = await Promise.all(
    cameras.map(async (camera) => {
      try {
        const buffer = await captureFrameFromCamera(camera, CAPTURE_TIMEOUT_MS);
        const filePath = saveCameraImage(buffer, transactionId, camera.id);
        logger.info('Camera snapshot saved', {
          camera: camera.label,
          path: filePath,
          transactionId,
        });
        return { id: camera.id, label: camera.label, path: filePath };
      } catch (err) {
        logger.warn('Camera snapshot failed', {
          camera: camera.label,
          message: err.message,
          transactionId,
        });
        return null;
      }
    }),
  );

  return results.filter(Boolean);
}

module.exports = {
  captureAllSnapshots,
  getCamerasFromConfig,
};
