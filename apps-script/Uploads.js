/**
 * Chunked PDF upload into Drive `Inbox` (docs/API.md "Uploads").
 *
 * uploadStart opens a Drive RESUMABLE upload session for a new PDF in Inbox;
 * uploadChunk forwards each piece of the phone's PDF to that session. The
 * file only exists in Drive once the last byte lands, so Cowork never sees a
 * partial scan; then the App Scans row is appended (Status Waiting).
 *
 * Both steps are idempotent on the phone's scanId:
 * - uploadStart for a scanId already on App Scans returns {done: true, scan};
 * - uploadStart for a scanId with an upload still in progress hands back the
 *   same uploadId, and the phone learns how far it got from uploadChunk;
 * - a retried chunk (lost response) gets the current `received`, or the
 *   finished scan.
 *
 * Upload state lives in CacheService (at most 6 hours, like the spec says);
 * when it's gone, uploadChunk answers 404 and the phone starts again with the
 * same scanId, which is safe because nothing was written yet.
 */

const DRIVE_UPLOAD_URL_ = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name';
const UPLOAD_STATE_PREFIX_ = 'upload:';     // + uploadId → JSON state
const UPLOAD_BY_SCAN_PREFIX_ = 'upscan:';   // + scanId → uploadId (upload in progress)
const UPLOAD_STATE_TTL_SEC_ = 21600;        // CacheService maximum: 6 hours
const UPLOAD_ALIGN_BYTES_ = 256 * 1024;     // Drive: every chunk but the last is a multiple of 256 KiB
const PDF_MAGIC_ = [37, 80, 68, 70, 45];    // "%PDF-"

/**
 * uploadStart {scanId, kind, vehicleHint, size, pages, capturedAt}
 *   → {uploadId, chunkSize} or {done: true, scan}.
 */
function uploadStart_(ctx, params) {
  const scanId = params.scanId;
  const scans = normAppScans_(readTab_(TAB.APP_SCANS, false));
  const existing = scans.filter(r => r.scanId === scanId)[0];
  if (existing) {
    // A retry after a lost response: only the uploader gets the row back.
    if (!isUploader_(existing, ctx)) throw uploadNotYours_();
    return { done: true, scan: uploadScanView_(existing, ctx) };
  }

  // Validation, in the documented order.
  const size = params.size;
  if (size > RULES.UPLOAD_MAX_BYTES) {
    throw apiError_(413, 'too_large', 'That file is over 25 MB. Try fewer pages or a smaller PDF.',
      { maxBytes: RULES.UPLOAD_MAX_BYTES });
  }
  if (!(size >= PDF_MAGIC_.length)) throw apiError_(400, 'bad_request', 'That file is empty.');
  if (!(params.pages >= 1 && params.pages <= RULES.UPLOAD_MAX_PAGES)) {
    throw apiError_(400, 'bad_request', 'A scan can have 1 to ' + RULES.UPLOAD_MAX_PAGES + ' pages.');
  }
  if (!Object.prototype.hasOwnProperty.call(SCAN_KIND_PREFIX, params.kind)) {
    throw apiError_(400, 'bad_request', 'Unknown kind of scan.');
  }
  const vehicles = normVehicles_(readTab_(TAB.VEHICLES, true));
  const vehicle = activeVehicles_(vehicles).filter(v => v.name === params.vehicleHint)[0];
  if (!vehicle) throw apiError_(400, 'bad_request', "Pick one of the family's vehicles.");
  const captured = new Date(params.capturedAt);
  if (isNaN(captured.getTime())) throw apiError_(400, 'bad_request', 'The scan time is missing or unreadable.');

  // An upload for this scanId already in progress (the phone lost our reply):
  // hand back the same session instead of opening a second file.
  const cache = CacheService.getScriptCache();
  const inFlightId = cache.get(UPLOAD_BY_SCAN_PREFIX_ + scanId);
  const inFlight = inFlightId ? readUploadState_(inFlightId) : null;
  if (inFlight && !inFlight.done && inFlight.email !== ctx.email) throw uploadNotYours_();
  if (inFlight && !inFlight.done && inFlight.size === size) {
    return { uploadId: inFlightId, chunkSize: RULES.UPLOAD_CHUNK_BYTES };
  }

  const name = uniqueScanFileName_(scanFileName_(params.kind, vehicle.name, captured, ctx.appUser),
    scans.map(r => r.fileName).filter(Boolean));
  const sessionUri = openResumableSession_(name);
  const uploadId = Utilities.getUuid();
  writeUploadState_(uploadId, {
    sessionUri: sessionUri,
    email: ctx.email,
    scanId: scanId,
    kind: params.kind,
    vehicleHint: vehicle.name,
    size: size,
    pages: params.pages,
    name: name,
    received: 0,
    done: false,
  });
  cache.put(UPLOAD_BY_SCAN_PREFIX_ + scanId, uploadId, UPLOAD_STATE_TTL_SEC_);
  return { uploadId: uploadId, chunkSize: RULES.UPLOAD_CHUNK_BYTES };
}

