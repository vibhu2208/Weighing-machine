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
const WebcamCameraAdapter = require('../adapters/real/WebcamCameraAdapter');
const RfidTagSelector = require('./RfidTagSelector');

const HEALTH_INTERVAL_MS = 10000;
const RETRY_DELAYS_MS = [5000, 10000, 20000, 40000, 80000];
const MAX_RETRIES = 5;

let started = false;
let getMainWindow = () => null;

let rfidAdapter = null;
let rfidAdapters = [];
let weighbridgeAdapter = null;
let cameraAdapter = null;

let latestStatus = null;
let healthTimer = null;
let lastRfidSeen = null;
let rfidScanning = false;
const retryState = {
  rfid: { attempts: 0, timer: null },
  weighbridge: { attempts: 0, timer: null },
  camera: { attempts: 0, timer: null },
};

function useMockHardware() {
  const flag = (process.env.USE_MOCK_HARDWARE || 'true').toLowerCase();
  return flag !== 'false' && flag !== '0';
}

function envFlagTrue(key) {
  const flag = String(process.env[key] || '').toLowerCase();
  return flag === 'true' || flag === '1';
}

function useMockWeighbridge() {
  if (envFlagTrue('USE_MOCK_WEIGHBRIDGE')) return true;
  if (process.env.USE_MOCK_WEIGHBRIDGE === 'false' || process.env.USE_MOCK_WEIGHBRIDGE === '0') {
    return false;
  }
  if (useMockHardware()) return true;
  const simulateKg = parseFloat(process.env.SIMULATE_WEIGHT_KG);
  return Number.isFinite(simulateKg) && simulateKg > 0;
}

function useWebcamCamera() {
  return envFlagTrue('USE_WEBCAM_CAMERA');
}

