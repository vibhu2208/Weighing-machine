'use strict';

const RFIDAdapter = require('../base/RFIDAdapter');
const logger = require('../../utils/logger');
const ts = require('../../utils/timestamp');

const DEMO_TAGS = [
  'E280117000000208AABBCC01',
  'E280117000000208AABBCC02',
  'E280117000000208AABBCC03',
  'E280117000000208AABBCC04',
  'E280117000000208AABBCC05',
];

class MockRFIDAdapter extends RFIDAdapter {
  constructor(config = {}) {
    super(config);
    this._scanTimer = null;
  }

  async connect() {
    this.connected = true;
    logger.info('Mock RFID connected', { type: 'device', device: 'rfid' });
    return true;
  }

  async disconnect() {
    if (this._scanTimer) {
      clearTimeout(this._scanTimer);
      this._scanTimer = null;
    }
    this.connected = false;
    return true;
  }

  simulateScan(tagOverride) {
    if (!this.connected) {
      logger.info('Mock RFID simulateScan skipped — not connected', {
        type: 'device',
        device: 'rfid',
      });
      return;
    }

    const tag =
      tagOverride ||
      DEMO_TAGS[Math.floor(Math.random() * DEMO_TAGS.length)];

    if (this._scanTimer) clearTimeout(this._scanTimer);

    this._scanTimer = setTimeout(() => {
      this._scanTimer = null;
      const payload = { tag, timestamp: ts.now() };
      if (typeof this.onTagDetectedCallback === 'function') {
        this.onTagDetectedCallback(payload);
      }
    }, 200);
  }

  simulateDisconnect() {
    if (!this.connected) {
      logger.info('Mock RFID already disconnected', { type: 'device', device: 'rfid' });
      return;
    }
    this.connected = false;
    if (typeof this.onErrorCallback === 'function') {
      this.onErrorCallback(new Error('Mock RFID disconnected'));
    }
  }

  async simulateReconnect() {
    if (this.connected) {
      logger.info('Mock RFID already connected', { type: 'device', device: 'rfid' });
      return;
    }
    await new Promise((r) => setTimeout(r, 2000));
    this.connected = true;
    logger.info('Mock RFID reconnected', { type: 'device', device: 'rfid' });
    if (typeof this.onReconnectCallback === 'function') {
      this.onReconnectCallback();
    }
  }
}

module.exports = MockRFIDAdapter;
