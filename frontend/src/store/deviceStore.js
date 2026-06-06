import { create } from 'zustand';

const defaultDevices = () => ({
  rfid: {
    connected: false,
    scanning: false,
    lastTag: null,
    lastScan: null,
    lastSeen: null,
    locked: false,
    lockedTag: null,
    lastError: null,
    reconnecting: false,
  },
  weighbridge: { connected: false, currentWeight: 0, isStable: false, lastSeen: null },
  camera: { connected: false, lastSeen: null },
  cloud: { connected: false, pendingCount: 0, lastSync: null },
});

const useDeviceStore = create((set) => ({
  ...defaultDevices(),
  displayWeight: 0,
  displayStable: false,

  updateDeviceStatus: (status) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        connected: !!status?.rfid?.connected,
        scanning: !!status?.rfid?.scanning,
        mode: status?.rfid?.mode || null,
        lastSeen: status?.rfid?.lastSeen || s.rfid.lastSeen,
        lastError: status?.rfid?.lastError ?? s.rfid.lastError ?? null,
        reconnecting: !!status?.rfid?.reconnecting,
      },
      weighbridge: {
        ...s.weighbridge,
        connected: !!status?.weighbridge?.connected,
        mode: status?.weighbridge?.mode || null,
        currentWeight: status?.weighbridge?.currentWeight ?? s.weighbridge.currentWeight,
        isStable: !!status?.weighbridge?.isStable,
        lastSeen: status?.weighbridge?.lastSeen || s.weighbridge.lastSeen,
      },
      camera: {
        ...s.camera,
        connected: !!status?.camera?.connected,
        mode: status?.camera?.mode || null,
        lastSeen: status?.camera?.lastSeen || s.camera.lastSeen,
      },
      cloud: {
        ...s.cloud,
        connected: !!status?.cloud?.connected,
        pendingCount: status?.cloud?.pendingCount ?? s.cloud.pendingCount,
        lastSync: status?.cloud?.lastSync || s.cloud.lastSync,
      },
    })),

  setLastRfidTag: (tag) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: tag,
        lastSeen: new Date().toISOString(),
      },
    })),

  setLastRfidScan: (scan) =>
    set((s) => {
      if (
        s.rfid.locked &&
        scan?.locked !== true &&
        scan?.tag &&
        scan.tag !== s.rfid.lockedTag
      ) {
        return s;
      }
      const shouldLock = scan?.locked === true;
      return {
        rfid: {
          ...s.rfid,
          lastTag: scan?.tag ?? s.rfid.lastTag,
          lastScan: scan,
          lastSeen: scan?.timestamp || new Date().toISOString(),
          locked: shouldLock ? true : s.rfid.locked,
          lockedTag: shouldLock ? scan?.tag ?? s.rfid.lockedTag : s.rfid.lockedTag,
        },
      };
    }),

  lockRfid: (tag, scan = null) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: tag,
        lastScan: scan || { tag, ...(s.rfid.lastScan?.tag === tag ? s.rfid.lastScan : {}) },
        lastSeen: new Date().toISOString(),
        locked: true,
        lockedTag: tag,
      },
    })),

  unlockRfid: () =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        locked: false,
        lockedTag: null,
      },
    })),

  setRfidScanning: (scanning) =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        scanning: !!scanning,
      },
    })),

  clearRfidScan: () =>
    set((s) => ({
      rfid: {
        ...s.rfid,
        lastTag: null,
        lastScan: null,
        locked: false,
        lockedTag: null,
        scanning: false,
      },
    })),

  updateWeight: (weight, isStable) =>
    set((s) => ({
      displayWeight: weight,
      displayStable: isStable,
      weighbridge: {
        ...s.weighbridge,
        currentWeight: weight,
        isStable,
        lastSeen: new Date().toISOString(),
      },
    })),
}));

export default useDeviceStore;
