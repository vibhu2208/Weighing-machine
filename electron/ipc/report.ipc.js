'use strict';

const { dialog } = require('electron');
const ReportService = require('../../backend/services/ReportService');

const NAMESPACE = 'reports';

function register(ipcMain) {
  ipcMain.handle(`${NAMESPACE}:getDailyReport`, async (_e, date) =>
    ReportService.getDailyReport(date),
  );

  ipcMain.handle(`${NAMESPACE}:getDateRange`, async (_e, from, to, filters) =>
    ReportService.getDateRangeReport(from, to, filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getFilteredReport`, async (_e, filters) =>
    ReportService.getFilteredReport(filters || {}),
  );

  ipcMain.handle(`${NAMESPACE}:getSyncSummary`, async () =>
    ReportService.getSyncSummary(),
  );

  ipcMain.handle(`${NAMESPACE}:getSlipPath`, async (_e, transactionId) =>
    ReportService.getSlipPath(transactionId),
  );

  ipcMain.handle(`${NAMESPACE}:reprintSlip`, async (_e, transactionId) =>
    ReportService.reprintSlip(transactionId),
  );

  ipcMain.handle(`${NAMESPACE}:exportCSV`, async (_e, filters) => {
    const result = await ReportService.exportCSV(filters || {});
    if (result.path) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Export complete',
        message: `CSV saved to:\n${result.path}`,
      });
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:exportPDF`, async (_e, filters) => {
    const result = await ReportService.exportPDF(filters || {});
    if (result.path) {
      dialog.showMessageBox({
        type: 'info',
        title: 'Export complete',
        message: `PDF saved to:\n${result.path}`,
      });
    }
    return result;
  });

  ipcMain.handle(`${NAMESPACE}:printSlip`, async (_e, transactionId) =>
    ReportService.printSlip(transactionId),
  );
}

module.exports = { register, NAMESPACE };
