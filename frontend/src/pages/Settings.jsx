import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  backupAPI,
  deviceAPI,
  reportAPI,
  settingsAPI,
  storageAPI,
  syncAPI,
  transactionAPI,
} from '../api/ipc.js';
import RfidPowerControl from '../components/settings/RfidPowerControl.jsx';

const IPV4 =
  /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?!$)|$)){4}$/;

function validateKey(key, value) {
  if (key === 'RFID_IP' && value && !IPV4.test(value)) {
    return 'Enter a valid IPv4 address';
  }
  if (key === 'RFID_PORT' && value) {
    const p = Number(value);
    if (!Number.isInteger(p) || p < 1 || p > 65535) return 'Port must be 1–65535';
  }
  if (key === 'CAMERA_RTSP_URL' && value && !value.startsWith('rtsp://')) {
    return 'URL must start with rtsp://';
  }
  return null;
}

const FIELDS = {
  hardware: [
    { key: 'RFID_IP', label: 'RFID IP', type: 'text', test: 'rfid' },
    { key: 'RFID_PORT', label: 'RFID Port', type: 'text', test: 'rfid' },
    { key: 'WEIGHBRIDGE_COM_PORT', label: 'Weighbridge COM Port', type: 'text', test: 'weighbridge' },
    {
      key: 'WEIGHBRIDGE_BAUD_RATE',
      label: 'Baud rate',
      type: 'select',
      options: ['2400', '4800', '9600', '19200', '38400'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_DATA_BITS',
      label: 'Data bits',
      type: 'select',
      options: ['7', '8'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_PARITY',
      label: 'Parity',
      type: 'select',
      options: ['none', 'even', 'odd'],
      test: 'weighbridge',
    },
    {
      key: 'WEIGHBRIDGE_STOP_BITS',
      label: 'Stop bits',
      type: 'select',
      options: ['1', '2'],
      test: 'weighbridge',
    },
    {
      key: 'CAMERA_RTSP_URLS',
      label: 'Camera IPs (comma-separated)',
      type: 'text',
      test: 'camera',
    },
    { key: 'CAMERA_RTSP_URL', label: 'Primary camera RTSP URL', type: 'text', test: 'camera' },
  ],
  cloud: [
    { key: 'CLOUD_SYNC_URL', label: 'Cloud API URL', type: 'text' },
    { key: 'CLOUD_SYNC_TOKEN', label: 'API Token', type: 'password' },
    {
      key: 'SYNC_INTERVAL_SECONDS',
      label: 'Sync interval',
      type: 'select',
      options: [
        { v: '30', l: '30 seconds' },
        { v: '60', l: '1 minute' },
        { v: '300', l: '5 minutes' },
      ],
    },
  ],
  app: [
    { key: 'USE_MOCK_HARDWARE', label: 'Simulator mode', type: 'toggle' },
    {
      key: 'LOG_LEVEL',
      label: 'Log level',
      type: 'select',
      options: ['info', 'warn', 'error', 'debug'],
    },
    { key: 'AUTO_BACKUP', label: 'Auto backup', type: 'toggle' },
    {
      key: 'BACKUP_INTERVAL_HOURS',
      label: 'Backup interval',
      type: 'select',
      options: [
        { v: '2', l: '2 hours' },
        { v: '4', l: '4 hours' },
        { v: '8', l: '8 hours' },
        { v: '24', l: '24 hours' },
      ],
    },
    { key: 'IMAGE_AUTO_CLEANUP', label: 'Auto image cleanup', type: 'toggle' },
    { key: 'IMAGE_RETENTION_DAYS', label: 'Delete images older than (days)', type: 'number' },
  ],
  printer: [
    { key: 'PRINTER_NAME', label: 'Default printer', type: 'text' },
    {
      key: 'PAPER_SIZE',
      label: 'Paper size',
      type: 'select',
      options: ['A4', 'Thermal 80mm'],
    },
  ],
};

export default function Settings() {
  const [values, setValues] = useState({});
  const [errors, setErrors] = useState({});
  const [saved, setSaved] = useState(false);
  const [tests, setTests] = useState({});
  const [showToken, setShowToken] = useState(false);
  const [queue, setQueue] = useState({ pending: 0 });
  const [backups, setBackups] = useState([]);
  const [lastBackup, setLastBackup] = useState(null);
  const [storage, setStorage] = useState(null);
  const [backupBusy, setBackupBusy] = useState(false);
  const [thermalQueue, setThermalQueue] = useState([]);
  const timers = useRef({});

  const refreshBackup = useCallback(async () => {
    const [list, last] = await Promise.all([
      backupAPI.getList(),
      backupAPI.getLastBackupTime(),
    ]);
    setBackups(Array.isArray(list) ? list : []);
    setLastBackup(last);
  }, []);

  const refreshStorage = useCallback(async () => {
    const stats = await storageAPI.getStorageStats();
    setStorage(stats);
    const tq = await storageAPI.listThermalQueue();
    setThermalQueue(Array.isArray(tq) ? tq : []);
  }, []);

  useEffect(() => {
    settingsAPI.getAll().then((all) => setValues(all || {})).catch(console.error);
    syncAPI.getQueueStatus().then(setQueue).catch(() => {});
    refreshBackup().catch(console.error);
    refreshStorage().catch(console.error);
  }, [refreshBackup, refreshStorage]);

  const scheduleSave = useCallback((key, value) => {
    const err = validateKey(key, value);
    if (err) {
      setErrors((e) => ({ ...e, [key]: err }));
      return;
    }
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });

    if (timers.current[key]) clearTimeout(timers.current[key]);
    timers.current[key] = setTimeout(async () => {
      try {
        await settingsAPI.set(key, value);
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } catch (e) {
        setErrors((er) => ({ ...er, [key]: e.message }));
      }
    }, 500);
  }, []);

  function update(key, value) {
    setValues((v) => ({ ...v, [key]: value }));
    scheduleSave(key, value);
  }

  async function testDevice(type) {
    setTests((t) => ({ ...t, [type]: 'loading' }));
    try {
      const r = await deviceAPI.testConnection(type);
      setTests((t) => ({ ...t, [type]: r?.ok ? 'ok' : 'fail' }));
    } catch {
      setTests((t) => ({ ...t, [type]: 'fail' }));
    }
  }

  return (
    <div className="flex flex-col gap-4 max-w-3xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Settings</h1>
          <p className="mt-1 text-sm text-slate-400">Hardware, cloud, and application preferences</p>
        </div>
        {saved && (
          <span className="text-xs text-emerald-400 border border-emerald-700/40 rounded-full px-3 py-1">
            Saved
          </span>
        )}
      </header>

      <Card title="Hardware configuration">
        {FIELDS.hardware.map((f) => (
          <React.Fragment key={f.key}>
            <SettingRow
              field={f}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => update(f.key, v)}
              testState={tests[f.test]}
              onTest={() => testDevice(f.test)}
              showTest={
                f.key === 'RFID_IP' ||
                f.key === 'WEIGHBRIDGE_COM_PORT' ||
                f.key === 'CAMERA_RTSP_URL' ||
                f.key === 'CAMERA_RTSP_URLS'
              }
            />
            {f.key === 'RFID_PORT' && (
              <RfidPowerControl
                mockMode={values.USE_MOCK_HARDWARE === 'true' || values.USE_MOCK_HARDWARE === true}
                savedPower={values.RFID_ANTENNA_POWER}
                onSaved={(v) => {
                  setValues((prev) => ({ ...prev, RFID_ANTENNA_POWER: v }));
                  setSaved(true);
                  setTimeout(() => setSaved(false), 2000);
                }}
              />
            )}
          </React.Fragment>
        ))}
      </Card>

      <Card title="Cloud sync">
        {FIELDS.cloud.map((f) => {
          if (f.key === 'CLOUD_SYNC_TOKEN') {
            return (
              <label key={f.key} className="block text-sm mb-3">
                <span className="text-slate-400">{f.label}</span>
                <div className="mt-1 flex gap-2">
                  <input
                    type={showToken ? 'text' : 'password'}
                    className="field-input flex-1"
                    value={values[f.key] ?? ''}
                    onChange={(e) => update(f.key, e.target.value)}
                  />
                  <button type="button" className="btn-ghost text-xs" onClick={() => setShowToken((s) => !s)}>
                    {showToken ? 'Hide' : 'Show'}
                  </button>
                </div>
                {errors[f.key] && <p className="text-xs text-red-400 mt-1">{errors[f.key]}</p>}
              </label>
            );
          }
          return (
            <SettingRow
              key={f.key}
              field={f}
              value={values[f.key] ?? ''}
              error={errors[f.key]}
              onChange={(v) => update(f.key, v)}
            />
          );
        })}
        <div className="flex items-center gap-3 mt-2 text-sm text-slate-400">
          <button type="button" className="btn-primary" onClick={() => syncAPI.triggerManualSync()}>
            Manual sync now
          </button>
          <span>Pending: {queue.pending ?? 0}</span>
        </div>
      </Card>

      <Card title="Application">
        {FIELDS.app.map((f) => (
          <SettingRow
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            error={errors[f.key]}
            onChange={(v) => update(f.key, v)}
          />
        ))}

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-3 text-sm">
          <p className="text-slate-400">
            Last backup:{' '}
            <span className="text-slate-200">
              {lastBackup ? new Date(lastBackup).toLocaleString('en-IN') : 'Never'}
            </span>
          </p>
          <button
            type="button"
            className="btn-primary"
            disabled={backupBusy}
            onClick={async () => {
              setBackupBusy(true);
              try {
                await backupAPI.manualBackup();
                await refreshBackup();
              } catch (e) {
                alert(e.message);
              } finally {
                setBackupBusy(false);
              }
            }}
          >
            {backupBusy ? 'Backing up…' : 'Backup now'}
          </button>
          {backups.length > 0 && (
            <ul className="max-h-32 overflow-auto rounded border border-slate-800 divide-y divide-slate-800">
              {backups.slice(0, 8).map((b) => (
                <li key={b.filename} className="flex justify-between px-3 py-2 text-xs">
                  <span className="font-mono text-slate-300">{b.filename}</span>
                  <span className="text-slate-500">
                    {formatBytes(b.size)} · {new Date(b.created_at).toLocaleDateString('en-IN')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="mt-4 pt-4 border-t border-slate-800 space-y-2 text-sm">
          <h3 className="text-slate-300 font-medium">Storage</h3>
          {storage && (
            <p className="text-slate-400">
              {storage.totalImages} images · {formatBytes(storage.totalSizeBytes)}
              {storage.oldestDate && (
                <span>
                  {' '}
                  · oldest {new Date(storage.oldestDate).toLocaleDateString('en-IN')}
                </span>
              )}
            </p>
          )}
          <button
            type="button"
            className="btn-ghost text-xs"
            onClick={async () => {
              const r = await storageAPI.runCleanup();
              alert(`Removed ${r.deleted} image(s)`);
              refreshStorage();
            }}
          >
            Run cleanup now
          </button>
        </div>

        {thermalQueue.length > 0 && (
          <div className="mt-4 pt-4 border-t border-slate-800">
            <h3 className="text-sm text-slate-300 font-medium mb-2">Thermal print queue</h3>
            <ul className="space-y-1 text-xs">
              {thermalQueue.map((f) => (
                <li key={f.filename} className="flex justify-between gap-2">
                  <span className="font-mono text-slate-400 truncate">{f.filename}</span>
                  <button
                    type="button"
                    className="text-brand-300 shrink-0"
                    onClick={() =>
                      storageAPI.resendThermal(f.filename).catch((e) => alert(e.message))
                    }
                  >
                    Resend
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Card>

      <Card title="Printer">
        {FIELDS.printer.map((f) => (
          <SettingRow
            key={f.key}
            field={f}
            value={values[f.key] ?? ''}
            error={errors[f.key]}
            onChange={(v) => update(f.key, v)}
          />
        ))}
        <button
          type="button"
          className="btn-ghost mt-2"
          onClick={async () => {
            try {
              const rows = await transactionAPI.getAll();
              const latest = rows?.[0];
              if (!latest) {
                alert('No transactions to print');
                return;
              }
              await reportAPI.reprintSlip(latest.id);
              alert('Test slip sent to printer queue');
            } catch (e) {
              alert(e.message);
            }
          }}
        >
          Print test slip
        </button>
      </Card>
    </div>
  );
}

function Card({ title, children }) {
  return (
    <section className="card p-5">
      <h2 className="text-sm font-semibold text-white mb-4">{title}</h2>
      {children}
    </section>
  );
}

function formatBytes(n) {
  if (!n) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function SettingRow({ field, value, error, onChange, onTest, testState, showTest }) {
  if (field.type === 'toggle') {
    return (
      <label className="flex items-center justify-between py-2 text-sm">
        <span className="text-slate-300">{field.label}</span>
        <input
          type="checkbox"
          checked={value === 'true' || value === true}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
      </label>
    );
  }

  return (
    <label className="block text-sm mb-3">
      <span className="text-slate-400">{field.label}</span>
      <div className="mt-1 flex gap-2 items-center">
        {field.type === 'select' ? (
          <select className="field-input flex-1" value={value} onChange={(e) => onChange(e.target.value)}>
            {(field.options || []).map((o) => {
              const opt = typeof o === 'string' ? { v: o, l: o } : o;
              return (
                <option key={opt.v} value={opt.v}>
                  {opt.l}
                </option>
              );
            })}
          </select>
        ) : (
          <input
            type={field.type === 'number' ? 'number' : field.type || 'text'}
            className="field-input flex-1"
            value={value}
            min={field.type === 'number' ? 1 : undefined}
            onChange={(e) => onChange(e.target.value)}
          />
        )}
        {showTest && onTest && (
          <button type="button" className="btn-ghost text-xs shrink-0" onClick={onTest}>
            Test
          </button>
        )}
        {testState === 'ok' && <span className="text-emerald-400">✓</span>}
        {testState === 'fail' && <span className="text-red-400">✕</span>}
      </div>
      {error && <p className="text-xs text-red-400 mt-1">{error}</p>}
    </label>
  );
}
