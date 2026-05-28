'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Build a namespace where each key becomes an IPC invoker for
 * the channel `${namespace}:${method}`.
 */
function buildNamespace(namespace, methods) {
  return methods.reduce((acc, method) => {
    acc[method] = (...args) =>
      ipcRenderer.invoke(`${namespace}:${method}`, ...args);
    return acc;
  }, {});
}

const electronAPI = {
  transactions: buildNamespace('transactions', [
    'create',
    'getAll',
    'getById',
    'updateStatus',
    'getTodayStats',
  ]),

  vehicles: buildNamespace('vehicles', [
    'getAll',
    'create',
    'update',
    'delete',
    'findByRFID',
    'findByNumber',
    'search',
  ]),

  devices: buildNamespace('devices', [
    'getStatus',
    'simulateRFID',
    'simulateWeight',
    'simulateCamera',
    'simulateDisconnect',
    'simulateReconnect',
    'testConnection',
  ]),

  sync: buildNamespace('sync', [
    'getQueueStatus',
    'triggerManualSync',
    'getSyncHistory',
  ]),

  workflow: buildNamespace('workflow', [
    'getState',
    'manualRFID',
    'acceptManualEntry',
    'abort',
    'retryPrint',
  ]),

  reports: buildNamespace('reports', [
    'getDailyReport',
    'getDateRange',
    'getFilteredReport',
    'getSyncSummary',
    'getSlipPath',
    'reprintSlip',
    'exportCSV',
    'exportPDF',
    'printSlip',
  ]),

  backup: buildNamespace('backup', [
    'getList',
    'manualBackup',
    'getLastBackupTime',
  ]),

  storage: buildNamespace('storage', [
    'getStorageStats',
    'runCleanup',
    'listThermalQueue',
    'resendThermal',
  ]),

  settings: buildNamespace('settings', ['get', 'set', 'getAll']),

  /**
   * Subscribe to backend push events (device status, weight ticks, sync progress, etc.).
   * Returns a disposer.
   */
  on(channel, listener) {
    if (typeof listener !== 'function') return () => {};
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  },

  /** Lightweight handshake helper – useful for the "IPC bridge loaded?" check. */
  ping: () => 'pong',

  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },
};

try {
  contextBridge.exposeInMainWorld('electronAPI', electronAPI);
} catch (err) {
  // eslint-disable-next-line no-console
  console.error('[preload] Failed to expose electronAPI:', err);
}
