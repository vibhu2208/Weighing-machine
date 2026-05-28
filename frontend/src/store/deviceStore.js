import { create } from 'zustand';

const defaultDevices = () => ({
  rfid: { connected: false, lastTag: null, lastSeen: null },
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
        lastSeen: status?.rfid?.lastSeen || s.rfid.lastSeen,
      },
      weighbridge: {
        ...s.weighbridge,
        connected: !!status?.weighbridge?.connected,
        currentWeight: status?.weighbridge?.currentWeight ?? s.weighbridge.currentWeight,
        isStable: !!status?.weighbridge?.isStable,
        lastSeen: status?.weighbridge?.lastSeen || s.weighbridge.lastSeen,
      },
      camera: {
        ...s.camera,
        connected: !!status?.camera?.connected,
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
      rfid: { ...s.rfid, lastTag: tag, lastSeen: new Date().toISOString() },
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
