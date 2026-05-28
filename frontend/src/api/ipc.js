/**
 * Thin wrapper around `window.electronAPI` that:
 *  - guards against the bridge being missing (renderer rendered in browser)
 *  - normalises errors with a clean message
 *  - logs to the renderer console
 */

const hasBridge = () =>
  typeof window !== 'undefined' && !!window.electronAPI;

export function isIpcReady() {
  return hasBridge();
}

function ensureBridge() {
  if (!hasBridge()) {
    const err = new Error(
      'IPC bridge not loaded — restart the app (window.electronAPI is undefined).',
    );
    err.code = 'IPC_BRIDGE_MISSING';
    throw err;
  }
}

async function safeCall(namespace, method, args) {
  try {
    ensureBridge();
    const ns = window.electronAPI[namespace];
    if (!ns || typeof ns[method] !== 'function') {
      throw new Error(`IPC method not found: ${namespace}.${method}`);
    }
    return await ns[method](...args);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[ipc] ${namespace}.${method} failed:`, err);
    const wrapped = new Error(
      `${namespace}.${method} failed: ${err && err.message ? err.message : 'unknown error'}`,
    );
    wrapped.cause = err;
    throw wrapped;
  }
}

function makeProxy(namespace, methods) {
  return methods.reduce((acc, method) => {
    acc[method] = (...args) => safeCall(namespace, method, args);
    return acc;
  }, {});
}

export const transactionAPI = makeProxy('transactions', [
  'create',
  'getAll',
  'getById',
  'updateStatus',
  'getTodayStats',
]);

export const vehicleAPI = makeProxy('vehicles', [
  'getAll',
  'create',
  'update',
  'delete',
  'findByRFID',
  'findByNumber',
  'search',
]);

export const deviceAPI = makeProxy('devices', [
  'getStatus',
  'simulateRFID',
  'simulateWeight',
  'simulateCamera',
  'simulateDisconnect',
  'simulateReconnect',
  'testConnection',
]);

export const syncAPI = makeProxy('sync', [
  'getQueueStatus',
  'triggerManualSync',
  'getSyncHistory',
]);

export const reportAPI = makeProxy('reports', [
  'getDailyReport',
  'getDateRange',
  'getFilteredReport',
  'getSyncSummary',
  'getSlipPath',
  'reprintSlip',
  'exportCSV',
  'exportPDF',
  'printSlip',
]);

export const backupAPI = makeProxy('backup', [
  'getList',
  'manualBackup',
  'getLastBackupTime',
]);

export const storageAPI = makeProxy('storage', [
  'getStorageStats',
  'runCleanup',
  'listThermalQueue',
  'resendThermal',
]);

export const settingsAPI = makeProxy('settings', ['get', 'set', 'getAll']);

export const workflowAPI = makeProxy('workflow', [
  'getState',
  'manualRFID',
  'acceptManualEntry',
  'abort',
  'retryPrint',
]);

/** Subscribe to a backend push channel; returns a disposer. */
export function subscribe(channel, listener) {
  if (!hasBridge() || typeof window.electronAPI.on !== 'function') {
    return () => {};
  }
  return window.electronAPI.on(channel, listener);
}

export default {
  isIpcReady,
  transactionAPI,
  vehicleAPI,
  deviceAPI,
  syncAPI,
  reportAPI,
  backupAPI,
  storageAPI,
  settingsAPI,
  workflowAPI,
  subscribe,
};
