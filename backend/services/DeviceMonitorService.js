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

function parsePositiveInt(value, fallback) {
  const n = parseInt(String(value || ''), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const HEALTH_INTERVAL_MS = parsePositiveInt(process.env.DEVICE_STATUS_INTERVAL_MS, 2000);
const STATUS_FULL_INTERVAL_MS = parsePositiveInt(process.env.DEVICE_STATUS_FULL_INTERVAL_MS, 10000);
const STATUS_COUNT_CACHE_MS = 5000;
const CAMERA_FRAME_MIN_MS = 500;
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
let statusFullTimer = null;
let lastRfidSeen = null;
let cachedOpenTxnCount = { value: 0, at: 0 };
let cachedPendingSyncCount = { value: 0, at: 0 };
const lastCameraFrameAt = new Map();
let rfidScanning = false;
let latestRawWeight = 0;
let cloudReachable = false;
let cloudStatusCheckedAt = 0;
const CLOUD_STATUS_TTL_MS = 30000;

const retryState = {
  rfid: { attempts: 0, timer: null },
  weighbridge: { attempts: 0, timer: null },
  camera: { attempts: 0, timer: null },
};

function readSettingValue(key) {
  try {
    const SettingsService = require('./SettingsService');
    const value = SettingsService.get(key);
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      return String(value);
    }
  } catch (_e) {
    /* DB may not be ready during early init */
  }
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return String(process.env[key]);
  }
  return '';
}

function settingFlagTrue(key, defaultValue = false) {
  const raw = readSettingValue(key);
  if (!raw) return defaultValue;
  const flag = raw.toLowerCase();
  return flag === 'true' || flag === '1';
}

function settingFlagFalse(key) {
  const raw = readSettingValue(key);
  if (!raw) return false;
  const flag = raw.toLowerCase();
  return flag === 'false' || flag === '0';
}

function useMockHardware() {
  return settingFlagTrue('USE_MOCK_HARDWARE', false);
}

function useMockWeighbridge() {
  if (settingFlagTrue('USE_MOCK_WEIGHBRIDGE', false)) return true;
  if (settingFlagFalse('USE_MOCK_WEIGHBRIDGE')) return false;
  if (useMockHardware()) return true;
  const simulateKg = parseFloat(readSettingValue('SIMULATE_WEIGHT_KG'));
  return Number.isFinite(simulateKg) && simulateKg > 0;
}

function useWebcamCamera() {
  return settingFlagTrue('USE_WEBCAM_CAMERA', false);
}

function getSimulateWeightKg() {
  const n = parseFloat(readSettingValue('SIMULATE_WEIGHT_KG'));
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

function readCachedCount(cache, sql) {
  const now = Date.now();
  if (now - cache.at < STATUS_COUNT_CACHE_MS) return cache.value;
  try {
    const row = getDb().prepare(sql).get();
    cache.value = row ? row.count : 0;
    cache.at = now;
    return cache.value;
  } catch (_e) {
    return cache.value;
  }
}

function countOpenTransactions() {
  return readCachedCount(
    cachedOpenTxnCount,
    `SELECT COUNT(*) AS count FROM transactions
     WHERE status IN ('pending', 'weighing')`,
  );
}

function countPendingSync() {
  return readCachedCount(
    cachedPendingSyncCount,
    `SELECT COUNT(*) AS count FROM transactions
     WHERE sync_status IN ('pending', 'retry')`,
  );
}

function invalidateStatusCountCache() {
  cachedOpenTxnCount.at = 0;
  cachedPendingSyncCount.at = 0;
}

function patchWeighbridgeInCache(payload) {
  if (!latestStatus) latestStatus = buildStatusSnapshot();
  if (!latestStatus.weighbridge) return;
  latestStatus.weighbridge.currentWeight = payload?.weight ?? 0;
  latestStatus.weighbridge.isStable = !!payload?.isStable;
  latestStatus.weighbridge.lastSeen = ts.now();
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

function getCloudConnected() {
  try {
    const SyncService = require('./SyncService');
    if (!SyncService.isCloudConfigured()) return false;
    return cloudReachable;
  } catch (_e) {
    return false;
  }
}

async function refreshCloudStatus(force = false) {
  const now = Date.now();
  if (!force && now - cloudStatusCheckedAt < CLOUD_STATUS_TTL_MS) {
    return cloudReachable;
  }

  cloudStatusCheckedAt = now;
  try {
    const SyncService = require('./SyncService');
    if (!SyncService.isCloudConfigured()) {
      cloudReachable = false;
      return false;
    }
    cloudReachable = await SyncService.testConnection();
    return cloudReachable;
  } catch (_e) {
    cloudReachable = false;
    return false;
  }
}

function buildStatusSnapshot(options = {}) {
  const { includeQueueCounts = true } = options;
  const cloudConnected = getCloudConnected();
  const activeRfidAdapters = getActiveRfidAdapters();
  const rfidConnectedCount = activeRfidAdapters.filter((a) => a?.isConnected?.()).length;
  const pendingCount = includeQueueCounts
    ? countPendingSync()
    : latestStatus?.cloud?.pendingCount ?? 0;

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
      lastSync: latestStatus?.cloud?.lastSync ?? null,
      pendingCount,
    },
  };
}

function pushStatusToRenderer(snapshot) {
  latestStatus = snapshot;
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send('device:statusUpdate', latestStatus);
  }
}

function emitStatusUpdate(options = {}) {
  pushStatusToRenderer(buildStatusSnapshot(options));
}

function emitLightStatusUpdate() {
  pushStatusToRenderer(buildStatusSnapshot({ includeQueueCounts: false }));
}

