'use strict';

const TransactionService = require('../../backend/services/TransactionService');

const NAMESPACE = 'transactions';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:create`, async (_e, data) =>
    TransactionService.create(data),
  );

  ipcMain.handle(`${NAMESPACE}:getAll`, async (_e, filters) =>
    TransactionService.getAll(filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getById`, async (_e, id) =>
    TransactionService.getById(id),
  );

  ipcMain.handle(`${NAMESPACE}:updateStatus`, async (_e, id, status) =>
    TransactionService.updateStatus(id, status),
  );

  ipcMain.handle(`${NAMESPACE}:getTodayStats`, async () =>
    TransactionService.getTodayStats(),
  );
}

module.exports = { register, NAMESPACE };
