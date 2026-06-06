import React, { useEffect, useMemo, useRef, useState } from 'react';
import useDeviceStore from '../store/deviceStore.js';
import useTransactionStore from '../store/transactionStore.js';
import useThrottledValue from '../hooks/useThrottledValue.js';
import SimulatorPanel from '../components/simulator/SimulatorPanel.jsx';
import ConfirmModal from '../components/shared/ConfirmModal.jsx';
import Badge from '../components/shared/Badge.jsx';
import WebcamPreview from '../components/device/WebcamPreview.jsx';
import RtspPreview from '../components/device/RtspPreview.jsx';
import MultiRtspPreview from '../components/device/MultiRtspPreview.jsx';
import {
  deviceAPI,
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
  const rfid = useDeviceStore((s) => s.rfid);
  const rfidLocked = useDeviceStore((s) => s.rfid.locked);
  const workflowState = useTransactionStore((s) => s.workflowState);
  const activeTransaction = useTransactionStore((s) => s.activeTransaction);
  const timeline = useTransactionStore((s) => s.timeline);
  const lastEvent = useTransactionStore((s) => s.lastEvent);

  const kg = useThrottledValue(rawWeight, 100);
  const [vehicle, setVehicle] = useState(null);
  const [manualTruck, setManualTruck] = useState('');
  const [abortOpen, setAbortOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [printing, setPrinting] = useState(false);
  const [unknownTagLocked, setUnknownTagLocked] = useState(null);
  const [testConfig, setTestConfig] = useState(null);
  const [saving, setSaving] = useState(false);
  const [savedCaptureUrl, setSavedCaptureUrl] = useState(null);
  const [webcamReady, setWebcamReady] = useState(false);
  const [weighmentInfo, setWeighmentInfo] = useState(null);
  const [saveMessage, setSaveMessage] = useState(null);
  const webcamRef = useRef(null);

  const unknownTag =
    unknownTagLocked ||
    (lastEvent?.channel === 'workflow:unknownRFID' ? lastEvent.tag : null);
  const inProgress = workflowState !== 'IDLE' && workflowState !== 'ERROR';

  const openAwaitingLoad =
    activeTransaction &&
    workflowState === 'IDLE' &&
    activeTransaction.tare_weight != null &&
    activeTransaction.gross_weight == null;

  const canAbort =
    rfidLocked ||
    rfid.scanning ||
    workflowState === 'RFID_DETECTED' ||
    inProgress ||
    openAwaitingLoad;

  const abortLabel =
    openAwaitingLoad
      ? 'Cancel open ticket'
      : inProgress
        ? 'Abort transaction'
        : 'Cancel RFID scan';

  const currentPass =
    inProgress
      ? lastEvent?.pass ||
        (activeTransaction?.tare_weight == null ? 'TARE' : 'GROSS')
      : null;

  useEffect(() => {
    deviceAPI.getTestConfig().then(setTestConfig).catch(() => {});
    deviceAPI
      .syncRfid()
      .then((state) => {
        if (!state?.tag) return;
        if (!state.locked && !state.scanning) return;
        if (state.scanning != null) {
          useDeviceStore.getState().setRfidScanning(!!state.scanning);
        }
        useDeviceStore.getState().setLastRfidScan({
          tag: state.tag,
          tid: state.tid ?? null,
          rssi: state.rssi ?? null,
          antenna: state.antenna ?? null,
          readerName: state.readerName ?? null,
          timestamp: state.timestamp ?? new Date().toISOString(),
          locked: !!state.locked,
        });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    workflowAPI
      .getState()
      .then((state) => {
        if (state?.state === 'RFID_DETECTED' && state?.context?.rfidTag) {
          useDeviceStore.getState().lockRfid(state.context.rfidTag);
        }
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (lastEvent?.channel === 'workflow:unknownRFID' && lastEvent.tag) {
      setUnknownTagLocked(lastEvent.tag);
    }
  }, [lastEvent]);

  useEffect(() => {
    if (workflowState === 'VEHICLE_IDENTIFIED' || workflowState === 'AWAITING_WEIGHT') {
      setUnknownTagLocked(null);
    }
    if (workflowState === 'IDLE' && !rfidLocked) {
      setUnknownTagLocked(null);
    }
  }, [workflowState, rfidLocked]);

  const displayTag =
    rfidLocked && rfid.lockedTag ? rfid.lockedTag : rfid.lastTag;

  useEffect(() => {
    if (!displayTag) {
      setVehicle(null);
      return;
    }
    vehicleAPI
      .findByRFID(displayTag)
      .then((v) => setVehicle(v))
      .catch(() => setVehicle(null));
  }, [displayTag]);

  useEffect(() => {
    const truck =
      vehicle?.vehicle_number ||
      activeTransaction?.truck_number ||
      manualTruck.trim().toUpperCase() ||
      null;
    if (!truck) {
      setWeighmentInfo(null);
      return;
    }
    vehicleAPI
      .getWeighmentInfo(truck, displayTag || vehicle?.rfid_tag || null)
      .then(setWeighmentInfo)
      .catch(() => setWeighmentInfo(null));
  }, [
    vehicle?.vehicle_number,
    vehicle?.rfid_tag,
    activeTransaction?.truck_number,
    activeTransaction?.tare_weight,
    activeTransaction?.gross_weight,
    manualTruck,
    displayTag,
  ]);

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

  const weightColor = kg <= 0 ? 'text-slate-500' : 'text-white';

  const truckForSave =
    vehicle?.vehicle_number ||
    activeTransaction?.truck_number ||
    manualTruck.trim().toUpperCase() ||
    null;

  const testMode = testConfig?.useWebcamCamera || testConfig?.mockWeighbridge;
  const ticketStatus =
    weighmentInfo?.ticketStatus ||
    vehicle?.ticket_status ||
    (activeTransaction?.tare_weight != null && activeTransaction?.gross_weight == null
      ? 'open'
      : 'closed');
  const nextPass = ticketStatus === 'open' ? 'GROSS' : 'TARE';
  const canSaveTrip =
    rawWeight > 0 &&
    !!truckForSave &&
    (!testConfig?.useWebcamCamera || webcamReady);

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
      setUnknownTagLocked(null);
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
      setUnknownTagLocked(null);
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

  async function handleStartRfidScan() {
    try {
      useDeviceStore.getState().clearRfidScan();
      await deviceAPI.startRfidScan();
    } catch (err) {
      alert(err.message || 'Failed to start RFID scan');
    }
  }

  async function handleSaveTripCapture() {
    if (!truckForSave) {
      alert('Scan an RFID tag first (or enter truck number for unknown tags).');
      return;
    }
    const weightAtSave = Math.round(Number(rawWeight));
    if (!weightAtSave || weightAtSave <= 0) {
      alert('No weight reading available.');
      return;
    }
    setSaving(true);
    try {
      let payload = {
        weightKg: weightAtSave,
        truckNumber: truckForSave,
        rfidTag: displayTag || null,
        transactionId: activeTransaction?.id || null,
      };

      if (testConfig?.useWebcamCamera) {
        if (!webcamRef.current?.isReady?.()) {
          throw new Error('Webcam is not ready yet — allow camera access when prompted');
        }
        const imageBase64 = webcamRef.current.capture();
        payload = {
          ...payload,
          imageBase64,
        };
      }

      const result = await deviceAPI.saveTripCapture(payload);
      if (!result?.ok) {
        throw new Error(result?.error || 'Save failed');
      }
      if (result.imagePath) {
        setSavedCaptureUrl(toMediaUrl(result.imagePath));
      }
      if (result.transaction) {
        const store = useTransactionStore.getState();
        store.setActiveTransaction(result.transaction);
        store.updateTransaction(result.transaction);
        store.addTransaction(result.transaction);
        const passLabel = result.pass === 'TARE' ? 'Tare captured' : 'Gross captured';
        store.pushTimeline({
          step: passLabel,
          detail: `${weightAtSave} kg`,
        });

        if (result.pass === 'TARE') {
          setSaveMessage('Tare saved — ticket is now Open. Load truck and scan again for gross.');
          setSavedCaptureUrl(toMediaUrl(result.imagePath));
          useDeviceStore.getState().setRfidScanning(false);
          useDeviceStore.getState().clearRfidScan();
        } else if (result.pass === 'GROSS') {
          setSaveMessage(
            `Trip complete — ${result.tripNumber || result.transaction.slip_number}. Ticket closed with image.`,
          );
          setSavedCaptureUrl(toMediaUrl(result.imagePath));
          useDeviceStore.getState().clearRfidScan();
          setUnknownTagLocked(null);
          setTimeout(() => {
            setSavedCaptureUrl(null);
            setSaveMessage(null);
            setVehicle(null);
            setWeighmentInfo(null);
            useTransactionStore.getState().resetActive();
          }, 3000);
        }

        if (truckForSave) {
          vehicleAPI
            .findByNumber(truckForSave)
            .then((v) => {
              if (v) setVehicle(v);
              return vehicleAPI.getWeighmentInfo(truckForSave, displayTag || v?.rfid_tag);
            })
            .then((info) => info && setWeighmentInfo(info))
            .catch(() => {});
        }
      }
    } catch (err) {
      alert(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pb-8">
      <header>
        <h1 className="text-2xl font-semibold text-white">Weighment</h1>
        <p className="mt-1 text-sm text-slate-400">
          Start RFID scan → tag locks → live weight updates → press Save to capture weight, cameras, and timestamp
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
            <Badge label={kg > 0 ? 'LIVE' : 'NO SIGNAL'} variant={kg > 0 ? 'success' : 'warning'} />
          </div>

          <div className="card p-4">
            <div className="flex items-center justify-between mb-3">
              <h2 className="text-xs uppercase tracking-widest text-slate-400">RFID</h2>
              {rfidLocked && (
                <Badge label="Tag locked" variant="warning" />
              )}
            </div>
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
            ) : displayTag ? (
              <div className="rounded-lg bg-slate-800/60 p-3 text-sm space-y-2">
                {!rfidLocked && rfid.scanning && (
                  <p className="text-[10px] text-amber-400/90 uppercase tracking-widest">Scanning…</p>
                )}
                <div className="space-y-1">
                  <p className="text-[10px] uppercase tracking-widest text-slate-500">EPC</p>
                  <p className="font-mono text-brand-200 break-all">{displayTag}</p>
                </div>
                {rfid.lastScan?.tid && rfid.lastScan.tag === displayTag && (
                  <div className="space-y-1">
                    <p className="text-[10px] uppercase tracking-widest text-slate-500">TID</p>
                    <p className="font-mono text-xs text-slate-300 break-all">{rfid.lastScan.tid}</p>
                  </div>
                )}
                <div className="flex gap-4 text-xs text-slate-400">
                  {rfid.lastScan?.tag === displayTag && rfid.lastScan?.rssi != null && (
                    <span>RSSI: {rfid.lastScan.rssi}</span>
                  )}
                  {rfid.lastScan?.tag === displayTag && rfid.lastScan?.antenna != null && (
                    <span>Antenna: ANT{rfid.lastScan.antenna}</span>
                  )}
                </div>
                {vehicle && (
                  <>
                    <p className="text-white font-medium pt-1 border-t border-slate-700/50">
                      {vehicle.vehicle_number}
                    </p>
                    <p className="text-slate-400">Owner: {vehicle.owner_name || '—'}</p>
                    <p className="text-slate-400">Transporter: {vehicle.transporter || '—'}</p>
                  </>
                )}
              </div>
            ) : rfid.scanning ? (
              <p className="text-slate-500 text-sm">Scanning…</p>
            ) : (
              <div className="space-y-3">
                <p className="text-slate-500 text-sm">
                  Press <span className="text-slate-300 font-medium">Start RFID Scan</span> to read a tag.
                </p>
                {rfid.connected && !rfidLocked && (
                  <button
                    type="button"
                    className="btn-primary w-full"
                    onClick={handleStartRfidScan}
                  >
                    Start RFID Scan
                  </button>
                )}
                {!rfid.connected && (
                  <p className="text-xs text-slate-600">RFID reader not connected.</p>
                )}
              </div>
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
            <div
              className={`rounded-lg bg-slate-800 flex items-center justify-center overflow-hidden ${
                testConfig?.useRtspCamera && testConfig?.cameras?.length > 1 && !imageSrc
                  ? 'p-2'
                  : 'aspect-video'
              }`}
            >
              {testConfig?.useWebcamCamera ? (
                savedCaptureUrl ? (
                  <img src={savedCaptureUrl} alt="Saved capture" className="h-full w-full object-cover" />
                ) : (
                  <WebcamPreview
                    ref={webcamRef}
                    className="h-full w-full object-cover"
                    onReady={() => setWebcamReady(true)}
                  />
                )
              ) : testConfig?.useRtspCamera && !imageSrc ? (
                testConfig.cameras?.length > 0 ? (
                  <MultiRtspPreview cameras={testConfig.cameras} className="w-full" />
                ) : (
                  <RtspPreview className="h-full w-full object-cover" />
                )
              ) : imageSrc ? (
                <img src={imageSrc} alt="Vehicle" className="h-full w-full object-cover" />
              ) : inProgress ? (
                <span className="text-slate-500 text-sm">Live feed placeholder</span>
              ) : (
                <span className="text-slate-500 text-sm flex flex-col items-center gap-1">
                  <span className="text-2xl">📷</span> No image
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              Next:{' '}
              <span className={nextPass === 'TARE' ? 'text-amber-300' : 'text-emerald-300'}>
                {nextPass === 'TARE' ? 'Tare (ticket closed)' : 'Gross (ticket open)'}
              </span>
            </p>
            {testMode && (
              <p className="mt-2 text-xs text-slate-500">
                Test mode is enabled — save uses webcam snapshot if configured.
              </p>
            )}
            {!testConfig?.useWebcamCamera && (
              <p className="mt-2 text-xs text-slate-500">
                Save captures a snapshot from every configured camera and attaches them to the trip report.
              </p>
            )}
            {saveMessage && (
              <p className="mt-2 text-xs text-brand-300">{saveMessage}</p>
            )}
            {rfid.scanning && (
              <p className="mt-2 text-xs text-slate-500">Scanning will stop after save.</p>
            )}
            <button
              type="button"
              className="btn-primary mt-3 w-full disabled:opacity-40"
              disabled={!canSaveTrip || saving}
              onClick={handleSaveTripCapture}
            >
              {saving ? 'Saving…' : `Save ${nextPass === 'TARE' ? 'tare' : 'gross'} trip`}
            </button>
          </div>

          <div className="card p-4 text-sm space-y-2">
            <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-2">Transaction</h2>
            <Row label="Ticket" value={ticketStatus === 'open' ? 'Open' : 'Closed'} />
            <Row
              label="Trip"
              value={
                activeTransaction?.slip_number ||
                weighmentInfo?.trip ||
                vehicle?.trip ||
                '—'
              }
              mono
            />
            <Row label="ID" value={activeTransaction?.id || '—'} mono />
            <Row label="Slip" value={activeTransaction?.slip_number || weighmentInfo?.openSlip || '—'} mono />
            <Row label="Truck" value={activeTransaction?.truck_number || '—'} />
            <Row label="Time in" value={activeTransaction?.timestamp_in || '—'} />
            <Row label="Gross" value={fmtKg(activeTransaction?.gross_weight)} />
            <Row label="Tare" value={fmtKg(activeTransaction?.tare_weight)} />
            <Row label="Net" value={fmtKg(netWeight)} bold />
          </div>

          {(canAbort) && (
            <button type="button" className="btn-danger w-full" onClick={() => setAbortOpen(true)}>
              {abortLabel}
            </button>
          )}

          <SimulatorPanel embedded />
        </div>
      </div>

      <ConfirmModal
        open={abortOpen}
        title={inProgress || openAwaitingLoad ? 'Abort transaction?' : 'Cancel RFID scan?'}
        message={
          inProgress || openAwaitingLoad
            ? 'This will cancel the current weighment and reset the workflow.'
            : 'This will unlock the scanned RFID tag and allow a new scan.'
        }
        confirmLabel={inProgress || openAwaitingLoad ? 'Abort' : 'Cancel scan'}
        dangerous
        onCancel={() => setAbortOpen(false)}
        onConfirm={async () => {
          if (openAwaitingLoad && activeTransaction?.id) {
            await transactionAPI.updateStatus(activeTransaction.id, 'error');
          } else {
            await workflowAPI.abort();
          }
          try {
            await deviceAPI.stopRfidScan();
          } catch (_e) {
            /* ignore */
          }
          useTransactionStore.getState().resetActive();
          useDeviceStore.getState().clearRfidScan();
          setUnknownTagLocked(null);
          setManualTruck('');
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
