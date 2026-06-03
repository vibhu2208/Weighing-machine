'use strict';

const fs = require('fs');
const path = require('path');
const ts = require('./timestamp');

/** Project root resolved relative to this file: backend/utils -> ../.. */
const ROOT = path.resolve(__dirname, '..', '..');

const PATHS = Object.freeze({
  ROOT,
  UPLOADS: path.join(ROOT, 'uploads'),
  BACKUPS: path.join(ROOT, 'backups'),
  LOGS: path.join(ROOT, 'logs'),
  DATABASE: path.join(ROOT, 'database'),
  THERMAL_QUEUE: path.join(ROOT, 'logs', 'thermal_queue'),
  REPRINT_QUEUE: path.join(ROOT, 'logs', 'reprint_queue.json'),
});

function normalizePath(p) {
  return path.normalize(path.resolve(p));
}

/** Create a directory (and parents) if it doesn't already exist. */
function ensureDir(dir) {
  const target = normalizePath(dir);
  if (!fs.existsSync(target)) {
    fs.mkdirSync(target, { recursive: true });
  }
  return target;
}

[PATHS.UPLOADS, PATHS.BACKUPS, PATHS.LOGS, PATHS.DATABASE, PATHS.THERMAL_QUEUE].forEach(
  ensureDir,
);

/**
 * Path for a transaction's captured image:
 *   uploads/YYYY/MM/DD/{transactionId}.jpg
 */
function getImagePath(transactionId, date) {
  if (!transactionId) {
    throw new Error('getImagePath: transactionId is required');
  }
  const { year, month, day } = ts.parts(date);
  const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
  return normalizePath(path.join(dir, `${transactionId}.jpg`));
}

/** Per-camera snapshot: uploads/YYYY/MM/DD/{transactionId}_{cameraId}.jpg */
function getCameraImagePath(transactionId, cameraId, date) {
  if (!transactionId) {
    throw new Error('getCameraImagePath: transactionId is required');
  }
  const safeId = String(cameraId || 'cam').replace(/[^a-zA-Z0-9_-]/g, '_');
  const { year, month, day } = ts.parts(date);
  const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
  return normalizePath(path.join(dir, `${transactionId}_${safeId}.jpg`));
}

function saveCameraImage(sourceBuffer, transactionId, cameraId, date) {
  if (!Buffer.isBuffer(sourceBuffer)) {
    throw new Error('saveCameraImage: sourceBuffer must be a Buffer');
  }
  const dest = getCameraImagePath(transactionId, cameraId, date);
  fs.writeFileSync(dest, sourceBuffer);
  return dest;
}

function saveImage(sourceBuffer, transactionId, date) {
  if (!Buffer.isBuffer(sourceBuffer)) {
    throw new Error('saveImage: sourceBuffer must be a Buffer');
  }
  const dest = getImagePath(transactionId, date);
  fs.writeFileSync(dest, sourceBuffer);
  return dest;
}

function getImage(transactionId, date) {
  const p = getImagePath(transactionId, date);
  return fs.existsSync(p) ? p : null;
}

function deleteImage(transactionId, date) {
  const candidates = [];
  if (date) {
    const p = getImage(transactionId, date);
    if (p) candidates.push(p);
  } else {
    walkUploadTree((filePath, name) => {
      if (name === `${transactionId}.jpg`) candidates.push(filePath);
    });
  }
  let removed = 0;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      fs.unlinkSync(p);
      removed += 1;
    }
  }
  return removed;
}

function walkUploadTree(onFile) {
  if (!fs.existsSync(PATHS.UPLOADS)) return;
  const stack = [PATHS.UPLOADS];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) stack.push(full);
      else if (ent.isFile() && ent.name.endsWith('.jpg')) onFile(normalizePath(full), ent.name);
    }
  }
}

function listImages(date) {
  const { year, month, day } = ts.parts(date);
  const dir = path.join(PATHS.UPLOADS, year, month, day);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.jpg') && !f.includes('_slip'))
    .map((f) => normalizePath(path.join(dir, f)));
}

function getStorageStats() {
  let totalImages = 0;
  let totalSizeBytes = 0;
  let oldestDate = null;
  let newestDate = null;

  walkUploadTree((filePath) => {
    if (filePath.includes('_slip.')) return;
    try {
      const st = fs.statSync(filePath);
      if (!st.isFile()) return;
      totalImages += 1;
      totalSizeBytes += st.size;
      const mtime = st.mtime.toISOString();
      if (!oldestDate || mtime < oldestDate) oldestDate = mtime;
      if (!newestDate || mtime > newestDate) newestDate = mtime;
    } catch {
      /* skip */
    }
  });

  return { totalImages, totalSizeBytes, oldestDate, newestDate };
}

function deleteOlderThan(days = 90) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  let deleted = 0;
  walkUploadTree((filePath) => {
    if (filePath.includes('_slip.')) return;
    try {
      const st = fs.statSync(filePath);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(filePath);
        deleted += 1;
      }
    } catch {
      /* skip */
    }
  });
  return deleted;
}

/** Path for a new database backup file. */
function getBackupPath() {
  ensureDir(PATHS.BACKUPS);
  return normalizePath(
    path.join(PATHS.BACKUPS, `weighbridge_${ts.fileSafe()}.db`),
  );
}

function getBackupLogPath() {
  ensureDir(PATHS.BACKUPS);
  const { year, month, day } = ts.parts();
  return normalizePath(path.join(PATHS.BACKUPS, `app_${year}${month}${day}.log`));
}

/** Path for a log file under logs/. */
function getLogPath(filename) {
  ensureDir(PATHS.LOGS);
  return normalizePath(path.join(PATHS.LOGS, filename));
}

/** Renderer-safe URL (use in Electron UI). Prefer this over file://. */
function toMediaUrl(filePath) {
  if (!filePath) return null;
  if (String(filePath).startsWith('weighbridge-local://')) return filePath;
  return `weighbridge-local://${encodeURIComponent(normalizePath(filePath))}`;
}

/** @deprecated Use toMediaUrl in renderer; file:// is blocked from http origins. */
function toFileUrl(filePath) {
  return toMediaUrl(filePath);
}

module.exports = {
  PATHS,
  normalizePath,
  ensureDir,
  getImagePath,
  getCameraImagePath,
  saveCameraImage,
  saveImage,
  getImage,
  deleteImage,
  listImages,
  getStorageStats,
  deleteOlderThan,
  getBackupPath,
  getBackupLogPath,
  getLogPath,
  toMediaUrl,
  toFileUrl,
};