/**
 * uploadChunk {uploadId, offset, data (base64)} → {received, done, scan?}.
 */
function uploadChunk_(ctx, params) {
  const uploadId = params.uploadId;
  const st = readUploadState_(uploadId);
  if (!st) throw uploadExpired_();
  if (st.email !== ctx.email) throw uploadNotYours_();

  if (st.done) return { received: st.size, done: true, scan: uploadScanView_(findScanRow_(st.scanId), ctx) };

  // A previous forward failed mid-flight: ask Drive how much it has first.
  if (st.uncertain) {
    const synced = syncUpload_(uploadId, st, ctx);
    if (synced) return synced;
  }

  if (params.offset !== st.received) return { received: st.received, done: false };

  let bytes;
  try {
    bytes = Utilities.base64Decode(params.data);
  } catch (e) {
    throw apiError_(400, 'bad_request', "The upload data wasn't readable.");
  }
  const len = bytes ? bytes.length : 0;
  if (!len) throw apiError_(400, 'bad_request', 'The upload chunk was empty.');
  const end = st.received + len;  // exclusive
  if (end > st.size) throw apiError_(400, 'bad_request', 'The upload is bigger than announced.');
  if (end < st.size && len % UPLOAD_ALIGN_BYTES_ !== 0) {
    throw apiError_(400, 'bad_request', 'Upload chunks must be a multiple of 256 KiB (except the last).');
  }
  if (st.received === 0 && !startsWithPdfMagic_(bytes)) {
    throw apiError_(400, 'bad_request', "That isn't a PDF.");
  }

  let res;
  try {
    res = UrlFetchApp.fetch(st.sessionUri, {
      method: 'put',
      contentType: 'application/pdf',
      payload: bytes,
      headers: { 'Content-Range': 'bytes ' + st.received + '-' + (end - 1) + '/' + st.size },
      muteHttpExceptions: true,
      followRedirects: false,
    });
  } catch (e) {
    // Network trouble: Drive may or may not have the bytes. Resync next time.
    st.uncertain = true;
    writeUploadState_(uploadId, st);
    throw e;
  }
  const code = res.getResponseCode();
  if (code === 308) {
    st.received = receivedFromRange_(httpHeader_(res, 'Range'));
    writeUploadState_(uploadId, st);
    return { received: st.received, done: false };
  }
  if (code === 200 || code === 201) return finishUpload_(uploadId, st, parseJsonSafe_(res.getContentText()), ctx);
  if (code === 404 || code === 410) {
    forgetUpload_(uploadId, st);
    throw uploadExpired_();
  }
  // Anything else (5xx, 400 ...): find out what Drive actually has, and let
  // the phone continue from there.
  console.warn('Drive upload chunk answered HTTP ' + code + ': ' + String(res.getContentText()).slice(0, 300));
  st.uncertain = true;
  writeUploadState_(uploadId, st);
  return syncUpload_(uploadId, st, ctx) || { received: st.received, done: false };
}

/**
 * Brings `received` in line with what Drive really has (after a failed
 * forward). Returns the finished result when Drive already has everything,
 * else null with st.received updated. An expired session → 404 not_found.
 */
