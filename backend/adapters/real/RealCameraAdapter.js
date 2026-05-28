'use strict';

const CameraAdapter = require('../base/CameraAdapter');
const logger = require('../../utils/logger');

class RealCameraAdapter extends CameraAdapter {
  constructor(config = {}) {
    super(config);
    logger.info('RealCameraAdapter loaded — awaiting hardware implementation');
  }

  async connect() {
    throw new Error(
      'Real hardware not yet configured — check camera RTSP URL in settings',
    );
  }

  async disconnect() {
    this.connected = false;
  }

  async captureImage() {
    throw new Error(
      'Real hardware not yet configured — check camera RTSP URL in settings',
    );
  }
}

module.exports = RealCameraAdapter;
