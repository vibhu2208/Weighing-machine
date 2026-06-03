/**
 * Build a renderer-safe URL for local image files.
 * Electron: weighbridge-local:// protocol
 * Browser/server: /media/ HTTP route
 */
export function toMediaUrl(filePath) {
  if (!filePath) return null;
  if (filePath.startsWith('weighbridge-local://')) return filePath;
  if (filePath.startsWith('/media/')) return filePath;
  if (filePath.startsWith('data:') || filePath.startsWith('blob:')) return filePath;

  let normalized = String(filePath).trim();
  if (normalized.startsWith('file://')) {
    normalized = decodeURIComponent(normalized.replace(/^file:\/\//i, ''));
    if (normalized.startsWith('/')) normalized = normalized.slice(1);
  }

  const inBrowser =
    typeof window !== 'undefined' && !window.electronAPI;
  if (inBrowser) {
    return `/media/${encodeURIComponent(normalized)}`;
  }

  return `weighbridge-local://${encodeURIComponent(normalized)}`;
}

export default toMediaUrl;
