'use strict';

const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database/db');
const ts = require('../utils/timestamp');
const logger = require('../utils/logger');
const {
  TRANSACTION_STATUS,
  SYNC_STATUS,
} = require('../utils/constants');

const OPEN_STATUSES = [TRANSACTION_STATUS.PENDING, TRANSACTION_STATUS.WEIGHING];

function rowToTransaction(row) {
  if (!row) return null;
  const { vehicle_number_join, owner_name, transporter, vehicle_type, ...txn } =
    row;
  const result = { ...txn };
  if (vehicle_number_join || owner_name) {
    result.vehicle = {
      vehicle_number: vehicle_number_join || null,
      owner_name: owner_name || null,
      transporter: transporter || null,
      vehicle_type: vehicle_type || null,
    };
  }
  return result;
}

const SELECT_WITH_VEHICLE = `
  SELECT
    t.*,
    v.vehicle_number AS vehicle_number_join,
    v.owner_name,
    v.transporter,
    v.vehicle_type
  FROM transactions t
  LEFT JOIN vehicles v ON (
    v.vehicle_number = t.truck_number
    OR (t.rfid_tag IS NOT NULL AND v.rfid_tag = t.rfid_tag)
  )
`;

const TransactionService = {
  generateSlipNumber() {
    const db = getDb();
    const allocate = db.transaction(() => {
      const row = db
        .prepare(
          'SELECT id, prefix, current_value FROM slip_counter ORDER BY id LIMIT 1',
        )
        .get();
      if (!row) {
        throw new Error('slip_counter is not initialised — run database seed');
      }
      const nextValue = row.current_value + 1;
      const now = ts.now();
      db.prepare(
        'UPDATE slip_counter SET current_value = ?, updated_at = ? WHERE id = ?',
      ).run(nextValue, now, row.id);
      return `${row.prefix}-${nextValue}`;
    });
    return allocate();
  },

  findOpenByTruck(truckNumber) {
    if (!truckNumber) return null;
    const normalized = String(truckNumber).trim().toUpperCase();
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    return rowToTransaction(
      getDb()
        .prepare(
          `${SELECT_WITH_VEHICLE}
           WHERE t.truck_number = ?
             AND t.status IN (${placeholders})
           ORDER BY t.created_at DESC
           LIMIT 1`,
        )
        .get(normalized, ...OPEN_STATUSES),
    );
  },

  findOpenByRFID(rfidTag) {
    if (!rfidTag) return null;
    const placeholders = OPEN_STATUSES.map(() => '?').join(', ');
    return rowToTransaction(
      getDb()
        .prepare(
          `${SELECT_WITH_VEHICLE}
           WHERE t.rfid_tag = ?
             AND t.status IN (${placeholders})
           ORDER BY t.created_at DESC
           LIMIT 1`,
        )
        .get(String(rfidTag).trim(), ...OPEN_STATUSES),
    );
  },

  findOpenForVehicle(truckNumber, rfidTag) {
    return (
      this.findOpenByTruck(truckNumber) ||
      (rfidTag ? this.findOpenByRFID(rfidTag) : null)
    );
  },

  create(data) {
    const db = getDb();
    const truckNumber = String(data.truck_number || '')
      .trim()
      .toUpperCase();
    if (!truckNumber) {
      throw new Error('truck_number is required');
    }

    const existing = this.findOpenByTruck(truckNumber);
    if (existing) {
      return {
        isDuplicate: true,
        existingId: existing.id,
        transaction: existing,
      };
    }

    const grossWeight =
      data.gross_weight !== undefined && data.gross_weight !== null
        ? Number(data.gross_weight)
        : null;
    const tareWeight =
      data.tare_weight !== undefined && data.tare_weight !== null
        ? Number(data.tare_weight)
        : null;

    let status = data.status || TRANSACTION_STATUS.PENDING;
    if (
      grossWeight !== null &&
      tareWeight !== null &&
      !Number.isNaN(grossWeight) &&
      !Number.isNaN(tareWeight) &&
      grossWeight < tareWeight
    ) {
      status = TRANSACTION_STATUS.ERROR;
      logger.warn('Transaction net weight would be negative — flagged as error', {
        truck_number: truckNumber,
        gross_weight: grossWeight,
        tare_weight: tareWeight,
      });
    }

    const id = uuidv4();
    const now = ts.now();
    const slipNumber = data.slip_number || this.generateSlipNumber();
    const syncStatus = data.sync_status || SYNC_STATUS.PENDING;

    const insert = db.transaction(() => {
      db.prepare(
        `INSERT INTO transactions (
          id, truck_number, rfid_tag, gross_weight, tare_weight,
          timestamp_in, timestamp_out, image_path, operator_id,
          slip_number, sync_status, status, notes, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        truckNumber,
        data.rfid_tag || null,
        grossWeight,
        tareWeight,
        data.timestamp_in || now,
        data.timestamp_out || null,
        data.image_path || null,
        data.operator_id || null,
        slipNumber,
        syncStatus,
        status,
        data.notes || null,
        now,
        now,
      );
    });

    insert();
    return { isDuplicate: false, transaction: this.getById(id) };
  },

  updateFields(id, fields = {}) {
    const existing = this.getById(id);
    if (!existing) throw new Error(`Transaction not found: ${id}`);

    const allowed = [
      'gross_weight',
      'tare_weight',
      'image_path',
      'tare_image_path',
      'timestamp_out',
      'status',
      'sync_status',
      'operator_id',
      'notes',
    ];
    const sets = [];
    const params = [];

    for (const key of allowed) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
      }
    }

    if (!sets.length) return existing;

    const now = ts.now();
    sets.push('updated_at = ?');
    params.push(now, id);

    getDb()
      .prepare(`UPDATE transactions SET ${sets.join(', ')} WHERE id = ?`)
      .run(...params);

    return this.getById(id);
  },

  getAll(filters = {}) {
    const db = getDb();
    const clauses = [];
    const params = [];

    if (filters.date) {
      clauses.push('DATE(t.timestamp_in) = DATE(?)');
      params.push(filters.date);
    }
    if (filters.status) {
      clauses.push('t.status = ?');
      params.push(filters.status);
    }
    if (filters.truck_number) {
      clauses.push('UPPER(t.truck_number) = ?');
      params.push(String(filters.truck_number).trim().toUpperCase());
    }
    if (filters.sync_status) {
      clauses.push('t.sync_status = ?');
      params.push(filters.sync_status);
    }

    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    return db
      .prepare(
        `${SELECT_WITH_VEHICLE}
         ${where}
         ORDER BY t.timestamp_in DESC`,
      )
      .all(...params)
      .map(rowToTransaction);
  },

  getById(id) {
    return rowToTransaction(
      getDb()
        .prepare(`${SELECT_WITH_VEHICLE} WHERE t.id = ?`)
        .get(id),
    );
  },

  updateStatus(id, status) {
    return this.updateFields(id, { status });
  },

  getOrphanedCaptured() {
    return getDb()
      .prepare(
        `${SELECT_WITH_VEHICLE}
         WHERE t.status = 'captured'`,
      )
      .all()
      .map(rowToTransaction);
  },

  getTodayStats() {
    const start = ts.todayStart();
    const end = ts.todayEnd();
    const db = getDb();

    const total = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE timestamp_in >= ? AND timestamp_in <= ?`,
      )
      .get(start, end).count;

    const pending = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE timestamp_in >= ? AND timestamp_in <= ?
           AND status IN ('pending', 'weighing')`,
      )
      .get(start, end).count;

    const completed = db
      .prepare(
        `SELECT COUNT(*) AS count FROM transactions
         WHERE timestamp_in >= ? AND timestamp_in <= ?
           AND status IN ('printed', 'synced', 'captured')`,
      )
      .get(start, end).count;

    const weightRow = db
      .prepare(
        `SELECT COALESCE(SUM(net_weight), 0) AS totalWeight FROM transactions
         WHERE timestamp_in >= ? AND timestamp_in <= ?
           AND gross_weight IS NOT NULL AND tare_weight IS NOT NULL`,
      )
      .get(start, end);

    return {
      total,
      pending,
      completed,
      totalWeight: weightRow.totalWeight || 0,
    };
  },

  getUnsyncedTransactions() {
    return getDb()
      .prepare(
        `${SELECT_WITH_VEHICLE}
         WHERE t.sync_status IN ('pending', 'retry')
         ORDER BY t.timestamp_in ASC`,
      )
      .all()
      .map(rowToTransaction);
  },

  markSynced(id) {
    const now = ts.now();
    const db = getDb();
    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET sync_status = ?, status = ?, updated_at = ?
         WHERE id = ?`,
      ).run(SYNC_STATUS.SYNCED, TRANSACTION_STATUS.SYNCED, now, id);

      db.prepare('DELETE FROM sync_queue WHERE transaction_id = ?').run(id);
    });
    apply();
    return this.getById(id);
  },

  markSyncFailed(id, errorMessage) {
    const now = ts.now();
    const db = getDb();

    const apply = db.transaction(() => {
      db.prepare(
        `UPDATE transactions SET sync_status = ?, updated_at = ? WHERE id = ?`,
      ).run(SYNC_STATUS.FAILED, now, id);

      const existing = db
        .prepare('SELECT id, retry_count FROM sync_queue WHERE transaction_id = ?')
        .get(id);

      if (existing) {
        db.prepare(
          `UPDATE sync_queue SET
            sync_status = ?,
            retry_count = retry_count + 1,
            last_attempt = ?,
            error_message = ?
           WHERE transaction_id = ?`,
        ).run(SYNC_STATUS.RETRY, now, errorMessage || null, id);
      } else {
        db.prepare(
          `INSERT INTO sync_queue (transaction_id, retry_count, sync_status, last_attempt, error_message, created_at)
           VALUES (?, 1, ?, ?, ?, ?)`,
        ).run(id, SYNC_STATUS.RETRY, now, errorMessage || null, now);
      }
    });

    apply();
    return this.getById(id);
  },
};

module.exports = TransactionService;
