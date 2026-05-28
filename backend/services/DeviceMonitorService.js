'use strict';

const logger = require('../utils/logger');
const ts = require('../utils/timestamp');
const { getDb } = require('../database/db');
const MockRFIDAdapter = require('../adapters/mock/MockRFIDAdapter');
const MockWeighbridgeAdapter = require('../adapters/mock/MockWeighbridgeAdapter');
const MockCameraAdapter = require('../adapters/mock/MockCameraAdapter');
const RealRFIDAdapter = require('../adapters/real/RealRFIDAdapter');
const RealWeighbridgeAdapter = require('../adapters/real/RealWeighbridgeAdapter');
const RealCameraAdapter = require('../adapters/real/RealCameraAdapter');

const HEALTH_INTERVAL_MS = 10000;
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 80000];
const MAX_RETRIES = 5;

let started = false;
let getMainWindow = () => null;

let rfidAdapter = null;
let weighbridgeAdapter = null;
let cameraAdapter = null;

let latestStatus = null;
let healthTimer = null;
const retryState = {
  rfid: { attempts: 0, timer: null },
  weighbridge: { attempts: 0, timer: null },
  camera: { attempts: 0, timer: null },
};

function useMockHardware() {
  const flag = (process.env.USE_MOCK_HARDWARE || 'true').toLowerCase();
  return flag !== 'false' && flag !== '0';
}

function buildConfig() {
  return {
    rfid: {
      ip: process.env.RFID_IP,
      port: process.env.RFID_PORT,
    },
    weighbridge: {
      comPort: process.env.WEIGHBRIDGE_COM_PORT,
      baudRate: process.env.WEIGHBRIDGE_BAUD_RATE,
    },
    camera: {
      rtspUrl: process.env.CAMERA_RTSP_URL,
    },
  };
}

function countOpenTransactions() {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE status IN ('pending', 'weighing')`,
      )
      .get();
    return row ? row.count : 0;
  } catch (_e) {
    return 0;
  }
}

function countPendingSync() {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE sync_status IN ('pending', 'retry')`,
      )
      .get();
    return row ? row.count : 0;
  } catch (_e) {
    return 0;
  }
}

function deviceRow(adapter, type, extra = {}) {
  if (!adapter) {
    return {
      type,
      connected: false,
      mode: 'unknown',
      lastSeen: null,
      ...extra,
    };
  }
  const st = adapter.getStatus();
  return {
    type: st.type || type,
    connected: !!st.connected,
    mode: st.mode || adapter.constructor.name,
    lastSeen: ts.now(),
    ...extra,
    ...(type === 'weighbridge'
      ? {
          currentWeight: st.currentWeight ?? 0,
          isStable: !!st.isStable,
        }
      : {}),
  };
}

function buildStatusSnapshot() {
  const cloudConnected = true;
  return {
    rfid: deviceRow(rfidAdapter, 'rfid'),
    weighbridge: deviceRow(weighbridgeAdapter, 'weighbridge', {
      currentWeight: weighbridgeAdapter?.currentWeight ?? 0,
      isStable: weighbridgeAdapter?.isStable ?? false,
    }),
    camera: deviceRow(cameraAdapter, 'camera'),
    cloud: {
      connected: cloudConnected,
      lastSync: null,
      pendingCount: countPendingSync(),
    },
  };
}

function emitStatusUpdate() {
  latestStatus = buildStatusSnapshot();
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('device:statusUpdate', latestStatus);
  }
}

