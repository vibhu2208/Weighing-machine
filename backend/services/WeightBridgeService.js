'use strict';

const { SerialPort } = require('serialport');
const logger = require('../utils/logger');
const ts = require('../utils/timestamp');

const DEFAULTS = Object.freeze({
  port: 'COM3',
  baudRate: 2400,
  dataBits: 7,
  parity: 'none',
  stopBits: 1,
  autoReconnectMs: 2000,
  stableWindowSize: 5,
  stableToleranceKg: 2,
  zeroHoldMs: 1200,
});

class WeightBridgeService {
  constructor(config = {}) {
    this.config = {
      ...DEFAULTS,
      ...config,
      baudRate: Number(config.baudRate || DEFAULTS.baudRate),
      dataBits: Number(config.dataBits || DEFAULTS.dataBits),
      stopBits: Number(config.stopBits || DEFAULTS.stopBits),
      parity: String(config.parity || DEFAULTS.parity).toLowerCase(),
      autoReconnectMs: Number(config.autoReconnectMs || DEFAULTS.autoReconnectMs),
      stableWindowSize: Number(config.stableWindowSize || DEFAULTS.stableWindowSize),
      stableToleranceKg: Number(config.stableToleranceKg || DEFAULTS.stableToleranceKg),
      zeroHoldMs: Number(config.zeroHoldMs || DEFAULTS.zeroHoldMs),
    };

    this.port = null;
    this.reconnectTimer = null;
    this.intentionalClose = false;
    this.connected = false;

    this.latestRawWeight = 0;
    this.latestStableWeight = 0;
    this.latestWeight = 0;
    this.isStable = false;
    this.buffer = [];

    this.weightChangedHandlers = new Set();
    this.lastEmittedWeight = null;
    this.textBuffer = '';
    this.zeroCandidateSince = null;
  }

  async start() {
    this.intentionalClose = false;
    await this._openPort();
  }

  async stop() {
    this.intentionalClose = true;
    this._clearReconnect();
    await this._closePort();
    this.connected = false;
  }

  getCurrentWeight() {
    return this.latestStableWeight;
  }

  getSnapshot() {
    return {
      weight: this.latestWeight,
      stableWeight: this.latestStableWeight,
      isStable: this.isStable,
      connected: this.connected,
      timestamp: ts.now(),
    };
  }

  onWeightChanged(handler) {
    if (typeof handler !== 'function') return () => {};
    this.weightChangedHandlers.add(handler);
    return () => {
      this.weightChangedHandlers.delete(handler);
    };
  }

  async _openPort() {
    await this._closePort();

    const options = {
      path: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
      autoOpen: false,
    };

    const port = new SerialPort(options);
    this.port = port;

    port.on('data', (chunk) => this._handleData(chunk));
    port.on('error', (err) => {
      logger.logDevice('weighbridge', 'error', 'Serial error', {
        error: err.message,
        port: this.config.port,
      });
      this._handleDisconnect();
    });
    port.on('close', () => {
      this._handleDisconnect();
    });

    await new Promise((resolve, reject) => {
      port.open((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    });

    this.connected = true;
    logger.logDevice('weighbridge', 'connect', 'Port Connected', {
      port: this.config.port,
      baudRate: this.config.baudRate,
      dataBits: this.config.dataBits,
      parity: this.config.parity,
      stopBits: this.config.stopBits,
    });
  }

  async _closePort() {
    const closingPort = this.port;
    this.port = null;
    if (!closingPort) return;

    await new Promise((resolve) => {
      if (!closingPort.isOpen) {
        resolve();
        return;
      }
      closingPort.close(() => resolve());
    });
  }

  _handleDisconnect() {
    if (!this.connected && this.reconnectTimer) return;
    this.connected = false;

    logger.logDevice('weighbridge', 'disconnect', 'Port Disconnected', {
      port: this.config.port,
    });

    if (!this.intentionalClose) {
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this._clearReconnect();
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this._openPort();
      } catch (err) {
        logger.logDevice('weighbridge', 'error', 'Serial error', {
          error: err.message,
          port: this.config.port,
        });
        this._scheduleReconnect();
      }
    }, this.config.autoReconnectMs);
    if (this.reconnectTimer.unref) this.reconnectTimer.unref();
  }

