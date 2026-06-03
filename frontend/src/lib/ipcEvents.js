import useTransactionStore from '../store/transactionStore.js';
import useDeviceStore from '../store/deviceStore.js';
import { transactionAPI } from '../api/ipc.js';

let buffer = [];
let ready = false;

async function refreshStats() {
  try {
    const stats = await transactionAPI.getTodayStats();
    useTransactionStore.getState().setTodayStats(stats);
  } catch (_e) {
    /* ignore */
  }
}

async function refreshRecent() {
  try {
    const rows = await transactionAPI.getAll();
    useTransactionStore.getState().setRecentTransactions((rows || []).slice(0, 20));
  } catch (_e) {
    /* ignore */
  }
}

export function dispatchIpcEvent(channel, payload) {
  const tx = useTransactionStore.getState();
  const dev = useDeviceStore.getState();

  switch (channel) {
    case 'device:statusUpdate':
      dev.updateDeviceStatus(payload);
      break;

    case 'device:rfidScanState':
      dev.setRfidScanning(!!payload?.scanning);
      break;

    case 'device:rfidTag':
      if (payload?.tag) {
        dev.setLastRfidScan({
          tag: payload.tag,
          tid: payload.tid ?? null,
          rssi: payload.rssi ?? null,
          antenna: payload.antenna ?? null,
          readerName: payload.readerName ?? null,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          locked: true,
        });
      }
      break;

    case 'device:rfidLive':
      if (!dev.rfid.scanning) break;
      if (
        payload?.tag &&
        (!dev.rfid.locked || payload.tag === dev.rfid.lockedTag)
      ) {
        dev.setLastRfidScan({
          tag: payload.tag,
          tid: payload.tid ?? null,
          rssi: payload.rssi ?? null,
          antenna: payload.antenna ?? null,
          readerName: payload.readerName ?? null,
          timestamp: payload.timestamp ?? new Date().toISOString(),
          locked: dev.rfid.locked && payload.tag === dev.rfid.lockedTag,
        });
      }
      break;

    case 'device:weightUpdate':
      dev.updateWeight(payload?.weight ?? 0, !!payload?.isStable);
      if (tx.activeTransaction?.id) {
        tx.setLastEvent({ channel, ...payload });
      }
      break;

    case 'device:stableWeight':
      dev.updateWeight(payload?.weight ?? 0, true);
      break;

    case 'workflow:stateChange':
      tx.setWorkflowState(payload?.to || 'IDLE');
      tx.setLastEvent(payload);
      break;

    case 'workflow:transactionStarted':
      tx.setActiveTransaction(payload?.transaction);
      tx.setWorkflowState('AWAITING_WEIGHT');
      tx.clearTimeline();
      tx.pushTimeline({
        step: 'RFID Scanned (empty)',
        detail: payload?.transaction?.rfid_tag,
      });
      tx.pushTimeline({ step: 'Vehicle Identified', detail: payload?.transaction?.truck_number });
      tx.pushTimeline({ step: 'Awaiting tare weight', detail: payload?.message });
      if (payload?.transaction) tx.addTransaction(payload.transaction);
      tx.setLastEvent(payload);
      break;

    case 'workflow:transactionResumed':
      tx.setActiveTransaction(payload?.transaction);
      tx.setWorkflowState('AWAITING_WEIGHT');
      if (payload?.pass === 'GROSS') {
        tx.pushTimeline({ step: 'RFID Scanned (loaded)', detail: payload?.message });
        tx.pushTimeline({ step: 'Awaiting gross weight' });
      } else {
        tx.pushTimeline({ step: 'Resume tare capture' });
      }
      tx.setLastEvent(payload);
      break;

    case 'workflow:tareComplete':
      dev.unlockRfid();
      if (payload?.transaction) {
        tx.updateTransaction(payload.transaction);
        tx.setActiveTransaction(payload.transaction);
      }
      tx.pushTimeline({ step: 'Tare captured', detail: 'Ticket open' });
      tx.pushTimeline({ step: 'Image Captured (empty)' });
      tx.setWorkflowState('IDLE');
      tx.setLastEvent(payload);
      refreshStats();
      refreshRecent();
      break;

    case 'workflow:weightUpdate':
      if (payload?.isStable) {
        const label =
          payload.pass === 'TARE' ? 'Tare weight captured' : 'Gross weight captured';
        tx.pushTimeline({ step: label, detail: `${payload.weight} kg` });
        if (tx.activeTransaction?.id === payload.transactionId) {
          const patch = { ...tx.activeTransaction };
          if (payload.pass === 'TARE') patch.tare_weight = payload.weight;
          else patch.gross_weight = payload.weight;
          tx.updateTransaction(patch);
        }
      }
      tx.setLastEvent(payload);
      break;

    case 'workflow:imageCaptured':
      if (payload?.transactionId && tx.activeTransaction) {
        tx.updateTransaction({
          ...tx.activeTransaction,
          image_path: payload.imagePath,
        });
      }
      tx.pushTimeline({ step: 'Image Captured' });
      tx.setLastEvent(payload);
      break;

    case 'workflow:imageMissing':
      tx.pushTimeline({ step: 'Image Captured', detail: 'No image' });
      tx.setLastEvent(payload);
      break;

    case 'workflow:complete':
      dev.clearRfidScan();
      if (payload?.transaction) {
        tx.setActiveTransaction(payload.transaction);
        tx.updateTransaction(payload.transaction);
        tx.addTransaction(payload.transaction);
      }
      tx.pushTimeline({ step: 'Slip Printed' });
      tx.pushTimeline({ step: 'Synced', detail: 'Queued' });
      refreshStats();
      refreshRecent();
      tx.setLastEvent(payload);
      setTimeout(() => tx.resetActive(), 1500);
      break;

    case 'workflow:reset':
      if (payload?.clearRfid) {
        dev.clearRfidScan();
      }
      tx.resetActive();
      break;

    case 'workflow:unknownRFID':
      if (payload?.tag) {
        dev.lockRfid(payload.tag, {
          tag: payload.tag,
          timestamp: new Date().toISOString(),
        });
      }
      tx.setWorkflowState('RFID_DETECTED');
      tx.setLastEvent(payload);
      break;

    case 'workflow:duplicateTransaction':
      tx.setLastEvent(payload);
      break;

    case 'workflow:error':
      tx.setWorkflowState('ERROR');
      tx.setLastEvent(payload);
      break;

    default:
      tx.setLastEvent({ channel, ...payload });
      break;
  }
}

export function flushIpcBuffer() {
  ready = true;
  const pending = [...buffer];
  buffer = [];
  pending.forEach(({ channel, payload }) => dispatchIpcEvent(channel, payload));
}

export function queueIpcEvent(channel, payload) {
  if (!ready) {
    buffer.push({ channel, payload });
    return;
  }
  dispatchIpcEvent(channel, payload);
}

export const WORKFLOW_CHANNELS = [
  'workflow:stateChange',
  'workflow:transactionStarted',
  'workflow:transactionResumed',
  'workflow:tareComplete',
  'workflow:weightUpdate',
  'workflow:imageCaptured',
  'workflow:imageMissing',
  'workflow:complete',
  'workflow:error',
  'workflow:unknownRFID',
  'workflow:duplicateTransaction',
  'workflow:printFailed',
  'workflow:weighmentTimeout',
  'workflow:weightBelowThreshold',
  'workflow:reset',
  'workflow:orphanedTransactions',
];

export const DEVICE_CHANNELS = [
  'device:statusUpdate',
  'device:rfidScanState',
  'device:rfidTag',
  'device:rfidLive',
  'device:weightUpdate',
  'device:stableWeight',
  'device:weightZero',
  'device:cameraCapture',
  'device:cameraFrame',
];
