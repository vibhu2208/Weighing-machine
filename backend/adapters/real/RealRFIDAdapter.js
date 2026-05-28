'use strict';

const RFIDAdapter = require('../base/RFIDAdapter');
const logger = require('../../utils/logger');

class RealRFIDAdapter extends RFIDAdapter {
  constructor(config = {}) {
    super(config);
    logger.info('RealRFIDAdapter loaded — awaiting hardware implementation');
  }

  async connect() {
    throw new Error(
      'Real hardware not yet configured — check RFID IP and port in settings',
    );
  }

  async disconnect() {
    this.connected = false;
  }
}

module.exports = RealRFIDAdapter;
