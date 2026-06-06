'use strict';



const TransactionService = require('./TransactionService');

const RfidTagSelector = require('./RfidTagSelector');

const CameraCaptureService = require('./CameraCaptureService');

const { saveImage } = require('../utils/fileStorage');

const { TRANSACTION_STATUS } = require('../utils/constants');

const ts = require('../utils/timestamp');

const logger = require('../utils/logger');



function parseImageBase64(imageBase64) {

  if (!imageBase64 || typeof imageBase64 !== 'string') {

    throw new Error('Camera image is required');

  }

  const match = imageBase64.match(/^data:image\/\w+;base64,(.+)$/);

  const raw = match ? match[1] : imageBase64;

  const buffer = Buffer.from(raw, 'base64');

  if (!buffer.length) {

    throw new Error('Invalid camera image data');

  }

  return buffer;

}



function parseCameraSnapshots(raw) {

  if (!raw) return { tare: [], gross: [] };

  if (typeof raw === 'object') {

    return { tare: raw.tare || [], gross: raw.gross || [] };

  }

  try {

    const parsed = JSON.parse(raw);

    return { tare: parsed.tare || [], gross: parsed.gross || [] };

  } catch {

    return { tare: [], gross: [] };

  }

}



function mergeCameraSnapshots(existing, passKey, newSnapshots) {

  const data = parseCameraSnapshots(existing);

  data[passKey] = newSnapshots;

  return JSON.stringify(data);

}



function pickPrimaryPath(snapshots) {

  if (!snapshots?.length) return null;

  return (

    snapshots.find((s) => s.id === 'webcam')?.path ||

    snapshots.find((s) => s.id === 'uploaded')?.path ||

    snapshots[0].path

  );

}



/**

 * Capture all configured cameras; merge with optional webcam/upload image.

 * @returns {Promise<{ primaryPath: string|null, snapshots: Array }>}

 */

async function resolveTripCaptures({ imageBase64, imagePath, transactionId }) {

  const snapshots = [];



  if (imagePath && typeof imagePath === 'string') {

    snapshots.push({ id: 'uploaded', label: 'Capture', path: imagePath });

  } else if (imageBase64) {

    const imageBuffer = parseImageBase64(imageBase64);

    const path = saveImage(imageBuffer, transactionId);

    snapshots.push({ id: 'webcam', label: 'Webcam', path });

  }



  const rtspSnapshots = await CameraCaptureService.captureAllSnapshots(transactionId);

  for (const snap of rtspSnapshots) {

    if (!snapshots.some((s) => s.path === snap.path)) {

      snapshots.push(snap);

    }

  }



  if (!snapshots.length) {

    try {

      const DeviceMonitorService = require('./DeviceMonitorService');

      const { camera } = DeviceMonitorService.getAdapters();

      if (camera && typeof camera.captureImage === 'function') {

        if (!camera.isConnected() && typeof camera.connect === 'function') {

          await camera.connect();

        }

        const path = await camera.captureImage(transactionId);

        snapshots.push({ id: 'cam-primary', label: 'Camera', path });

      }

    } catch (err) {

      logger.warn('Fallback camera capture failed', { message: err.message });

    }

  }



  if (!snapshots.length && (imageBase64 || imagePath)) {

    throw new Error('Camera image is required');

  }



  return {

    primaryPath: pickPrimaryPath(snapshots),

    snapshots,

  };

}



/**

 * Save webcam capture + weight using ticket status rules:

 * - Closed (vehicle out): tare → ticket opens

 * - Open (vehicle in): gross → trip closes (trip = slip_number)

 */

async function saveTripCapture(data = {}) {
  const truckNumber = String(data.truckNumber || '')

    .trim()

    .toUpperCase();

  if (!truckNumber) {

    throw new Error('Scan an RFID tag or enter a truck number before saving');

  }



  const rfidTag = data.rfidTag ? String(data.rfidTag).trim().toUpperCase() : null;

  const weighment = TransactionService.getVehicleWeighmentInfo(truckNumber, rfidTag);
  const pass = weighment.ticketStatus === 'open' ? 'GROSS' : 'TARE';

  const DeviceMonitorService = require('./DeviceMonitorService');
  const WeightAdjustmentService = require('./WeightAdjustmentService');

  let rawKg = DeviceMonitorService.getCurrentRawWeight();
  if (!Number.isFinite(rawKg) || rawKg <= 0) {
    rawKg = Math.round(Number(data.weightKg));
  }

  const split = WeightAdjustmentService.split(rawKg, { pass });
  const weightKg = split.adjustedKg;

  if (!Number.isFinite(weightKg) || weightKg <= 0) {
    throw new Error('Valid weight is required');
  }

  try {
    if (typeof DeviceMonitorService.stopRfidScan === 'function') {
      await DeviceMonitorService.stopRfidScan();
    }
  } catch (err) {
    logger.warn('stopRfidScan after save failed', { message: err.message });
  }

  let result;
  if (weighment.ticketStatus === 'open') {
    result = await saveGrossPass({
      openTrip: TransactionService.findOpenTripForVehicle(truckNumber, rfidTag),
      weightKg,
      rawWeightKg: split.rawKg,
      weightOffsetKg: split.offsetKg,
      imageBase64: data.imageBase64,
      imagePath: data.imagePath || null,
      truckNumber,
      rfidTag,
    });
  } else {
    result = await saveTarePass({
      weightKg,
      rawWeightKg: split.rawKg,
      weightOffsetKg: split.offsetKg,
      imageBase64: data.imageBase64,
      imagePath: data.imagePath || null,
      truckNumber,
      rfidTag,
      transactionId: data.transactionId || null,
    });
  }



  try {
    const DeviceMonitorService = require('./DeviceMonitorService');
    if (typeof DeviceMonitorService.invalidateStatusCountCache === 'function') {
      DeviceMonitorService.invalidateStatusCountCache();
    }
  } catch (_e) {
    /* ignore */
  }

  return result;

}



