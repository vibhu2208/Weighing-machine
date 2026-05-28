/**
 * Build a renderer-safe URL for local image files.
 * Uses the weighbridge-local:// protocol (registered in electron/main.js).
 * Do not use file:// — it is blocked from http://localhost and from packaged app origins.
 */
export function toMediaUrl(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('weighbridge-local://')) return filePath;
  if (filePath.startsWith('data:') || filePath.startsWith('blob:')) return filePath;

  let normalized = String(filePath).trim();
  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
  }

  return `weighbridge-local://${encodeURIComponent(normalized)}`;
}

export default toMediaUrl;
