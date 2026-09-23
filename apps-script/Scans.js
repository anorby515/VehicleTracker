/**
 * Scan status (spec 8.1; docs/API.md "Scan status").
 *
 * Every App Scans row that isn't final is re-checked by where its Drive file
 * is now. Cowork renames and moves each Inbox file into
 * "<vehicle folder>/<year>/" (sometimes deeper, e.g. a Pages subfolder) or
 * into "_Needs Review", keeping the file ID, so the file's folder chain says
 * how far it got:
 *
 *   in Inbox                                   → Waiting
 *   under a vehicle folder, ID on Documents    → Filed (Visit ID set; final)
 *   under a vehicle folder, not on Documents   → Adding to journal
 *   in _Needs Review                           → Needs attention
 *   trashed or missing                         → Check with owner (at once)
 *   anywhere else, 24 hours after upload       → Check with owner (Waiting before that)
 *
 * classifyScanLocation_ is pure (tested in Node); locateFile_ asks Drive.
 * Checks run from jobScanStatus (every 30 minutes, all users) and from
 * bootstrap (checkUserScans_, throttled per user). Neither sends anything:
 * notifications are planned from the resulting Status (Notify.js).
 *
 * No top-level references to Config.js constants: Apps Script may load this
 * file before Config.js.
 */

/** How many folders up locateFile_ walks from the file (vehicle/year/Pages is 3). */
const SCAN_PARENT_DEPTH_ = 5;

/** The CacheService key that throttles one user's on-demand check. */
function scanThrottleKey_(email) {
  return 'scancheck:' + email;
}

// ---------------------------------------------------------------- classify (pure)

/**
 * Where a scan's file is → its App Scans status.
 * @param {{exists: boolean, trashed?: boolean, parentIds?: string[], fileId?: string}} loc
 *   parentIds is the folder chain, nearest first (locateFile_)
 * @param {object} ctx
 *   inboxId, needsReviewId   Script Properties INBOX_FOLDER_ID / NEEDS_REVIEW_FOLDER_ID
 *   vehicleFolders           {folderId: vehicleName} from Vehicles › Drive Folder ID
 *   documentsByFileId        {fileId: {visitId, vehicle}} from the Documents tab
 *   uploadedAtMs, nowMs      for the 24-hour rule (uploadedAtMs null = unknown = past it)
 *   ownerName?               "Robert", for the trashed/missing detail text
 * @return {{status: string, statusDetail: string|null, visitId: string|null, filedVehicle: string|null}}
 *   statusDetail is set only when there is more to say than the status's
 *   standard text (Logic.js scanStatusDetail_, which the app shows when the
 *   App Scans › Status Detail cell is blank): the file is trashed or missing.
 */
function classifyScanLocation_(loc, ctx) {
  const owner = ctx.ownerName || 'the owner';
  const result = (status, vehicle, visitId, detail) => ({
    status: status,
    statusDetail: detail || null,
    visitId: visitId || null,
    filedVehicle: vehicle || null,
  });

  if (!loc || !loc.exists) {
    return result(SCAN_STATUS.CHECK_WITH_OWNER, null, null,
      "We couldn't find this scan in Drive. " + capitalize_(owner) + ' can look into it.');
  }
  if (loc.trashed) {
    return result(SCAN_STATUS.CHECK_WITH_OWNER, null, null,
      'This scan was moved to the trash. ' + capitalize_(owner) + ' can look into it.');
  }

  // The nearest known folder decides, so year and Pages subfolders under a
  // vehicle folder count as that vehicle.
  const folders = ctx.vehicleFolders || {};
  const parents = loc.parentIds || [];
  for (let i = 0; i < parents.length; i++) {
    const id = parents[i];
    if (!id) continue;
    if (id === ctx.inboxId) return result(SCAN_STATUS.WAITING);
    if (id === ctx.needsReviewId) return result(SCAN_STATUS.NEEDS_ATTENTION);
    if (Object.prototype.hasOwnProperty.call(folders, id)) {
      const doc = (ctx.documentsByFileId || {})[loc.fileId];
      // Filed on the vehicle the journal has it under (normally the same folder).
      if (doc) return result(SCAN_STATUS.FILED, doc.vehicle || folders[id], doc.visitId);
      return result(SCAN_STATUS.ADDING, folders[id]);
    }
  }

  // None of the above: give Cowork a day (it may be mid-move) before asking the owner.
  const age = ctx.uploadedAtMs === null || ctx.uploadedAtMs === undefined ? Infinity : ctx.nowMs - ctx.uploadedAtMs;
  if (age >= RULES.SCAN_MISSING_AFTER_HOURS * 3600 * 1000) return result(SCAN_STATUS.CHECK_WITH_OWNER);
  return result(SCAN_STATUS.WAITING);
}