function syncUpload_(uploadId, st, ctx) {
  let status;
  try {
    status = queryUploadStatus_(st);
  } catch (e) {
    if (isApiError_(e) && e.status === 404) forgetUpload_(uploadId, st);
    throw e;
  }
  if (status.done) return finishUpload_(uploadId, st, status.file, ctx);
  st.received = status.received;
  st.uncertain = false;
  writeUploadState_(uploadId, st);
  return null;
}

function uploadNotYours_() {
  return apiError_(403, 'forbidden', 'That upload belongs to someone else.');
}

/** Whether an App Scans row was uploaded by the caller (the email, or their Name on a hand-entered row). */
function isUploader_(row, ctx) {
  const by = lower_(row && row.uploadedBy);
  return !!by && (by === lower_(ctx.email) || (!!ctx.appUser && !!ctx.appUser.name && by === lower_(ctx.appUser.name)));
}

function uploadExpired_() {
  return apiError_(404, 'not_found', 'This upload expired. Please start it again.');
}

// ---------------------------------------------------------------- completion

/**
 * Drive has the whole file: append the App Scans row (once, under the script
 * lock), refresh the bootstrap cache, and mark the upload done.
 */
function finishUpload_(uploadId, st, file, ctx) {
  const fileId = file && file.id ? String(file.id) : null;
  if (!fileId) throw new Error('Drive finished the upload but returned no file ID.');
  const row = withLock_(() => {
    const already = findScanRow_(st.scanId);
    if (already) return already;
    const now = new Date();
    const obj = {
      'Scan ID': st.scanId,
      'Kind': st.kind,
      'Vehicle Hint': st.vehicleHint,
      'Drive File ID': fileId,
      'File Name': (file && file.name) || st.name,
      'Pages': st.pages,
      'Uploaded By': scanUploadedByValue_(ctx),
      'Uploaded At': now,
      'Status': SCAN_STATUS.WAITING,
      'Status Detail': '',
      'Last Checked': now,
    };
    const r = appendAppRow_(TAB.APP_SCANS, obj);
    return normAppScan_(Object.assign({ _row: r }, obj));
  });
  invalidateBootstrapCache_();
  st.done = true;
  st.received = st.size;
  st.fileId = fileId;
  writeUploadState_(uploadId, st);
  CacheService.getScriptCache().remove(UPLOAD_BY_SCAN_PREFIX_ + st.scanId);
  return { received: st.size, done: true, scan: uploadScanView_(row, ctx) };
}

/**
 * What goes in App Scans › Uploaded By: the uploader's email, lower-cased.
 * Model.js and Bootstrap.js (myScans_) read it as the email (a hand-entered
 * Name also matches there), and notifications need the email to find devices.
 */
function scanUploadedByValue_(ctx) {
  return ctx.email;
}

/** App Scans row → Scan view (Logic.js scanView_), using the caller's App Users for the owner's name. */
function uploadScanView_(row, ctx) {
  if (!row) return null;
  const D = { vehicles: [], visits: [], documents: [], appUsers: (ctx && ctx.appUsers) || [] };
  return scanView_(row, D, ownerName_(D));
}

/** The normalized App Scans row for a scanId, or null. Read fresh. */
function findScanRow_(scanId) {
  const rows = normAppScans_(readTab_(TAB.APP_SCANS, false));
  return rows.filter(r => r.scanId === scanId)[0] || null;
}

// ---------------------------------------------------------------- file name

/**
 * "<prefix> - <Vehicle> - <YYYY-MM-DD HHmm> - <First name>.pdf", with the
 * time in America/Chicago. Pure apart from the Chicago formatting.
 */
function scanFileName_(kind, vehicleName, capturedDate, appUser) {
  const first = String((appUser && appUser.name) || (appUser && appUser.email) || 'Family').trim().split(/\s+/)[0];
  const when = formatInTz_(capturedDate, 'yyyy-MM-dd') + ' ' + formatInTz_(capturedDate, 'HHmm');
  return SCAN_KIND_PREFIX[kind] + ' - ' + vehicleName + ' - ' + when + ' - ' + first + '.pdf';
}

