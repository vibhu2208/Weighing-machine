'use strict';

const fs = require('fs');
const path = require('path');

let BrowserWindow = null;
try {
  BrowserWindow = require('electron').BrowserWindow;
} catch (_e) {
  /* server mode — PDF export unavailable without Electron */
}
const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const { PATHS, ensureDir } = require('../utils/fileStorage');
const PrintService = require('./PrintService');
const logger = require('../utils/logger');

const SELECT = `
  SELECT t.*, v.owner_name, v.transporter, v.vehicle_type
  FROM transactions t
  LEFT JOIN vehicles v ON v.vehicle_number = t.truck_number
`;

function escapeCsv(value) {
  if (value == null) return '""';
  const s = String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

function buildWhere(filters = {}) {
  const clauses = [];
  const params = [];

  if (filters.from) {
    clauses.push('t.timestamp_in >= ?');
    params.push(filters.from);
  }
  if (filters.to) {
    clauses.push('t.timestamp_in <= ?');
    params.push(filters.to);
  }
  if (filters.truck_number) {
    clauses.push('UPPER(t.truck_number) = ?');
    params.push(String(filters.truck_number).trim().toUpperCase());
  }
  if (filters.status && filters.status !== 'all') {
    clauses.push('t.status = ?');
    params.push(filters.status);
  }
  if (filters.sync_status && filters.sync_status !== 'all') {
    clauses.push('t.sync_status = ?');
    params.push(filters.sync_status);
  }

  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  return { where, params };
}

function queryTransactions(filters = {}) {
  const { where, params } = buildWhere(filters);
  return getDb()
    .prepare(`${SELECT} ${where} ORDER BY t.timestamp_in DESC`)
    .all(...params);
}

function summarise(rows) {
  return {
    total: rows.length,
    gross: rows.reduce((s, r) => s + (r.gross_weight || 0), 0),
    tare: rows.reduce((s, r) => s + (r.tare_weight || 0), 0),
    net: rows.reduce((s, r) => s + (r.net_weight || 0), 0),
  };
}

function countCameraSnapshots(row) {
  if (!row?.camera_snapshots) {
    return row?.image_path || row?.tare_image_path ? 1 : 0;
  }
  let raw = row.camera_snapshots;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return row?.image_path || row?.tare_image_path ? 1 : 0;
    }
  }
  return (raw.tare?.length || 0) + (raw.gross?.length || 0);
}

const CSV_HEADERS = [
  'Slip No',
  'Truck Number',
  'RFID Tag',
  'Gross Weight (kg)',
  'Tare Weight (kg)',
  'Net Weight (kg)',
  'Time In',
  'Time Out',
  'Status',
  'Sync Status',
  'Operator',
  'Image Available',
  'Camera Snapshots',
];

