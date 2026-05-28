import React, { useEffect, useMemo, useState } from 'react';
import useDeviceStore from '../store/deviceStore.js';
import useTransactionStore from '../store/transactionStore.js';
import useThrottledValue from '../hooks/useThrottledValue.js';
import SimulatorPanel from '../components/simulator/SimulatorPanel.jsx';
import ConfirmModal from '../components/shared/ConfirmModal.jsx';
import Badge from '../components/shared/Badge.jsx';
import {
  reportAPI,
  transactionAPI,
  vehicleAPI,
  workflowAPI,
} from '../api/ipc.js';
import { toMediaUrl } from '../lib/mediaUrl.js';

const TIMELINE_FALLBACK = [
  'RFID Scanned (empty)',
  'Tare captured',
  'RFID Scanned (loaded)',
  'Gross captured',
  'Image Captured',
  'Slip Printed',
  'Synced',
];

export default function WeighmentScreen() {
  const rawWeight = useDeviceStore((s) => s.displayWeight);
  const isStable = useDeviceStore((s) => s.displayStable);
  const rfid = useDeviceStore((s) => s.rfid);
  const workflowState = useTransactionStore((s) => s.workflowState);
  const activeTransaction = useTransactionStore((s) => s.activeTransaction);
  const timeline = useTransactionStore((s) => s.timeline);
  const lastEvent = useTransactionStore((s) => s.lastEvent);

  const kg = useThrottledValue(rawWeight, 250);
  const [vehicle, setVehicle] = useState(null);
  const [manualTruck, setManualTruck] = useState('');
  const [abortOpen, setAbortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [printing, setPrinting] = useState(false);

  const unknownTag =
    lastEvent?.channel === 'workflow:unknownRFID' ? lastEvent.tag : null;
  const inProgress = workflowState !== 'IDLE' && workflowState !== 'ERROR';

  const openAwaitingLoad =
    activeTransaction &&
    workflowState === 'IDLE' &&
    activeTransaction.tare_weight != null &&
    activeTransaction.gross_weight == null;

  const currentPass =
    inProgress
      ? lastEvent?.pass ||
        (activeTransaction?.tare_weight == null ? 'TARE' : 'GROSS')
      : null;

  useEffect(() => {
    if (!rfid.lastTag) return;
    vehicleAPI
      .findByRFID(rfid.lastTag)
      .then((v) => setVehicle(v))
      .catch(() => setVehicle(null));
  }, [rfid.lastTag]);

  useEffect(() => {
    if (activeTransaction?.truck_number) {
      vehicleAPI
        .findByNumber(activeTransaction.truck_number)
        .then((v) => setVehicle(v))
        .catch(() => {});
    }
  }, [activeTransaction?.truck_number]);

  const imageSrc = useMemo(() => {
    if (!activeTransaction) return null;
    if (activeTransaction.gross_weight != null && activeTransaction.image_path) {
      return toMediaUrl(activeTransaction.image_path);
    }
    return toMediaUrl(
      activeTransaction.tare_image_path || activeTransaction.image_path,
    );
  }, [
    activeTransaction?.image_path,
    activeTransaction?.tare_image_path,
    activeTransaction?.gross_weight,
  ]);

  const completedSteps = new Set(timeline.map((t) => t.step));
  const netWeight = useMemo(() => {
    const g = activeTransaction?.gross_weight;
    const t = activeTransaction?.tare_weight;
    if (g == null) return null;
    if (t == null) return g;
    return g - t;
  }, [activeTransaction]);

  const canPrint =
    activeTransaction &&
    ['captured', 'printed', 'synced'].includes(activeTransaction.status);

  const weightColor =
    kg <= 0 ? 'text-slate-500' : isStable ? 'text-emerald-400' : 'text-amber-400';

  async function handleManualSubmit() {
    const truck = manualTruck.trim().toUpperCase();
    if (!truck) return;
    try {
      const existing = await vehicleAPI.findByNumber(truck);
      if (!existing) {
        setCreateOpen(true);
        return;
      }
      await workflowAPI.acceptManualEntry(truck);
      setManualTruck('');
    } catch (err) {
      alert(err.message);
    }
  }

  async function confirmCreateVehicle() {
    const truck = manualTruck.trim().toUpperCase();
    try {
      await vehicleAPI.create({
        vehicle_number: truck,
        rfid_tag: unknownTag || rfid.lastTag || null,
        owner_name: 'Unknown',
        vehicle_type: 'truck',
      });
      await workflowAPI.acceptManualEntry(truck);
      setCreateOpen(false);
      setManualTruck('');
    } catch (err) {
      alert(err.message);
    }
  }

  async function handlePrint() {
    if (!activeTransaction?.id) return;
    setPrinting(true);
    try {
      await reportAPI.printSlip(activeTransaction.id);
    } catch (err) {
      alert(err.message);
    } finally {
      setPrinting(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      <header>
        <h1 className="text-2xl font-semibold text-white">Weighment</h1>
        <p className="mt-1 text-sm text-slate-400">
          Two-pass flow: RFID (empty) → tare · RFID (loaded) → gross · close ticket
        </p>
        {currentPass === 'TARE' && (
          <p className="mt-2 text-sm text-amber-300">Pass 1 — Empty truck (tare weight)</p>
        )}
        {currentPass === 'GROSS' && (
          <p className="mt-2 text-sm text-emerald-300">Pass 2 — Loaded truck (gross weight)</p>
        )}
        {openAwaitingLoad && (
          <p className="mt-2 text-sm text-brand-300">
            Ticket {activeTransaction.slip_number} open — load truck and scan RFID again
          </p>
        )}
      </header>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="lg:col-span-2 flex flex-col gap-4">
          <div className="card p-8 flex flex-col items-center">
            <p className="text-xs uppercase tracking-widest text-slate-400">Live weight</p>
            <p className={`mt-2 font-mono font-bold leading-none ${weightColor}`} style={{ fontSize: 72 }}>
              {Number(kg).toLocaleString('en-IN')}
              <span className="text-2xl ml-2 text-slate-500">kg</span>
            </p>
            <Badge
              label={isStable && kg > 0 ? 'STABLE' : 'UNSTABLE'}
              variant={isStable && kg > 0 ? 'success' : 'warning'}
            />
          </div>

          <div className="card p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">RFID</h2>
            {unknownTag ? (
              <div className="rounded-lg border border-red-700/50 bg-red-950/30 p-3">
                <p className="text-sm text-red-200">Unknown RFID tag</p>
                <p className="font-mono text-xs text-red-300 mt-1">{unknownTag}</p>
                <div className="mt-3 flex gap-2">
                  <input
                    type="text"
                    value={manualTruck}
                    onChange={(e) => setManualTruck(e.target.value.toUpperCase())}
                    placeholder="Enter truck number"
                    className="field-input flex-1"
                  />
                  <button type="button" className="btn-primary" onClick={handleManualSubmit}>
                    Continue
                  </button>
                </div>
              </div>
            ) : rfid.lastTag && vehicle ? (
              <div className="rounded-lg bg-slate-800/60 p-3 text-sm space-y-1">
                <p className="font-mono text-brand-200">{rfid.lastTag}</p>
                <p className="text-white font-medium">{vehicle.vehicle_number}</p>
                <p className="text-slate-400">Owner: {vehicle.owner_name || '—'}</p>
                <p className="text-slate-400">Transporter: {vehicle.transporter || '—'}</p>
              </div>
            ) : (
              <p className="text-slate-500 text-sm">Waiting for RFID…</p>
            )}
          </div>

          <div className="card p-4">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">Progress</h2>
            <ul className="space-y-2">
              {(timeline.length > 0 ? timeline : []).map((entry, i) => (
                <li key={`${entry.step}-${i}`} className="flex justify-between text-sm">
                  <span className="text-emerald-300">{entry.step}</span>
                  <span className="text-xs font-mono text-slate-500">
                    {entry.at ? new Date(entry.at).toLocaleTimeString('en-IN') : '—'}
                  </span>
                </li>
              ))}
              {timeline.length === 0 && (
                <li className="text-slate-500 text-sm">Waiting for workflow events…</li>
              )}
            </ul>
            <button
              type="button"
              className="btn-primary mt-4 w-full disabled:opacity-40"
              disabled={!canPrint || printing}
              onClick={handlePrint}
            >
              {printing ? 'Printing…' : 'Print slip'}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <div className="card p-3">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Capture</h2>
            <div className="aspect-video rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden">
              {imageSrc ? (
                <img src={imageSrc} alt="Vehicle" className="h-full w-full object-cover" />
              ) : inProgress ? (
                <span className="text-slate-500 text-sm">Live feed placeholder</span>
              ) : (
                <span className="text-slate-500 text-sm flex flex-col items-center gap-1">
                  <span className="text-2xl">📷</span> No image
                </span>
              )}
            </div>
          </div>

          <div className="card p-4 text-sm space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Transaction</h2>
            <Row label="ID" value={activeTransaction?.id || '—'} mono />
            <Row label="Slip" value={activeTransaction?.slip_number || '—'} mono />
            <Row label="Truck" value={activeTransaction?.truck_number || '—'} />
            <Row label="Time in" value={activeTransaction?.timestamp_in || '—'} />
            <Row label="Gross" value={fmtKg(activeTransaction?.gross_weight)} />
            <Row label="Tare" value={fmtKg(activeTransaction?.tare_weight)} />
            <Row label="Net" value={fmtKg(netWeight)} bold />
          </div>

          {(inProgress || openAwaitingLoad) && (
            <button type="button" className="btn-danger w-full" onClick={() => setAbortOpen(true)}>
              {openAwaitingLoad ? 'Cancel open ticket' : 'Abort transaction'}
            </button>
          )}

          <SimulatorPanel embedded />
        </div>
      </div>

      <ConfirmModal
        open={abortOpen}
        title="Abort transaction?"
        message="This will cancel the current weighment and reset the workflow."
        confirmLabel="Abort"
        dangerous
        onCancel={() => setAbortOpen(false)}
        onConfirm={async () => {
          if (openAwaitingLoad && activeTransaction?.id) {
            await transactionAPI.updateStatus(activeTransaction.id, 'error');
          } else {
            await workflowAPI.abort();
          }
          useTransactionStore.getState().resetActive();
          setAbortOpen(false);
        }}
      />

      <ConfirmModal
        open={createOpen}
        title="Create vehicle profile?"
        message={`No vehicle record for "${manualTruck}". Create a minimal vehicle profile?`}
        confirmLabel="Create & continue"
        onCancel={() => setCreateOpen(false)}
        onConfirm={confirmCreateVehicle}
      />
    </div>
  );
}

function Row({ label, value, mono, bold }) {
  return (
    <div className="flex justify-between gap-2">
      <span className="text-slate-500">{label}</span>
      <span className={`${mono ? 'font-mono text-xs' : ''} ${bold ? 'text-white font-semibold' : 'text-slate-200'}`}>
        {value}
      </span>
    </div>
  );
}

function fmtKg(v) {
  if (v == null || Number.isNaN(v)) return '—';
  return `${Number(v).toLocaleString('en-IN')} kg`;
}