function getSimulateWeightKg() {
  const n = parseFloat(process.env.SIMULATE_WEIGHT_KG);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildConfig() {
  let settings = {};
  try {
    const SettingsService = require('./SettingsService');
    settings = SettingsService.getAll();
  } catch (_e) {
    /* DB may not be ready during early init */
  }

  const pick = (key, envKey) =>
    settings[key] || process.env[envKey || key] || undefined;
  const pickPreferEnv = (key, envKey) =>
    process.env[envKey || key] || settings[key] || undefined;

  return {
    rfid: {
      ip: pick('RFID_IP'),
      ips: pick('RFID_IPS'),
      port: pick('RFID_PORT'),
      antMask: Number(pick('RFID_ANT_MASK')) || 1,
      debounceMs: Number(pick('RFID_DEBOUNCE_MS')) || 2500,
      antennaPower: Number(pick('RFID_ANTENNA_POWER')) || 20,
    },
    weighbridge: {
      comPort: pickPreferEnv('WEIGHBRIDGE_COM_PORT'),
      baudRate: pickPreferEnv('WEIGHBRIDGE_BAUD_RATE'),
      dataBits: pickPreferEnv('WEIGHBRIDGE_DATA_BITS'),
      parity: pickPreferEnv('WEIGHBRIDGE_PARITY'),
      stopBits: pickPreferEnv('WEIGHBRIDGE_STOP_BITS'),
    },
    camera: {
      rtspUrl: pick('CAMERA_RTSP_URL'),
      rtspUrlAlternates: pick('CAMERA_RTSP_URL_ALTERNATES'),
      httpSnapshotUrl: pick('CAMERA_HTTP_SNAPSHOT_URL'),
      rtspUrls: pick('CAMERA_RTSP_URLS'),
      user: pick('CAMERA_RTSP_USER'),
      password: pick('CAMERA_RTSP_PASSWORD'),
      path: pick('CAMERA_RTSP_PATH'),
      port: pick('CAMERA_RTSP_PORT'),
    },
  };
}

function parseRfidIps(rawValue) {
  if (!rawValue) return [];
  return String(rawValue)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function getActiveRfidAdapters() {
  if (Array.isArray(rfidAdapters) && rfidAdapters.length > 0) {
    return rfidAdapters;
  }
  return rfidAdapter ? [rfidAdapter] : [];
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
    ...(type === 'rfid'
      ? {
          lastError: st.lastError || null,
          reconnecting: !!st.reconnecting,
        }
      : {}),
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
  const activeRfidAdapters = getActiveRfidAdapters();
  const rfidConnectedCount = activeRfidAdapters.filter((a) => a?.isConnected?.()).length;
  return {
    rfid: deviceRow(rfidAdapter, 'rfid', {
      scanning: rfidScanning,
      readerCount: activeRfidAdapters.length,
      connectedReaders: rfidConnectedCount,
    }),
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
  if (adapter && typeof adapter === 'object') {
    adapter._lastError = message;
    adapter._reconnecting = true;
  }
  emitStatusUpdate();
  scheduleReconnect(deviceType, adapter);
}

function wireRfidAdapter(adapter, sourceLabel = null) {
  RfidTagSelector.onSelected((payload) => {
    emitEvent('device:rfidTag', { ...payload, locked: true });
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

  adapter.onTagDetected((payload) => {
    if (!rfidScanning) return;
    const enrichedPayload = {
      ...payload,
      sourceReader: sourceLabel || payload?.readerName || null,
      sourceIp: adapter?.config?.ip || null,
    };
    lastRfidSeen = enrichedPayload;
    if (!RfidTagSelector.isLocked()) {
      emitEvent('device:rfidLive', enrichedPayload);
    }
    RfidTagSelector.onRawTag(enrichedPayload);
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
    rfidAdapters = [rfidAdapter];
  } else {
    const ipCandidates = parseRfidIps(config.rfid.ips);
    if (config.rfid.ip && !ipCandidates.includes(config.rfid.ip)) {
      ipCandidates.unshift(config.rfid.ip);
    }
    const uniqueIps = [...new Set(ipCandidates)];
    const readerConfigs = uniqueIps.length > 0 ? uniqueIps : [config.rfid.ip].filter(Boolean);

    rfidAdapters = readerConfigs.map((ip, index) =>
      new RealRFIDAdapter({
        ...config.rfid,
        ip,
        readerId: `reader-${index + 1}`,
      }),
    );
    rfidAdapter = rfidAdapters[0] || null;
  }

  if (useMockWeighbridge()) {
    weighbridgeAdapter = new MockWeighbridgeAdapter(config.weighbridge);
  } else {
    weighbridgeAdapter = new RealWeighbridgeAdapter(config.weighbridge);
  }

  if (useWebcamCamera()) {
    cameraAdapter = new WebcamCameraAdapter(config.camera);
  } else if (mock) {
    cameraAdapter = new MockCameraAdapter(config.camera);
  } else {
    cameraAdapter = new RealCameraAdapter(config.camera);
  }

  getActiveRfidAdapters().forEach((adapter, index) =>
    wireRfidAdapter(adapter, `reader-${index + 1}`),
  );
  wireWeighbridgeAdapter(weighbridgeAdapter);
  wireCameraAdapter(cameraAdapter);
}

async function connectAdapter(name, adapter) {
  try {
    await adapter.connect();
    retryState[name].attempts = 0;
    if (adapter && typeof adapter === 'object') {
      adapter._reconnecting = false;
      adapter._lastError = null;
    }
    if (name === 'weighbridge' && typeof adapter.setSimulatedWeight === 'function') {
      const simulateKg = getSimulateWeightKg();
      if (simulateKg != null) {
        adapter.setSimulatedWeight(simulateKg);
        logger.info('Simulated weighbridge weight started', { kg: simulateKg });
      }
    }
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
    RfidTagSelector.unlock();
    createAdapters();

    await Promise.all([
      Promise.all(getActiveRfidAdapters().map((adapter) => connectAdapter('rfid', adapter))),
      connectAdapter('weighbridge', weighbridgeAdapter),
      connectAdapter('camera', cameraAdapter),
    ]);

    latestStatus = buildStatusSnapshot();
    startHealthCheck();
    emitStatusUpdate();
    started = true;

    syncRfidToRenderer();

    logger.info('DeviceMonitorService started', {
      mock: useMockHardware(),
      mockWeighbridge: useMockWeighbridge(),
      webcamCamera: useWebcamCamera(),
      simulateWeightKg: getSimulateWeightKg(),
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
  rfidScanning = false;
  try {
    const MultiCameraPreviewService = require('./MultiCameraPreviewService');
    MultiCameraPreviewService.stop();
  } catch (_e) {
    /* ignore */
  }
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
    Promise.all(getActiveRfidAdapters().map((adapter) => disconnect(adapter))),
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
  return {
    rfid: rfidAdapter,
    rfidAll: getActiveRfidAdapters(),
    weighbridge: weighbridgeAdapter,
    camera: cameraAdapter,
  };
}

/** @deprecated use getCurrentStatus */
function getStatus() {
  return getCurrentStatus();
}

function emitToRenderer(channel, payload) {
  emitEvent(channel, payload);
}

function syncRfidToRenderer() {
  const state = getRfidDisplayState();
  if (!state?.tag) return;
  if (!state.locked && !state.scanning) return;
  if (state.locked) {
    emitEvent('device:rfidTag', { ...state, locked: true });
  } else {
    emitEvent('device:rfidLive', state);
  }
}

function getRfidDisplayState() {
  const locked = RfidTagSelector.isLocked();
  const payload = RfidTagSelector.getLockedPayload();
  const live = !locked && rfidScanning && lastRfidSeen ? lastRfidSeen : null;
  const source = payload || live;
  return {
    locked,
    scanning: rfidScanning,
    tag: source?.tag || (locked ? RfidTagSelector.getLockedTag() : null),
    tid: source?.tid ?? null,
    rssi: source?.rssi ?? null,
    antenna: source?.antenna ?? null,
    readerName: source?.readerName ?? null,
    timestamp: source?.timestamp || ts.now(),
  };
}

async function startRfidScan() {
  RfidTagSelector.unlock();
  lastRfidSeen = null;
  const adapters = getActiveRfidAdapters();
  await Promise.all(
    adapters.map((adapter) =>
      adapter?.startScanning ? adapter.startScanning() : Promise.resolve(),
    ),
  );
  rfidScanning = true;
  emitEvent('device:rfidScanState', { scanning: true });
  emitStatusUpdate();
}

async function stopRfidScan() {
  rfidScanning = false;
  const adapters = getActiveRfidAdapters();
  await Promise.all(
    adapters.map((adapter) =>
      adapter?.stopScanning ? adapter.stopScanning() : Promise.resolve(),
    ),
  );
  lastRfidSeen = null;
  emitEvent('device:rfidScanState', { scanning: false });
  emitStatusUpdate();
}
function useRtspCamera() {
  return !useWebcamCamera() && !useMockHardware();
}

function getCameraConfig() {
  return buildConfig().camera;
}

function getTestConfig() {
  const MultiCameraPreviewService = require('./MultiCameraPreviewService');
  const cameras = MultiCameraPreviewService.getCamerasFromConfig(getCameraConfig());
  return {
    useWebcamCamera: useWebcamCamera(),
    useRtspCamera: useRtspCamera(),
    mockWeighbridge: useMockWeighbridge(),
    simulateWeightKg: getSimulateWeightKg(),
    cameras: cameras.map((c) => ({ id: c.id, label: c.label })),
  };
}

module.exports = {
  start,
  stop,
  getCurrentStatus,
  getStatus,
  getAdapters,
  getLatestCachedStatus: () => latestStatus,
  emitToRenderer,
  getTestConfig,
  getCameraConfig,
  getRfidDisplayState,
  syncRfidToRenderer,
  startRfidScan,
  stopRfidScan,
};
