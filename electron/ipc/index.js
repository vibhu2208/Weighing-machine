'use strict';

/**
 * Central IPC registrar. Each per-domain file exports `{ register(ipcMain) }`
 * and is wired in here. Phase 1: all handlers are stubs that return a
 * `not_implemented` payload but the channels exist so the renderer never
 * crashes when calling them.
 */
const { ipcMain } = require('electron');

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

function registerAll() {
  for (const mod of modules) {
    if (mod && typeof mod.register === 'function') {
      mod.register(ipcMain);
    }
  }
}

module.exports = { registerAll };
