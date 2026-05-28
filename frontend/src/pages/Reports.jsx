import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { reportAPI, syncAPI } from '../api/ipc.js';
import Badge from '../components/shared/Badge.jsx';
import { toMediaUrl } from '../lib/mediaUrl.js';

const PAGE_SIZE = 50;

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function syncVariant(s) {
  if (s === 'synced') return 'success';
  if (s === 'failed') return 'danger';
  if (s === 'pending' || s === 'retry') return 'warning';
  return 'default';
}

export default function Reports() {
  const [from, setFrom] = useState(todayISO());
  const [to, setTo] = useState(todayISO());
  const [status, setStatus] = useState('all');
  const [syncStatus, setSyncStatus] = useState('all');
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState({ total: 0, gross: 0, tare: 0, net: 0 });
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const [loading, setLoading] = useState(false);

  const filters = useMemo(
    () => ({
      from: `${from}T00:00:00.000Z`,
      to: `${to}T23:59:59.999Z`,
      status: status === 'all' ? undefined : status,
      sync_status: syncStatus === 'all' ? undefined : syncStatus,
    }),
    [from, to, status, syncStatus],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await reportAPI.getFilteredReport(filters);
      setRows(data?.rows || []);
      setSummary(data?.summary || { total: 0, gross: 0, tare: 0, net: 0 });
      setPage(0);
      setExpanded(null);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, [filters]);

  useEffect(() => {
    load();
  }, [load]);

  const pageCount = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  const pageRows = rows.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE);

  const tons = (kg) => ((kg || 0) / 1000).toFixed(2);

  return (
    <div className="flex flex-col gap-4">
      <header>
        <h1 className="text-2xl font-semibold text-white">Reports</h1>
        <p className="mt-1 text-sm text-slate-400">Filter, export, and reprint slips</p>
      </header>

      <section className="card p-4 flex flex-wrap gap-3 items-end">
        <label className="text-sm">
          <span className="text-slate-400 block mb-1">From</span>
          <input type="date" className="field-input" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-400 block mb-1">To</span>
          <input type="date" className="field-input" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        <label className="text-sm">
          <span className="text-slate-400 block mb-1">Status</span>
          <select className="field-input" value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="pending">Pending</option>
            <option value="weighing">Weighing</option>
            <option value="captured">Captured</option>
            <option value="printed">Printed</option>
            <option value="synced">Synced</option>
          </select>
        </label>
        <label className="text-sm">
          <span className="text-slate-400 block mb-1">Sync</span>
          <select className="field-input" value={syncStatus} onChange={(e) => setSyncStatus(e.target.value)}>
            <option value="all">All</option>
            <option value="synced">Synced</option>
            <option value="pending">Pending</option>
            <option value="retry">Retry</option>
            <option value="failed">Failed</option>
          </select>
        </label>
        <button type="button" className="btn-ghost" onClick={load} disabled={loading}>
          Refresh
        </button>
      </section>

      <section className="grid grid-cols-2 md:grid-cols-4 gap-3 text-sm">
        <SummaryCard label="Count" value={summary.total} />
        <SummaryCard label="Gross" value={`${summary.gross?.toLocaleString('en-IN')} kg (${tons(summary.gross)} t)`} />
        <SummaryCard label="Tare" value={`${summary.tare?.toLocaleString('en-IN')} kg (${tons(summary.tare)} t)`} />
        <SummaryCard label="Net" value={`${summary.net?.toLocaleString('en-IN')} kg (${tons(summary.net)} t)`} />
      </section>

      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-primary" onClick={() => reportAPI.exportCSV(filters)}>
          Export CSV
        </button>
        <button type="button" className="btn-ghost" onClick={() => reportAPI.exportPDF(filters)}>
          Export PDF
        </button>
      </div>

      <section className="card overflow-hidden">
        {loading ? (
          <p className="p-6 text-center text-slate-500">Loading…</p>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-slate-800 text-left text-xs uppercase tracking-wider text-slate-500">
                    <th className="px-4 py-3">Slip</th>
                    <th className="px-4 py-3">Truck</th>
                    <th className="px-4 py-3">RFID</th>
                    <th className="px-4 py-3">Gross</th>
                    <th className="px-4 py-3">Tare</th>
                    <th className="px-4 py-3">Net</th>
                    <th className="px-4 py-3">In</th>
                    <th className="px-4 py-3">Out</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Sync</th>
                    <th className="px-4 py-3">Img</th>
                    <th className="px-4 py-3" />
                  </tr>
                </thead>
                <tbody>
                  {pageRows.map((t) => (
                    <React.Fragment key={t.id}>
                      <tr
                        className="border-b border-slate-800/60 hover:bg-slate-800/30 cursor-pointer"
                        onClick={() => setExpanded(expanded === t.id ? null : t.id)}
                      >
                        <td className="px-4 py-2 font-mono">{t.slip_number}</td>
                        <td className="px-4 py-2">{t.truck_number}</td>
                        <td className="px-4 py-2 font-mono text-xs">{t.rfid_tag || '—'}</td>
                        <td className="px-4 py-2">{t.gross_weight ?? '—'}</td>
                        <td className="px-4 py-2">{t.tare_weight ?? '—'}</td>
                        <td className="px-4 py-2">{t.net_weight ?? '—'}</td>
                        <td className="px-4 py-2 text-xs whitespace-nowrap">{fmt(t.timestamp_in)}</td>
                        <td className="px-4 py-2 text-xs whitespace-nowrap">{fmt(t.timestamp_out)}</td>
                        <td className="px-4 py-2">
                          <Badge label={t.status} variant={t.status === 'synced' ? 'success' : 'default'} />
                        </td>
                        <td className="px-4 py-2">
                          <Badge label={t.sync_status} variant={syncVariant(t.sync_status)} />
                        </td>
                        <td className="px-4 py-2">{t.image_path ? '🖼' : '—'}</td>
                        <td className="px-4 py-2 space-x-1" onClick={(e) => e.stopPropagation()}>
                          <button type="button" className="text-xs text-brand-300" onClick={() => reportAPI.printSlip(t.id)}>
                            Reprint
                          </button>
                          {t.sync_status === 'failed' && (
                            <button
                              type="button"
                              className="text-xs text-amber-300"
                              onClick={() => syncAPI.triggerManualSync(t.id)}
                            >
                              Retry sync
                            </button>
                          )}
                        </td>
                      </tr>
                      {expanded === t.id && (
                        <tr className="bg-slate-900/80">
                          <td colSpan={12} className="px-4 py-4">
                            <div className="flex flex-wrap gap-6 text-sm">
                              <div className="space-y-1 min-w-[200px]">
                                <p><span className="text-slate-500">ID:</span> {t.id}</p>
                                <p><span className="text-slate-500">Owner:</span> {t.owner_name || '—'}</p>
                                <p><span className="text-slate-500">Transporter:</span> {t.transporter || '—'}</p>
                              </div>
                              {t.image_path && (
                                <img
                                  src={toMediaUrl(t.image_path)}
                                  alt="Slip"
                                  className="h-24 rounded border border-slate-700"
                                />
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="flex items-center justify-between border-t border-slate-800 px-4 py-3 text-sm text-slate-400">
              <span>
                Page {page + 1} of {pageCount} · {rows.length} rows
              </span>
              <div className="flex gap-2">
                <button type="button" className="btn-ghost text-xs py-1" disabled={page <= 0} onClick={() => setPage((p) => p - 1)}>
                  Previous
                </button>
                <button
                  type="button"
                  className="btn-ghost text-xs py-1"
                  disabled={page >= pageCount - 1}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </button>
              </div>
            </div>
          </>
        )}
      </section>
    </div>
  );
}

function SummaryCard({ label, value }) {
  return (
    <div className="card p-3">
      <p className="text-xs text-slate-500 uppercase">{label}</p>
      <p className="mt-1 text-white font-medium">{value}</p>
    </div>
  );
}

function fmt(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}
