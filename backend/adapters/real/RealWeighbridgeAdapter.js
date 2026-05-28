'use strict';

const WeighbridgeAdapter = require('../base/WeighbridgeAdapter');
const logger = require('../../utils/logger');

class RealWeighbridgeAdapter extends WeighbridgeAdapter {
  constructor(config = {}) {
    super(config);
    logger.info(
      'RealWeighbridgeAdapter loaded — awaiting hardware implementation',
    );
  }

  async connect() {
    throw new Error(
      'Real hardware not yet configured — check weighbridge COM port in settings',
    );
  }

  async disconnect() {
    this.connected = false;
  }

  async getWeight() {
    throw new Error(
      'Real hardware not yet configured — check weighbridge COM port in settings',
    );
  }
}

module.exports = RealWeighbridgeAdapter;