function emitEvent(channel, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

function logDeviceError(deviceType, message, metadata = {}) {
  logger.logDevice(deviceType, 'error', message, metadata);
}

function clearRetryTimer(deviceType) {
  const state = retryState[deviceType];
  if (state && state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function scheduleReconnect(deviceType, adapter) {
  const state = retryState[deviceType];
  if (!adapter || state.attempts >= MAX_RETRIES) {
    if (state.attempts >= MAX_RETRIES) {
      const msg = `${deviceType} exceeded max reconnect attempts (${MAX_RETRIES})`;
      logger.error(msg);
      logDeviceError(deviceType, msg, { critical: true });
      emitEvent('device:criticalError', { deviceType, message: msg });
    }
    return;
  }

  const delay = RETRY_DELAYS_MS[state.attempts] || 80000;
  state.attempts += 1;

  logger.info(`Scheduling ${deviceType} reconnect`, {
    attempt: state.attempts,
    delayMs: delay,
  });

  clearRetryTimer(deviceType);
  state.timer = setTimeout(async () => {
    state.timer = null;
    try {
      if (typeof adapter.simulateReconnect === 'function') {
        await adapter.simulateReconnect();
      } else {
        await adapter.connect();
      }
      state.attempts = 0;
      logger.logDevice(deviceType, 'reconnect', `${deviceType} reconnected`);
      emitStatusUpdate();
    } catch (err) {
      logDeviceError(deviceType, `Reconnect failed: ${err.message}`);
      scheduleReconnect(deviceType, adapter);
    }
  }, delay);
  if (state.timer.unref) state.timer.unref();
}

function handleAdapterError(deviceType, adapter, err) {
  const message = err && err.message ? err.message : String(err);
  logDeviceError(deviceType, message);
  adapter.connected = false;
  emitStatusUpdate();
  scheduleReconnect(deviceType, adapter);
}

function wireRfidAdapter(adapter) {
  adapter.onTagDetected((payload) => {
    emitEvent('device:rfidTag', payload);
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      if (WorkflowEngine && typeof WorkflowEngine.handleRfidTag === 'function') {
        WorkflowEngine.handleRfidTag(payload);
      }
    } catch (err) {
      logger.warn('WorkflowEngine RFID handler error', { message: err.message });
    }
  });

  adapter.onError((err) => handleAdapterError('rfid', adapter, err));
  adapter.onReconnect(() => {
    retryState.rfid.attempts = 0;
    emitStatusUpdate();
  });
}

function wireWeighbridgeAdapter(adapter) {
  adapter.onWeightUpdate((payload) => {
    emitEvent('device:weightUpdate', payload);
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onWeightUpdate(payload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onStableWeight((payload) => {
    emitEvent('device:stableWeight', payload);
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onStableWeight(payload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onWeightZero((payload) => {
    emitEvent('device:weightZero', payload);
    emitStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onWeightZero(payload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onError((err) => handleAdapterError('weighbridge', adapter, err));
  adapter.onReconnect(() => {
    retryState.weighbridge.attempts = 0;
    emitStatusUpdate();
  });
}

function wireCameraAdapter(adapter) {
  adapter.onError((err) => handleAdapterError('camera', adapter, err));
  if (typeof adapter.onReconnect === 'function') {
    adapter.onReconnect(() => {
      retryState.camera.attempts = 0;
      emitStatusUpdate();
    });
  }
}

function createAdapters() {
  const config = buildConfig();
  const mock = useMockHardware();

  if (mock) {
    rfidAdapter = new MockRFIDAdapter(config.rfid);
    weighbridgeAdapter = new MockWeighbridgeAdapter(config.weighbridge);
    cameraAdapter = new MockCameraAdapter(config.camera);
  } else {
    rfidAdapter = new RealRFIDAdapter(config.rfid);
    weighbridgeAdapter = new RealWeighbridgeAdapter(config.weighbridge);
    cameraAdapter = new RealCameraAdapter(config.camera);
  }

  wireRfidAdapter(rfidAdapter);
  wireWeighbridgeAdapter(weighbridgeAdapter);
  wireCameraAdapter(cameraAdapter);
}

async function connectAdapter(name, adapter) {
  try {
    await adapter.connect();
    retryState[name].attempts = 0;
    logger.logDevice(name, 'connect', `${name} connected`, {
      mode: adapter.constructor.name,
    });
  } catch (err) {
    handleAdapterError(name, adapter, err);
  }
}

function startHealthCheck() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(() => {
    emitStatusUpdate();
  }, HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();
}

async function start(windowGetter) {
  if (started) return;
  getMainWindow = windowGetter || (() => null);

  try {
    createAdapters();

    await Promise.all([
      connectAdapter('rfid', rfidAdapter),
      connectAdapter('weighbridge', weighbridgeAdapter),
      connectAdapter('camera', cameraAdapter),
    ]);

    latestStatus = buildStatusSnapshot();
    startHealthCheck();
    emitStatusUpdate();
    started = true;

    logger.info('DeviceMonitorService started', {
      mock: useMockHardware(),
      rfid: rfidAdapter?.constructor?.name,
      weighbridge: weighbridgeAdapter?.constructor?.name,
      camera: cameraAdapter?.constructor?.name,
    });
  } catch (err) {
    started = false;
    logger.error('DeviceMonitorService failed to start', {
      message: err.message,
      stack: err.stack,
    });
    throw err;
  }
}

function stop() {
  started = false;
  if (healthTimer) {
    clearInterval(healthTimer);
    healthTimer = null;
  }
  ['rfid', 'weighbridge', 'camera'].forEach((d) => clearRetryTimer(d));

  const disconnect = async (adapter) => {
    if (adapter && adapter.isConnected()) {
      try {
        await adapter.disconnect();
      } catch (_e) {
        /* ignore */
      }
    }
  };

  return Promise.all([
    disconnect(rfidAdapter),
    disconnect(weighbridgeAdapter),
    disconnect(cameraAdapter),
  ]);
}

function getCurrentStatus() {
  if (latestStatus) return latestStatus;
  latestStatus = buildStatusSnapshot();
  return latestStatus;
}

function getAdapters() {
  return { rfid: rfidAdapter, weighbridge: weighbridgeAdapter, camera: cameraAdapter };
}

/** @deprecated use getCurrentStatus */
function getStatus() {
  return getCurrentStatus();
}

function emitToRenderer(channel, payload) {
  emitEvent(channel, payload);
}

module.exports = {
  start,
  stop,
  getCurrentStatus,
  getStatus,
  getAdapters,
  getLatestCachedStatus: () => latestStatus,
  emitToRenderer,
};