  _clearReconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  _handleData(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk || '');
    if (!text) return;
    const compact = text.replace(/\0/g, '').trim();

    // Many indicators stream short fixed-size frames without '\n'. Parse chunk directly,
    // but ignore very short fragments that are commonly half-frame bytes (e.g. "6" from "60").
    if (compact.length > 1 || /[\r\n]/.test(text) || /kg|kgs/i.test(compact)) {
      this._consumeLine(text);
    }

    this.textBuffer += text;
    const lines = this.textBuffer.split(/\r\n|\n|\r/);
    this.textBuffer = lines.pop() || '';

    for (const line of lines) {
      this._consumeLine(line);
    }

    // Fallback for streams with no delimiter at all.
    if (this.textBuffer.length > 32) {
      this._consumeLine(this.textBuffer);
      this.textBuffer = '';
    }
  }

  _consumeLine(line) {
    const parsed = this._parseWeight(line);
    if (!Number.isFinite(parsed)) return;
    const nowMs = Date.now();

    if (this._looksLikePartialFrame(parsed, line)) {
      return;
    }

    // Ignore short-lived zero glitches while vehicle is still on bridge.
    if (parsed === 0 && (this.latestWeight > 0 || this.latestStableWeight > 0)) {
      if (!this.zeroCandidateSince) {
        this.zeroCandidateSince = nowMs;
        return;
      }
      if (nowMs - this.zeroCandidateSince < this.config.zeroHoldMs) {
        return;
      }
    } else {
      this.zeroCandidateSince = null;
    }

    this.latestRawWeight = parsed;
    this.latestWeight = parsed;
    this.buffer.push(parsed);
    while (this.buffer.length > this.config.stableWindowSize) {
      this.buffer.shift();
    }

    this.isStable = this._computeStable();
    if (this.isStable) {
      this.latestStableWeight = parsed;
    }

    this._emitWeightChanged(parsed);
  }

  _computeStable() {
    if (this.buffer.length < this.config.stableWindowSize) return false;
    const min = Math.min(...this.buffer);
    const max = Math.max(...this.buffer);
    return max - min <= this.config.stableToleranceKg;
  }

  _emitWeightChanged(weight) {
    if (this.lastEmittedWeight === weight) return;
    this.lastEmittedWeight = weight;

    logger.logDevice('weighbridge', 'weight-change', 'Weight Changed', {
      weight,
      stableWeight: this.latestStableWeight,
      isStable: this.isStable,
    });

    for (const handler of this.weightChangedHandlers) {
      try {
        handler({
          weight,
          stableWeight: this.latestStableWeight,
          isStable: this.isStable,
          timestamp: ts.now(),
        });
      } catch (err) {
        logger.warn('WeightBridgeService listener failed', { message: err.message });
      }
    }
  }

  _parseWeight(input) {
    if (!input) return null;

    const text = String(input).replace(/\0/g, ' ').trim();
    if (!text) return null;

    const kgMatch = text.match(/(-?\d+(?:\.\d+)?)\s*(?:kg|kgs)\b/i);
    if (kgMatch) {
      const kgValue = Number(kgMatch[1]);
      if (Number.isFinite(kgValue)) return Math.round(kgValue);
    }

    const matches = text.match(/-?\d+(?:\.\d+)?/g);
    if (!matches || !matches.length) return null;

    const value = Number(matches[matches.length - 1]);
    if (!Number.isFinite(value)) return null;
    return Math.round(value);
  }

  _looksLikePartialFrame(parsed, rawLine) {
    const text = String(rawLine || '').replace(/\0/g, ' ').trim();
    if (!text) return false;
    if (/kg|kgs/i.test(text)) return false;

    // Common glitch: receive "6" between full "60" frames.
    if (
      Number.isFinite(this.latestWeight) &&
      this.latestWeight >= 10 &&
      parsed > 0 &&
      parsed * 10 === this.latestWeight
    ) {
      return true;
    }

    return false;
  }
}

module.exports = WeightBridgeService;
