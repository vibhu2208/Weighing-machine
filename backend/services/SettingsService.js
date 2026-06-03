'use strict';

const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const { DEFAULTS } = require('../utils/constants');

/** Defaults mirrored from .env.example when a key is absent in DB. */
const ENV_DEFAULTS = Object.freeze({
  APP_ENV: 'development',
  CLOUD_SYNC_URL: 'https://api.example.com/weighbridge',
  CLOUD_SYNC_TOKEN: '',
  RFID_IP: '192.168.1.116',
  RFID_IPS: '',
  RFID_PORT: '9090',
  RFID_ANT_MASK: '1',
  RFID_DEBOUNCE_MS: '2500',
  RFID_ANTENNA_POWER: '20',
  WEIGHBRIDGE_COM_PORT: 'COM3',
  WEIGHBRIDGE_BAUD_RATE: '2400',
  WEIGHBRIDGE_DATA_BITS: '7',
  WEIGHBRIDGE_PARITY: 'none',
  WEIGHBRIDGE_STOP_BITS: '1',
  CAMERA_RTSP_URL: 'rtsp://admin:123456@192.168.0.18:554/ch01.264',
  CAMERA_RTSP_URLS: '192.168.0.88,192.168.0.18,192.168.0.25',
  CAMERA_RTSP_USER: 'admin',
  CAMERA_RTSP_PASSWORD: '123456',
  CAMERA_RTSP_PATH: '/ch01.264',
  CAMERA_RTSP_PORT: '554',
  CAMERA_RTSP_URL_ALTERNATES: '',
  CAMERA_HTTP_SNAPSHOT_URL: 'http://admin:123456@192.168.0.18/cgi-bin/snapshot.cgi',
  SYNC_INTERVAL_SECONDS: String(DEFAULTS.SYNC_INTERVAL_SECONDS),
  BACKUP_INTERVAL_HOURS: String(DEFAULTS.BACKUP_INTERVAL_HOURS),
  MAX_RETRY_ATTEMPTS: String(DEFAULTS.MAX_RETRY_ATTEMPTS),
  LOG_LEVEL: DEFAULTS.LOG_LEVEL,
  USE_MOCK_HARDWARE: 'true',
  AUTO_BACKUP: 'true',
  IMAGE_AUTO_CLEANUP: 'true',
  IMAGE_RETENTION_DAYS: '90',
  COMPANY_NAME: 'Weighbridge Manager',
  COMPANY_ADDRESS: '',
  COMPANY_PHONE: '',
  PRINTER_NAME: '',
  PAPER_SIZE: 'A4',
  DB_PATH: './database/weighbridge.db',
});

function resolveDefault(key) {
  if (process.env[key] !== undefined && process.env[key] !== '') {
    return process.env[key];
  }
  if (ENV_DEFAULTS[key] !== undefined) {
    return ENV_DEFAULTS[key];
  }
  return '';
}

const SettingsService = {
  get(key) {
    const row = getDb()
      .prepare('SELECT value FROM settings WHERE key = ?')
      .get(key);
    if (row && row.value !== undefined && row.value !== null) {
      return row.value;
    }
    return resolveDefault(key);
  },

  set(key, value) {
    const now = ts.now();
    getDb()
      .prepare(
        `INSERT INTO settings (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      )
      .run(key, String(value), now);
    return { key, value: String(value), updated_at: now };
  },

  getAll() {
    const rows = getDb()
      .prepare('SELECT key, value, updated_at FROM settings ORDER BY key')
      .all();
    const map = {};
    for (const row of rows) {
      map[row.key] = row.value;
    }
    for (const key of Object.keys(ENV_DEFAULTS)) {
      if (map[key] === undefined) {
        map[key] = resolveDefault(key);
      }
    }
    return map;
  },
};

module.exports = SettingsService;
