'use strict';

const SettingsService = require('./SettingsService');

const ADMIN_WEIGHT_KEYS = Object.freeze([
  'WEIGHT_ADJUSTMENT_ENABLED',
  'WEIGHT_OFFSET_KG',
]);

function roundKg(value) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? n : 0;
}

function isEnabled() {
  return SettingsService.get('WEIGHT_ADJUSTMENT_ENABLED') === 'true';
}

function getOffsetKg() {
  const n = Number(SettingsService.get('WEIGHT_OFFSET_KG') || 0);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
}

/** Offset applies to loaded truck (gross) only — not tare. */
function shouldApplyOffset(pass) {
  if (!isEnabled() || getOffsetKg() === 0) return false;
  return pass !== 'TARE';
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null, live?: boolean }} context
 */
function apply(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  if (raw <= 0) return raw;

  const pass = context.pass || null;
  if (!shouldApplyOffset(pass)) return raw;

  return raw + getOffsetKg();
}

/**
 * @param {number} rawKg
 * @param {{ pass?: 'TARE'|'GROSS'|null }} context
 */
function split(rawKg, context = {}) {
  const raw = roundKg(rawKg);
  const offsetKg = shouldApplyOffset(context.pass || null) ? getOffsetKg() : 0;
  return {
    rawKg: raw,
    adjustedKg: raw + offsetKg,
    offsetKg,
  };
}

module.exports = {
  ADMIN_WEIGHT_KEYS,
  isEnabled,
  getOffsetKg,
  shouldApplyOffset,
  apply,
  split,
};
