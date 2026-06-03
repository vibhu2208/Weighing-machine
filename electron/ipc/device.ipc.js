'use strict';

const { v4: uuidv4 } = require('uuid');
const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
const { saveTripCapture } = require('../../backend/services/TripCaptureService');
const logger = require('../../backend/utils/logger');
const NAMESPACE = 'devices';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getStatus`, async () => {
    const cached = DeviceMonitorService.getLatestCachedStatus();
    if (cached) return cached;
    return DeviceMonitorService.getCurrentStatus();
  });

  ipcMain.handle(`${NAMESPACE}:simulateRFID`, async (_e, tagOverride, options) => {
    const { rfid } = DeviceMonitorService.getAdapters();
    if (!rfid || typeof rfid.simulateScan !== 'function') {
      return {
        ok: false,
        error: 'RFID simulator requires USE_MOCK_HARDWARE=true in .env',
      };
    }
    rfid.simulateScan(tagOverride, options || {});
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:simulateMultiRFID`, async (_e, tagEntries) => {
    const { rfid } = DeviceMonitorService.getAdapters();
    if (!rfid || typeof rfid.simulateMultiScan !== 'function') {
      return {
        ok: false,
        error: 'RFID multi-scan simulator requires USE_MOCK_HARDWARE=true in .env',
      };
    }
    rfid.simulateMultiScan(tagEntries);
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:simulateWeight`, async (_e, kg) => {
    const { weighbridge } = DeviceMonitorService.getAdapters();
    if (!weighbridge || typeof weighbridge.setSimulatedWeight !== 'function') {
      return {
        ok: false,
        error: 'Weighbridge simulator requires USE_MOCK_WEIGHBRIDGE or SIMULATE_WEIGHT_KG in .env',
      };
    }
    weighbridge.setSimulatedWeight(Number(kg));
    return { ok: true, kg: Number(kg) };
  });

  ipcMain.handle(`${NAMESPACE}:simulateCamera`, async (_e, transactionId) => {
    const { camera } = DeviceMonitorService.getAdapters();
    if (!camera || typeof camera.captureImage !== 'function') {
      return {
        ok: false,
        error: 'Camera simulator requires USE_MOCK_HARDWARE=true in .env',
      };
    }
    if (camera.constructor?.name === 'RealCameraAdapter') {
      return {
        ok: false,
        error: 'Camera simulator is not available with real hardware adapters',
      };
    }
    if (!camera.isConnected()) {
      if (typeof camera.connect === 'function') {
        try {
          await camera.connect();
        } catch (err) {
          return { ok: false, error: err.message };
        }
      } else {
        return { ok: false, error: 'Mock camera is not connected' };
      }
    }
    const txnId = transactionId || `sim-${uuidv4()}`;
    const imagePath = await camera.captureImage(txnId);
    DeviceMonitorService.emitToRenderer('device:cameraCapture', {
      imagePath,
      transactionId: txnId,
    });
    return { ok: true, imagePath };
  });

  ipcMain.handle(`${NAMESPACE}:simulateDisconnect`, async (_e, deviceType) => {
    const adapters = DeviceMonitorService.getAdapters();
    const key = String(deviceType || '').toLowerCase();
    const adapter = adapters[key];
    if (!adapter) {
      throw new Error(`Unknown device type: ${deviceType}`);
    }
    if (typeof adapter.simulateDisconnect === 'function') {
      adapter.simulateDisconnect();
    } else {
      await adapter.disconnect();
    }
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:testConnection`, async (_e, deviceType) => {
    const type = String(deviceType || '').toLowerCase();
    const adapters = DeviceMonitorService.getAdapters();
    const SyncService = require('../../backend/services/SyncService');

    if (type === 'cloud') {
      const ok = await SyncService.testConnection();
      return { ok, deviceType: type };
    }

    const adapter = adapters[type];
    if (!adapter) {
      return { ok: false, error: `Unknown device: ${deviceType}` };
    }

    try {
      if (!adapter.isConnected() && typeof adapter.connect === 'function') {
        await adapter.connect();
      }
      return { ok: adapter.isConnected(), deviceType: type };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:simulateReconnect`, async (_e, deviceType) => {
    const adapters = DeviceMonitorService.getAdapters();
    const key = String(deviceType || '').toLowerCase();
    const adapter = adapters[key];
    if (!adapter) {
      throw new Error(`Unknown device type: ${deviceType}`);
    }
    if (typeof adapter.simulateReconnect === 'function') {
      await adapter.simulateReconnect();
    } else {
      await adapter.connect();
    }
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:getRfidDisplayState`, async () =>
    DeviceMonitorService.getRfidDisplayState(),
  );

  ipcMain.handle(`${NAMESPACE}:syncRfid`, async () => {
    DeviceMonitorService.syncRfidToRenderer();
    return { ok: true, ...DeviceMonitorService.getRfidDisplayState() };
  });

  ipcMain.handle(`${NAMESPACE}:startRfidScan`, async () => {
    await DeviceMonitorService.startRfidScan();
    return { ok: true, scanning: true };
  });

  ipcMain.handle(`${NAMESPACE}:stopRfidScan`, async () => {
    await DeviceMonitorService.stopRfidScan();
    return { ok: true, scanning: false };
  });

  ipcMain.handle(`${NAMESPACE}:getTestConfig`, async () =>
    DeviceMonitorService.getTestConfig(),
  );

  ipcMain.handle(`${NAMESPACE}:getCameraList`, async () => {
    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    const cameras = MultiCameraPreviewService.getCamerasFromConfig(
      DeviceMonitorService.getCameraConfig(),
    );
    return cameras.map((c) => ({ id: c.id, label: c.label }));
  });

  ipcMain.handle(`${NAMESPACE}:startCameraPreview`, async () => {
    const testConfig = DeviceMonitorService.getTestConfig();
    if (!testConfig.useRtspCamera) {
      return { ok: false, error: 'RTSP preview requires USE_WEBCAM_CAMERA=false' };
    }

    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    const cameraConfig = DeviceMonitorService.getCameraConfig();
    const cameras = MultiCameraPreviewService.getCamerasFromConfig(cameraConfig);

    if (cameras.length > 1) {
      try {
        const started =
          MultiCameraPreviewService.isStarted()
            ? MultiCameraPreviewService.getActiveCameras()
            : MultiCameraPreviewService.start(cameraConfig, (cameraId, frame) => {
                DeviceMonitorService.emitToRenderer('device:cameraFrame', { cameraId, frame });
              });
        return {
          ok: true,
          cameras: started.map((c) => ({ id: c.id, label: c.label })),
        };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }

    const { camera } = DeviceMonitorService.getAdapters();
    if (!camera || typeof camera.startPreview !== 'function') {
      return { ok: false, error: 'RTSP preview is not available for this camera mode' };
    }
    if (!camera.isConnected()) {
      try {
        await camera.connect();
      } catch (err) {
        return { ok: false, error: err.message };
      }
    }
    const primaryId = cameras[0]?.id || 'cam-primary';
    camera.startPreview((frame) => {
      DeviceMonitorService.emitToRenderer('device:cameraFrame', {
        cameraId: primaryId,
        frame,
      });
    });
    return {
      ok: true,
      cameras: cameras.length
        ? cameras.map((c) => ({ id: c.id, label: c.label }))
        : [{ id: primaryId, label: 'Camera' }],
    };
  });

  ipcMain.handle(`${NAMESPACE}:stopCameraPreview`, async () => {
    const MultiCameraPreviewService = require('../../backend/services/MultiCameraPreviewService');
    MultiCameraPreviewService.stop();
    const { camera } = DeviceMonitorService.getAdapters();
    if (camera && typeof camera.stopPreview === 'function') {
      camera.stopPreview();
    }
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:saveTestCapture`, async (_e, payload) => {
    try {
      const result = await saveTripCapture(payload || {});
      DeviceMonitorService.emitToRenderer('device:cameraCapture', {
        imagePath: result.imagePath,
        transactionId: result.transaction?.id,
      });
      return { ok: true, ...result };
    } catch (err) {
      logger.warn('saveTestCapture failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:saveTripCapture`, async (_e, payload) => {
    try {
      const result = await saveTripCapture(payload || {});

      DeviceMonitorService.emitToRenderer('device:cameraCapture', {
        imagePath: result.imagePath,
        transactionId: result.transaction?.id,
      });

      return { ok: true, ...result };
    } catch (err) {
      logger.warn('saveTripCapture failed', { message: err.message });
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle(`${NAMESPACE}:getRfidPower`, async () => {
    const SettingsService = require('../../backend/services/SettingsService');
    const { rfid } = DeviceMonitorService.getAdapters();
    const savedPower = Number(SettingsService.get('RFID_ANTENNA_POWER')) || 20;

    if (!rfid || typeof rfid.getPowerInfo !== 'function') {
      return {
        minPower: 5,
        maxPower: 30,
        currentPower: savedPower,
        connected: false,
        savedPower,
      };
    }

    try {
      const info = await rfid.getPowerInfo();
      return {
        ...info,
        savedPower,
        mock: !!info.mock,
      };
    } catch (err) {
      logger.warn('getRfidPower failed', { message: err.message });
      return {
        minPower: 5,
        maxPower: 30,
        currentPower: savedPower,
        connected: rfid.isConnected ? rfid.isConnected() : false,
        savedPower,
        error: err.message,
      };
    }
  });

  ipcMain.handle(`${NAMESPACE}:setRfidPower`, async (_e, powerDb) => {
    const SettingsService = require('../../backend/services/SettingsService');
    const power = Math.round(Number(powerDb));
    if (!Number.isFinite(power)) {
      throw new Error('Invalid RFID power value');
    }

    SettingsService.set('RFID_ANTENNA_POWER', String(power));

    const { rfid } = DeviceMonitorService.getAdapters();
    if (!rfid || typeof rfid.setAntennaPower !== 'function') {
      return { ok: true, saved: true, applied: false, power };
    }

    try {
      const result = await rfid.setAntennaPower(power);
      if (rfid.config) rfid.config.antennaPower = power;
      return result;
    } catch (err) {
      logger.warn('setRfidPower failed', { message: err.message, power });
      return { ok: false, saved: true, applied: false, power, error: err.message };
    }
  });
}

module.exports = { register, NAMESPACE };