async function saveTarePass({
  weightKg,
  rawWeightKg,
  weightOffsetKg,
  imageBase64,
  imagePath,
  truckNumber,
  rfidTag,
  transactionId,
}) {

  let txnId = transactionId || null;



  if (!txnId) {

    const result = TransactionService.create({

      truck_number: truckNumber,

      rfid_tag: rfidTag,

      status: TRANSACTION_STATUS.PENDING,

      timestamp_in: ts.now(),

    });

    txnId = result.isDuplicate ? result.existingId : result.transaction.id;

  } else if (!TransactionService.getById(txnId)) {

    throw new Error(`Transaction not found: ${txnId}`);

  }



  const existing = TransactionService.getById(txnId);

  const { primaryPath, snapshots } = await resolveTripCaptures({

    imageBase64,

    imagePath,

    transactionId: txnId,

  });



  if (!primaryPath) {

    throw new Error('Could not capture images from any camera');

  }



  const capturedAt = ts.now();
  const transaction = TransactionService.updateFields(txnId, {
    tare_weight: weightKg,
    raw_tare_weight: rawWeightKg,
    weight_offset_kg: weightOffsetKg,
    tare_image_path: primaryPath,
    image_path: primaryPath,
    timestamp_in: existing?.timestamp_in || capturedAt,
    status: TRANSACTION_STATUS.WEIGHING,
    camera_snapshots: mergeCameraSnapshots(existing?.camera_snapshots, 'tare', snapshots),
  });



  RfidTagSelector.unlock();



  logger.info('Trip tare saved — ticket open', {

    transactionId: txnId,

    slip: transaction.slip_number,

    weightKg,

    cameras: snapshots.length,

  });



  return {

    transaction,

    imagePath: primaryPath,

    cameraSnapshots: snapshots,

    pass: 'TARE',

    ticketStatus: 'open',

    tripNumber: null,

    created: !transactionId,

  };

}



async function saveGrossPass({
  openTrip,
  weightKg,
  rawWeightKg,
  weightOffsetKg,
  imageBase64,
  imagePath,
  truckNumber,
  rfidTag,
}) {

  if (!openTrip) {

    throw new Error('No open ticket found for this vehicle — capture tare first');

  }

  if (openTrip.tare_weight == null) {

    throw new Error('Open ticket has no tare weight — capture tare first');

  }



  const txnId = openTrip.id;

  const { primaryPath, snapshots } = await resolveTripCaptures({

    imageBase64,

    imagePath,

    transactionId: txnId,

  });



  if (!primaryPath) {

    throw new Error('Could not capture images from any camera');

  }



  const capturedAt = ts.now();
  const transaction = TransactionService.updateFields(txnId, {
    gross_weight: weightKg,
    raw_gross_weight: rawWeightKg,
    weight_offset_kg: weightOffsetKg,
    image_path: primaryPath,
    timestamp_out: capturedAt,
    status: TRANSACTION_STATUS.CAPTURED,
    camera_snapshots: mergeCameraSnapshots(openTrip.camera_snapshots, 'gross', snapshots),
  });



  RfidTagSelector.unlock();



  logger.info('Trip gross saved — ticket closed', {

    transactionId: txnId,

    trip: transaction.slip_number,

    weightKg,

    truckNumber,

    rfidTag,

    cameras: snapshots.length,

  });



  return {

    transaction,

    imagePath: primaryPath,

    cameraSnapshots: snapshots,

    pass: 'GROSS',

    ticketStatus: 'closed',

    tripNumber: transaction.slip_number,

    created: false,

  };

}



module.exports = { saveTripCapture, resolveTripCaptures, mergeCameraSnapshots };