/**
 * The lookups classifyScanLocation_ needs, from normalized data. Pure.
 * @param {object} D needs vehicles and documents
 * @param {{inboxId: string, needsReviewId: string}} folderIds
 * @param {string} [ownerName]
 */
function scanContextFromData_(D, folderIds, ownerName) {
  const vehicleFolders = {}, documentsByFileId = {};
  (D.vehicles || []).forEach(v => {
    // Inactive vehicles count too: a receipt can still be filed into a sold car's folder.
    if (v.driveFolderId && !(v.driveFolderId in vehicleFolders)) vehicleFolders[v.driveFolderId] = v.name;
  });
  (D.documents || []).forEach(d => {
    if (d.fileId && !(d.fileId in documentsByFileId)) documentsByFileId[d.fileId] = { visitId: d.visitId, vehicle: d.vehicle };
  });
  return {
    inboxId: folderIds.inboxId || null,
    needsReviewId: folderIds.needsReviewId || null,
    vehicleFolders: vehicleFolders,
    documentsByFileId: documentsByFileId,
    ownerName: ownerName || 'the owner',
  };
}

/** Milliseconds of an App Scans › Uploaded At (ISO string or Date), or null. */
function scanUploadedMs_(uploadedAt) {
  if (uploadedAt instanceof Date) return uploadedAt.getTime();
  const ms = Date.parse(String(uploadedAt || ''));
  return isNaN(ms) ? null : ms;
}

/**
 * App Scans rows to check now: not Filed, uploaded within SCAN_TRACK_DAYS
 * (rows with no readable Uploaded At can't age out and are skipped), and,
 * when `who` is given, uploaded by that person (email, or their Name on a
 * hand-entered row). Pure.
 * @param {{email: string, name?: string}} [who]
 */
function scansToCheck_(scans, nowMs, who) {
  const maxAge = RULES.SCAN_TRACK_DAYS * 86400 * 1000;
  const email = who ? lower_(who.email) : null;
  const name = who ? lower_(who.name) : null;
  return (scans || []).filter(s => {
    if (scanStatus_(s.status) === SCAN_STATUS.FILED) return false;
    const at = scanUploadedMs_(s.uploadedAt);
    if (at === null || nowMs - at > maxAge) return false;
    if (!who) return true;
    return !!s.uploadedBy && (s.uploadedBy === email || (!!name && s.uploadedBy === name));
  });
}

// ---------------------------------------------------------------- Drive (impure)

/**
 * Where a Drive file is now: {fileId, exists, trashed, parentIds} with the
 * folder chain nearest first (My Drive files have one parent), up to
 * SCAN_PARENT_DEPTH_ levels, stopping early at a folder in `stopIds`.
 * A file Drive can't find (or we can't see) comes back exists = false; any
 * other Drive error is thrown, so a Drive hiccup never marks a scan missing.
 * @param {Object<string, boolean>} [stopIds]
 */
function locateFile_(fileId, stopIds) {
  let file;
  try {
    file = DriveApp.getFileById(fileId);
  } catch (e) {
    // Drive's "No item with the given ID could be found..." (also what it says
    // when we can't see the file). An authorization error ("Access denied:
    // DriveApp") is rethrown: it says nothing about this file.
    if (/no item with the given id|could not be found|not found/i.test(String(e && e.message || e))) {
      return { fileId: fileId, exists: false, trashed: false, parentIds: [] };
    }
    throw e;
  }
  const loc = { fileId: fileId, exists: true, trashed: file.isTrashed(), parentIds: [] };
  let parents = file.getParents();
  for (let depth = 0; depth < SCAN_PARENT_DEPTH_ && parents.hasNext(); depth++) {
    const folder = parents.next();
    const id = folder.getId();
    loc.parentIds.push(id);
    if (stopIds && stopIds[id]) break;
    parents = folder.getParents();
  }
  return loc;
}

// ---------------------------------------------------------------- check and write

/**
 * Checks the given App Scans rows and writes the results. Status, Status
 * Detail and Visit ID are written only when they change (a blank Status
 * Detail means the status's standard text); Last Checked always.
 * One row's failure (a Drive error) is logged and doesn't stop the others.
 * @param {object[]} rows normalized App Scans rows (with _row)
 * @param {object} opts
 *   ctx      scanContextFromData_ output (required)
 *   now?     Date (default: now)
 *   locate?  (fileId, stopIds) → loc (default locateFile_; tests pass a fake)
 * @return {object[]} the rows whose Status changed, with the new status,
 *   statusDetail, visitId and filedVehicle, and previousStatus
 */
