'use strict';

const BackupService = require('../../backend/services/BackupService');

const NAMESPACE = 'backup';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getList`, async () => BackupService.getBackupList());

  ipcMain.handle(`${NAMESPACE}:manualBackup`, async () => BackupService.manualBackup());

  ipcMain.handle(`${NAMESPACE}:getLastBackupTime`, async () =>
    BackupService.getLastBackupTime(),
  );
}

module.exports = { register, NAMESPACE };