const ReportService = {
  getDailyReport(date) {
    const day = date || ts.todayStart().slice(0, 10);
    const rows = queryTransactions({
      from: `${day}T00:00:00.000Z`,
      to: `${day}T23:59:59.999Z`,
    });

    const completed = rows.filter((r) =>
      ['captured', 'printed', 'synced'].includes(r.status),
    ).length;
    const pending = rows.filter((r) =>
      ['pending', 'weighing'].includes(r.status),
    ).length;
    const failed = rows.filter((r) => r.status === 'failed' || r.status === 'error').length;
    const sums = summarise(rows);

    return {
      date: day,
      total: rows.length,
      completed,
      pending,
      failed,
      grossTotal: sums.gross,
      tareTotal: sums.tare,
      netTotal: sums.net,
      transactions: rows,
      count: rows.length,
      rows,
      summary: sums,
    };
  },

  getDateRangeReport(from, to, filters = {}) {
    const merged = {
      ...filters,
      from: from || filters.from,
      to: to || filters.to,
    };
    const rows = queryTransactions(merged);
    return { rows, summary: summarise(rows), filters: merged };
  },

  getFilteredReport(filters = {}) {
    return this.getDateRangeReport(filters.from, filters.to, filters);
  },

  async exportCSV(filters = {}) {
    const rows = queryTransactions(filters);
    const lines = [CSV_HEADERS.map(escapeCsv).join(',')];
    for (const r of rows) {
      lines.push(
        [
          r.slip_number,
          r.truck_number,
          r.rfid_tag,
          r.gross_weight,
          r.tare_weight,
          r.net_weight,
          r.timestamp_in,
          r.timestamp_out,
          r.status,
          r.sync_status,
          r.operator_id || r.operator || '',
          r.image_path ? 'yes' : 'no',
          countCameraSnapshots(r),
        ]
          .map(escapeCsv)
          .join(','),
      );
    }

    const { year, month, day } = ts.parts();
    const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
    const filePath = path.join(dir, `report_${ts.fileSafe()}.csv`);
    fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
    logger.info('CSV export complete', { path: filePath, count: rows.length });
    return { ok: true, path: filePath, count: rows.length };
  },

  async exportPDF(filters = {}) {
    const rows = queryTransactions(filters);
    const summary = summarise(rows);
    const rowsHtml = rows
      .slice(0, 500)
      .map(
        (r) =>
          `<tr>
            <td>${r.slip_number || ''}</td>
            <td>${r.truck_number || ''}</td>
            <td>${r.net_weight ?? ''}</td>
            <td>${r.status}</td>
            <td>${r.sync_status}</td>
            <td>${ts.toDisplay(r.timestamp_in)}</td>
          </tr>`,
      )
      .join('');

    const html = `<!DOCTYPE html><html><head><meta charset="utf-8"></head>
    <body style="font-family:Arial;padding:24px;font-size:11px">
      <h1>Weighbridge Report</h1>
      <table border="1" cellpadding="5" cellspacing="0" width="100%">
        <thead><tr><th>Slip</th><th>Truck</th><th>Net kg</th><th>Status</th><th>Sync</th><th>Time</th></tr></thead>
        <tbody>${rowsHtml}</tbody>
        <tfoot><tr style="font-weight:bold;background:#eee">
          <td colspan="2">Summary (${summary.total} rows)</td>
          <td>${summary.net}</td>
          <td colspan="3">Gross ${summary.gross} · Tare ${summary.tare}</td>
        </tr></tfoot>
      </table>
    </body></html>`;

    if (!BrowserWindow) {
      return {
        ok: false,
        error: 'PDF export requires the desktop app (Electron). CSV export is available in server mode.',
      };
    }

    const win = new BrowserWindow({ show: false, webPreferences: { offscreen: true } });
    try {
      await win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      const pdf = await win.webContents.printToPDF({
        printBackground: true,
        paperWidth: 8.27,
        paperHeight: 11.69,
      });
      const { year, month, day } = ts.parts();
      const dir = ensureDir(path.join(PATHS.UPLOADS, year, month, day));
      const filePath = path.join(dir, `report_${ts.fileSafe()}.pdf`);
      fs.writeFileSync(filePath, pdf);
      return { ok: true, path: filePath, count: rows.length };
    } finally {
      win.destroy();
    }
  },

  getSyncSummary() {
    const db = getDb();
    const totalSynced = db
      .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE sync_status = 'synced'`)
      .get().c;
    const totalPending = db
      .prepare(
        `SELECT COUNT(*) AS c FROM transactions WHERE sync_status IN ('pending', 'retry')`,
      )
      .get().c;
    const totalFailed = db
      .prepare(`SELECT COUNT(*) AS c FROM transactions WHERE sync_status = 'failed'`)
      .get().c;
    const last = db
      .prepare(
        `SELECT MAX(timestamp_out) AS t FROM transactions WHERE sync_status = 'synced'`,
      )
      .get();
    return {
      totalSynced,
      totalPending,
      totalFailed,
      lastSyncAt: last?.t || null,
    };
  },

  getSlipPath(transactionId) {
    return PrintService.getSlipPath(transactionId);
  },

  async reprintSlip(transactionId) {
    return PrintService.reprintSlip(transactionId);
  },

  async printSlip(transactionId) {
    return this.reprintSlip(transactionId);
  },
};

module.exports = ReportService;
