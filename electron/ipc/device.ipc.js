'use strict';

const { v4: uuidv4 } = require('uuid');
const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
const logger = require('../../backend/utils/logger');
const NAMESPACE = 'devices';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getStatus`, async () => {
    const cached = DeviceMonitorService.getLatestCachedStatus();
    if (cached) return cached;
    return DeviceMonitorService.getCurrentStatus();
  });

  ipcMain.handle(`${NAMESPACE}:simulateRFID`, async (_e, tagOverride) => {
    const { rfid } = DeviceMonitorService.getAdapters();
    if (!rfid || typeof rfid.simulateScan !== 'function') {
      throw new Error('RFID simulator not available');
    }
    rfid.simulateScan(tagOverride);
    return { ok: true };
  });

  ipcMain.handle(`${NAMESPACE}:simulateWeight`, async (_e, kg) => {
    const { weighbridge } = DeviceMonitorService.getAdapters();
    if (!weighbridge || typeof weighbridge.setSimulatedWeight !== 'function') {
      throw new Error('Weighbridge simulator not available');
    }
    weighbridge.setSimulatedWeight(Number(kg));
    return { ok: true, kg: Number(kg) };
  });

  ipcMain.handle(`${NAMESPACE}:simulateCamera`, async (_e, transactionId) => {
    const { camera } = DeviceMonitorService.getAdapters();
    if (!camera || typeof camera.captureImage !== 'function') {
      throw new Error('Camera simulator not available');
    }
    if (!camera.isConnected()) {
      if (typeof camera.connect === 'function') {
        await camera.connect();
      } else {
        throw new Error('Mock Camera is not connected');
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
}

module.exports = { register, NAMESPACE };
