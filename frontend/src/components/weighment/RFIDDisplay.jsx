import React from 'react';

export default function RFIDDisplay({ tagId, vehicle }) {
  return (
    <div className="card p-4">
      <div className="text-xs uppercase tracking-widest text-slate-400">
        RFID
      </div>
      <div className="mt-1 font-mono text-lg text-white">
        {tagId || '— waiting —'}
      </div>
      {vehicle && (
        <div className="mt-1 text-xs text-slate-400">{vehicle.number}</div>
      )}
    </div>
  );
}
