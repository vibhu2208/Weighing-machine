'use strict';

/**
 * Single source of truth for date/time across the application.
 * Never call `new Date()` directly anywhere else.
 */

function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** Current ISO 8601 UTC timestamp. */
function now() {
  return new Date().toISOString();
}

/** Convert ISO string to DD/MM/YYYY HH:mm:ss (local time). */
function toDisplay(iso) {
  if (!iso) return '';
  const d = iso instanceof Date ? iso : new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return (
    `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  );
}

/** ISO timestamp at 00:00:00.000 local time of today. */
function todayStart() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

/** ISO timestamp at 23:59:59.999 local time of today. */
function todayEnd() {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d.toISOString();
}

/** ISO timestamp N days before now (local calendar days). */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString();
}

/** Filesystem-safe compact timestamp e.g. 20250518_131245. */
function fileSafe(date) {
  const d = date instanceof Date ? date : new Date();
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

/** Returns { year, month, day } as zero-padded strings for path building. */
function parts(date) {
  const d = date instanceof Date ? date : new Date(date || Date.now());
  return {
    year: String(d.getFullYear()),
    month: pad(d.getMonth() + 1),
    day: pad(d.getDate()),
  };
}

module.exports = {
  now,
  toDisplay,
  todayStart,
  todayEnd,
  daysAgo,
  fileSafe,
  parts,
};
