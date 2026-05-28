'use strict';

const SettingsService = require('../../backend/services/SettingsService');

const NAMESPACE = 'settings';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:get`, async (_e, key) =>
    SettingsService.get(key),
  );

  ipcMain.handle(`${NAMESPACE}:set`, async (_e, key, value) => {
    const result = SettingsService.set(key, value);
    if (['AUTO_BACKUP', 'BACKUP_INTERVAL_HOURS'].includes(key)) {
      try {
        const BackupService = require('../../backend/services/BackupService');
        BackupService.reschedule();
      } catch {
        /* optional */
      }
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:getAll`, async () => SettingsService.getAll());
}

module.exports = { register, NAMESPACE };