function emitEvent(channel, payload) {
  const win = getMainWindow();
  if (win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

/** Throttle large JPEG frames so IPC does not freeze the renderer. */
function emitCameraFrame(cameraId, frame) {
  const key = cameraId || 'default';
  const now = Date.now();
  const last = lastCameraFrameAt.get(key) || 0;
  if (now - last < CAMERA_FRAME_MIN_MS) return;
  lastCameraFrameAt.set(key, now);
  emitEvent('device:cameraFrame', { cameraId, frame });
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

function getWorkflowPassForAdjustment() {
  try {
    const WorkflowEngine = require('../engine/WorkflowEngine');
    const state = WorkflowEngine.getCurrentState?.();
    return state?.context?.pass || null;
  } catch (_e) {
    return null;
  }
}

function buildAdjustedWeightPayload(payload) {
  const raw = Math.round(Number(payload?.weight ?? 0));
  latestRawWeight = Number.isFinite(raw) ? raw : 0;

  const WeightAdjustmentService = require('./WeightAdjustmentService');
  const pass = getWorkflowPassForAdjustment();
  const adjusted = WeightAdjustmentService.apply(latestRawWeight, {
    live: true,
    pass,
  });

  return {
    ...payload,
    weight: adjusted,
  };
}

function wireWeighbridgeAdapter(adapter) {
  adapter.onWeightUpdate((payload) => {
    const adjustedPayload = buildAdjustedWeightPayload(payload);
    emitEvent('device:weightUpdate', adjustedPayload);
    patchWeighbridgeInCache(adjustedPayload);
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      WorkflowEngine.onWeightUpdate(adjustedPayload);
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onStableWeight((payload) => {
    const adjustedPayload = buildAdjustedWeightPayload({
      ...payload,
      isStable: true,
    });
    emitEvent('device:stableWeight', adjustedPayload);
    patchWeighbridgeInCache({ weight: adjustedPayload.weight, isStable: true });
    emitLightStatusUpdate();
    try {
      const WorkflowEngine = require('../engine/WorkflowEngine');
      if (typeof WorkflowEngine.onStableWeight === 'function') {
        WorkflowEngine.onStableWeight(adjustedPayload);
      }
    } catch (_e) {
      /* workflow optional */
    }
  });

  adapter.onWeightZero((payload) => {
    latestRawWeight = 0;
    emitEvent('device:weightZero', payload);
    patchWeighbridgeInCache({ weight: 0, isStable: true });
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
  if (statusFullTimer) clearInterval(statusFullTimer);

  healthTimer = setInterval(() => {
    emitLightStatusUpdate();
  }, HEALTH_INTERVAL_MS);
  if (healthTimer.unref) healthTimer.unref();

  statusFullTimer = setInterval(() => {
    refreshCloudStatus(true)
      .catch(() => false)
      .finally(() => emitStatusUpdate({ includeQueueCounts: true }));
  }, STATUS_FULL_INTERVAL_MS);
  if (statusFullTimer.unref) statusFullTimer.unref();
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

    await refreshCloudStatus(true);
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

async function restart(windowGetter) {
  const getter = windowGetter || getMainWindow;
  await stop();
  started = false;
  rfidAdapter = null;
  rfidAdapters = [];
  weighbridgeAdapter = null;
  cameraAdapter = null;
  latestStatus = null;
  lastRfidSeen = null;
  latestRawWeight = 0;
  cloudReachable = false;
  cloudStatusCheckedAt = 0;
  ['rfid', 'weighbridge', 'camera'].forEach((d) => {
    retryState[d].attempts = 0;
  });
  await start(getter);
}

const DEVICE_RESTART_KEYS = new Set([
  'USE_MOCK_HARDWARE',
  'USE_MOCK_WEIGHBRIDGE',
  'USE_WEBCAM_CAMERA',
  'SIMULATE_WEIGHT_KG',
  'RFID_IP',
  'RFID_IPS',
  'RFID_PORT',
  'WEIGHBRIDGE_COM_PORT',
  'WEIGHBRIDGE_BAUD_RATE',
  'WEIGHBRIDGE_DATA_BITS',
  'WEIGHBRIDGE_PARITY',
  'WEIGHBRIDGE_STOP_BITS',
  'CAMERA_RTSP_URL',
  'CAMERA_RTSP_URLS',
  'CAMERA_RTSP_USER',
  'CAMERA_RTSP_PASSWORD',
  'CAMERA_RTSP_PATH',
  'CAMERA_RTSP_PORT',
  'CLOUD_SYNC_URL',
  'CLOUD_SYNC_TOKEN',
]);

function shouldRestartDevicesForSetting(key) {
  return DEVICE_RESTART_KEYS.has(key);
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
  if (statusFullTimer) {
    clearInterval(statusFullTimer);
    statusFullTimer = null;
  }
  lastCameraFrameAt.clear();
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
  if (channel === 'device:cameraFrame' && payload?.frame) {
    emitCameraFrame(payload.cameraId, payload.frame);
    return;
  }
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

function getCurrentRawWeight() {
  if (latestRawWeight > 0) return latestRawWeight;
  const adapter = weighbridgeAdapter;
  if (adapter && typeof adapter.currentWeight === 'number' && adapter.currentWeight > 0) {
    return Math.round(adapter.currentWeight);
  }
  return latestRawWeight;
}

module.exports = {
  start,
  stop,
  restart,
  shouldRestartDevicesForSetting,
  refreshCloudStatus,
  getCurrentStatus,
  getStatus,
  getAdapters,
  getLatestCachedStatus: () => latestStatus,
  invalidateStatusCountCache,
  emitToRenderer,
  getTestConfig,
  getCameraConfig,
  getRfidDisplayState,
  syncRfidToRenderer,
  startRfidScan,
  stopRfidScan,
  getCurrentRawWeight,
};
