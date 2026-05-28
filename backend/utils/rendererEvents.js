'use strict';

let getMainWindow = () => null;

function setWindowGetter(fn) {
  getMainWindow = typeof fn === 'function' ? fn : () => null;
}

function emit(channel, payload = {}) {
  try {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  } catch (_err) {
    /* ignore renderer unavailable */
  }
}

module.exports = { setWindowGetter, emit };