/** Appends " (2)", " (3)" ... before ".pdf" until the name isn't taken (case-insensitive). */
function uniqueScanFileName_(name, takenNames) {
  const taken = {};
  (takenNames || []).forEach(n => { taken[String(n).toLowerCase()] = true; });
  if (!taken[name.toLowerCase()]) return name;
  const stem = name.replace(/\.pdf$/i, '');
  for (let i = 2; ; i++) {
    const candidate = stem + ' (' + i + ').pdf';
    if (!taken[candidate.toLowerCase()]) return candidate;
  }
}

// ---------------------------------------------------------------- Drive resumable upload

/** Opens a resumable session for a new PDF in Inbox; returns the session URI. */
function openResumableSession_(name) {
  const inbox = prop_(PROP.INBOX_FOLDER_ID, true);
  const res = UrlFetchApp.fetch(DRIVE_UPLOAD_URL_, {
    method: 'post',
    contentType: 'application/json; charset=UTF-8',
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    payload: JSON.stringify({ name: name, parents: [inbox], mimeType: 'application/pdf' }),
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  const location = httpHeader_(res, 'Location');
  if (code !== 200 || !location) {
    throw new Error('Drive would not start the upload (HTTP ' + code + '): ' +
      String(res.getContentText()).slice(0, 300));
  }
  return location;
}

/**
 * Asks Drive how much of the upload it has (an empty PUT with
 * "Content-Range: bytes * /size", without the space).
 * @return {{done: boolean, received: number, file: object|null}}
 */
function queryUploadStatus_(st) {
  const res = UrlFetchApp.fetch(st.sessionUri, {
    method: 'put',
    headers: { 'Content-Range': 'bytes */' + st.size },
    muteHttpExceptions: true,
    followRedirects: false,
  });
  const code = res.getResponseCode();
  if (code === 308) return { done: false, received: receivedFromRange_(httpHeader_(res, 'Range')), file: null };
  if (code === 200 || code === 201) return { done: true, received: st.size, file: parseJsonSafe_(res.getContentText()) };
  if (code === 404 || code === 410) throw uploadExpired_();
  throw new Error('Drive upload status check answered HTTP ' + code);
}

/** "bytes=0-524287" → 524288 (the next byte Drive wants); no header → 0. */
function receivedFromRange_(range) {
  const m = /bytes=(\d+)-(\d+)/.exec(String(range || ''));
  return m ? +m[2] + 1 : 0;
}

/** A response header by name, case-insensitively (getAllHeaders keys vary in case). */
function httpHeader_(res, name) {
  const all = res.getAllHeaders ? res.getAllHeaders() : res.getHeaders();
  const want = name.toLowerCase();
  const keys = Object.keys(all || {});
  for (let i = 0; i < keys.length; i++) {
    if (keys[i].toLowerCase() === want) {
      const v = all[keys[i]];
      return Array.isArray(v) ? v[0] : v;
    }
  }
  return null;
}

function startsWithPdfMagic_(bytes) {
  for (let i = 0; i < PDF_MAGIC_.length; i++) {
    if (bytes[i] !== PDF_MAGIC_[i]) return false;
  }
  return true;
}

function parseJsonSafe_(text) {
  try { return JSON.parse(text); } catch (e) { return null; }
}

// ---------------------------------------------------------------- upload state (CacheService)

function readUploadState_(uploadId) {
  if (!uploadId) return null;
  return parseJsonSafe_(CacheService.getScriptCache().get(UPLOAD_STATE_PREFIX_ + uploadId));
}

function writeUploadState_(uploadId, st) {
  CacheService.getScriptCache().put(UPLOAD_STATE_PREFIX_ + uploadId, JSON.stringify(st), UPLOAD_STATE_TTL_SEC_);
}

function forgetUpload_(uploadId, st) {
  const cache = CacheService.getScriptCache();
  cache.remove(UPLOAD_STATE_PREFIX_ + uploadId);
  if (st && st.scanId && cache.get(UPLOAD_BY_SCAN_PREFIX_ + st.scanId) === uploadId) {
    cache.remove(UPLOAD_BY_SCAN_PREFIX_ + st.scanId);
  }
}
