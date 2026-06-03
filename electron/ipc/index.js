'use strict';

/**
 * Central IPC registrar. Each per-domain file exports `{ register(ipcMain) }`
 * and is wired in here. Phase 1: all handlers are stubs that return a
 * `not_implemented` payload but the channels exist so the renderer never
 * crashes when calling them.
 */
let electronIpcMain = null;
try {
  electronIpcMain = require('electron').ipcMain;
} catch (_e) {
  /* server mode — no Electron */
}

const modules = [
  require('./transaction.ipc'),
  require('./vehicle.ipc'),
  require('./device.ipc'),
  require('./sync.ipc'),
  require('./workflow.ipc'),
  require('./report.ipc'),
  require('./settings.ipc'),
  require('./backup.ipc'),
  require('./storage.ipc'),
];

function registerAll(ipcMainInstance) {
  const target = ipcMainInstance || electronIpcMain;
  if (!target) {
    throw new Error('ipcMain is not available (Electron not loaded)');
  }
  for (const mod of modules) {
    if (mod && typeof mod.register === 'function') {
      mod.register(target);
    }
  }
}

module.exports = { registerAll, modules };
