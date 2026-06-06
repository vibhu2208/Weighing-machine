'use strict';

const SettingsService = require('../../backend/services/SettingsService');
const OperatorAuthService = require('../../backend/services/OperatorAuthService');
const { ADMIN_WEIGHT_KEYS } = require('../../backend/services/WeightAdjustmentService');

const NAMESPACE = 'settings';

const ADMIN_ONLY_SET = new Set(ADMIN_WEIGHT_KEYS);

const CLOUD_BACKUP_KEYS = new Set([
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_REGION',
  'AWS_S3_BUCKET',
  'CLOUD_BACKUP_INTERVAL_MINUTES',
  'CLOUD_BACKUP_ENABLED',
]);

function restartCloudBackup() {
  try {
    const CloudBackupService = require('../../backend/services/CloudBackupService');
    const S3Service = require('../../backend/services/S3Service');
    S3Service.resetClient();
    if (CloudBackupService.isCloudBackupEnabled()) {
      CloudBackupService.start();
    } else {
      CloudBackupService.stop();
    }
  } catch {
    /* optional */
  }
}

function filterAdminKeys(map) {
  const out = { ...map };
  if (OperatorAuthService.isAdminSessionActive()) {
    OperatorAuthService.touchSession();
    return out;
  }
  for (const key of ADMIN_WEIGHT_KEYS) {
    delete out[key];
  }
  return out;
}

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:get`, async (_e, key) => {
    if (ADMIN_ONLY_SET.has(key) && !OperatorAuthService.isAdminSessionActive()) {
      if (key === 'WEIGHT_ADJUSTMENT_ENABLED') return 'false';
      if (key === 'WEIGHT_OFFSET_KG') return '0';
    }
    if (ADMIN_ONLY_SET.has(key)) {
      OperatorAuthService.touchSession();
    }
    return SettingsService.get(key);
  });

  ipcMain.handle(`${NAMESPACE}:set`, async (_e, key, value) => {
    if (ADMIN_ONLY_SET.has(key) && !OperatorAuthService.isAdminSessionActive()) {
      throw new Error('Admin PIN required — unlock Advance Setting first');
    }
    if (ADMIN_ONLY_SET.has(key)) {
      OperatorAuthService.touchSession();
    }

    const result = SettingsService.set(key, value);
    if (['AUTO_BACKUP', 'BACKUP_INTERVAL_HOURS'].includes(key)) {
      try {
        const BackupService = require('../../backend/services/BackupService');
        BackupService.reschedule();
      } catch (_e) {
        /* optional */
      }
    }
    if (CLOUD_BACKUP_KEYS.has(key)) {
      restartCloudBackup();
    }
    const DeviceMonitorService = require('../../backend/services/DeviceMonitorService');
    if (DeviceMonitorService.shouldRestartDevicesForSetting(key)) {
      try {
        await DeviceMonitorService.restart();
      } catch (err) {
        return {
          ...result,
          restartWarning: err.message || 'Device services could not restart',
        };
      }
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:getAll`, async () => filterAdminKeys(SettingsService.getAll()));
}

module.exports = { register, NAMESPACE };
