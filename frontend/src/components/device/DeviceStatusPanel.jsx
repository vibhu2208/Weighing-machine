import React from 'react';
import useDeviceStore from '../../store/deviceStore.js';
import StatusDot from '../shared/StatusDot.jsx';

const ROWS = [
  { key: 'rfid', label: 'RFID Reader' },
  { key: 'weighbridge', label: 'Weighbridge' },
  { key: 'camera', label: 'Camera' },
  { key: 'cloud', label: 'Cloud Sync' },
];

function dotFor(key, devices) {
  const d = devices[key];
  if (!d) return 'disconnected';
  if (key === 'cloud') return d.connected ? 'connected' : 'waiting';
  return d.connected ? 'connected' : 'disconnected';
}

function formatLastSeen(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return '—';
  }
}

export default function DeviceStatusPanel() {
  const devices = useDeviceStore();

  return (
    <div className="card p-4 h-full">
      <h2 className="text-xs uppercase tracking-widest text-slate-400 mb-3">
        Device Status
      </h2>
      <ul className="space-y-3 text-sm">
        {ROWS.map(({ key, label }) => {
          const dev = devices[key] || {};
          return (
            <li key={key} className="flex items-center justify-between gap-2">
              <div>
                <div className="text-slate-200">{label}</div>
                <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                  {key === 'weighbridge' && dev.connected && (
                    <span>
                      {Number(dev.currentWeight || 0).toLocaleString('en-IN')} kg
                      {dev.isStable ? ' · stable' : ' · unstable'}
                    </span>
                  )}
                  {key === 'rfid' && dev.lastTag && (
                    <span className="truncate max-w-[140px] inline-block">
                      {dev.lastTag}
                    </span>
                  )}
                  {key === 'cloud' && (
                    <span>pending: {dev.pendingCount ?? 0}</span>
                  )}
                </div>
              </div>
              <div className="text-right shrink-0">
                <StatusDot status={dotFor(key, devices)} />
                <div className="text-[10px] text-slate-500 mt-0.5">
                  {formatLastSeen(dev.lastSeen || dev.lastSync)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