function checkScans_(rows, opts) {
  const now = opts.now || new Date();
  const locate = opts.locate || locateFile_;
  const base = opts.ctx;
  const stopIds = {};
  [base.inboxId, base.needsReviewId].concat(Object.keys(base.vehicleFolders || {}))
    .forEach(id => { if (id) stopIds[id] = true; });

  const changed = [];
  (rows || []).forEach(row => {
    try {
      const loc = row.fileId ? locate(row.fileId, stopIds) : { fileId: null, exists: false, parentIds: [] };
      const ctx = Object.assign({}, base, { uploadedAtMs: scanUploadedMs_(row.uploadedAt), nowMs: now.getTime() });
      const res = classifyScanLocation_(loc, ctx);
      const update = { 'Last Checked': now };
      if (res.status !== row.status) update['Status'] = res.status;
      if ((res.statusDetail || null) !== (row.statusDetail || null)) update['Status Detail'] = res.statusDetail || '';
      if ((res.visitId || null) !== (row.visitId || null)) update['Visit ID'] = res.visitId || '';
      updateAppRow_(TAB.APP_SCANS, row._row, update);
      if (res.status !== row.status) {
        changed.push(Object.assign({}, row, {
          previousStatus: row.status,
          status: res.status,
          statusDetail: res.statusDetail,
          visitId: res.visitId,
          filedVehicle: res.filedVehicle,
        }));
      }
    } catch (e) {
      console.warn('Scan status check failed for ' + row.scanId + ': ' + (e && e.message || e));
    }
  });
  return changed;
}

/** INBOX_FOLDER_ID and NEEDS_REVIEW_FOLDER_ID from Script Properties. */
function scanFolderIds_() {
  return {
    inboxId: prop_(PROP.INBOX_FOLDER_ID, false),
    needsReviewId: prop_(PROP.NEEDS_REVIEW_FOLDER_ID, false),
  };
}

/**
 * Checks every App Scans row that isn't final and is younger than
 * SCAN_TRACK_DAYS (or only one person's, with opts.email). Reads the other
 * tabs only when there is something to check. Invalidates the bootstrap cache
 * when a status changed (a newly filed scan usually means a new visit).
 * @param {{now?: Date, email?: string, name?: string, locate?: Function}} [opts]
 * @return {{checked: number, changed: object[]}}
 */
function runScanStatus_(opts) {
  opts = opts || {};
  const now = opts.now || new Date();
  const scans = normAppScans_(readTab_(TAB.APP_SCANS, false));
  const who = opts.email ? { email: opts.email, name: opts.name } : null;
  const rows = scansToCheck_(scans, now.getTime(), who);
  if (!rows.length) return { checked: 0, changed: [] };

  const D = dataFromTabs_(readTabs_([TAB.VEHICLES, TAB.DOCUMENTS, TAB.APP_USERS]));
  const ctx = scanContextFromData_(D, scanFolderIds_(), ownerName_(D));
  const changed = checkScans_(rows, { now: now, ctx: ctx, locate: opts.locate });
  if (changed.length) invalidateBootstrapCache_();
  return { checked: rows.length, changed: changed };
}

/**
 * The on-demand check bootstrap runs for the signed-in user: their scans that
 * aren't final, at most once per RULES.SCAN_CHECK_THROTTLE_SEC per user.
 * Never throws (a Drive or Sheet hiccup must not break bootstrap).
 * @param {string} email
 * @param {{now?: Date, name?: string, force?: boolean}} [opts]
 * @return {{checked: number, changed?: object[], throttled?: boolean, error?: string}}
 */
function checkUserScans_(email, opts) {
  opts = opts || {};
  const e = lower_(email);
  if (!e) return { checked: 0 };
  try {
    const cache = CacheService.getScriptCache();
    const key = scanThrottleKey_(e);
    if (key.length > 250) return { checked: 0 }; // CacheService key limit; no real email is this long
    if (!opts.force && cache.get(key)) return { checked: 0, throttled: true };
    // Claim the slot before checking, so parallel requests don't both run.
    cache.put(key, '1', RULES.SCAN_CHECK_THROTTLE_SEC);
    return runScanStatus_({ now: opts.now, email: e, name: opts.name });
  } catch (err) {
    console.warn('Scan status check for ' + e + ' failed: ' + (err && err.stack || err));
    return { checked: 0, error: String(err && err.message || err) };
  }
}
