/**
 * Bootstrap: everything the app shows, in one response (types.ts › Bootstrap).
 *
 * The vehicle-wide part is the same for every family member, so it is cached
 * in CacheService for RULES.BOOTSTRAP_CACHE_SEC, gzipped and split across keys
 * (a cache value can't exceed 100 KB). The per-user parts (user, myScans,
 * Vehicle.isMine, Vehicle.attention) are laid over it on every call from a
 * fresh read of App Users and App Scans, which are small.
 */

const BOOTSTRAP_SCHEMA_VERSION = 1;
const BOOTSTRAP_CACHE_CHUNK_CHARS = 90 * 1024;
const BOOTSTRAP_CACHE_MAX_CHUNKS = 100;

/**
 * The vehicle-wide part of the bootstrap. Pure.
 * @return {{schemaVersion, generatedAt, today, vehicles, serviceTypes}}
 */
function buildSharedBootstrap_(D, today, nowIso) {
  return {
    schemaVersion: BOOTSTRAP_SCHEMA_VERSION,
    generatedAt: nowIso,
    today: today,
    vehicles: activeVehicles_(D.vehicles).map(v => buildVehicleView_(v, D, today)),
    serviceTypes: D.serviceTypes.map(t => t.name),
  };
}

/**
 * Adds one user's view to the shared part. Pure when opts.ownerEmail is
 * given; `shared` is not modified, so it can be reused for other users.
 * @param {object} D needs appScans, plus visits/documents/vehicles for scan labels
 * @param {object} appUser the caller's normalized App Users row
 * @param {{today?: string, ownerEmail?: string, ownerName?: string}} [opts]
 */
function overlayUser_(shared, D, appUser, opts) {
  opts = opts || {};
  const today = opts.today || shared.today;
  const ownerEmail = opts.ownerEmail !== undefined ? opts.ownerEmail : ownerEmail_();
  const ownerName = opts.ownerName || ownerName_(D, ownerEmail);
  const user = userView_(appUser, ownerEmail);
  const myScans = myScans_(D, user, today, ownerName);
  const vehicles = shared.vehicles.map(v => {
    const view = Object.assign({}, v);
    view.isMine = isDriverOf_(v, user);
    view.attention = buildAttention_(view, user, myScans, today);
    return view;
  });
  return {
    schemaVersion: shared.schemaVersion,
    generatedAt: shared.generatedAt,
    today: shared.today,
    user: user,
    vehicles: vehicles,
    serviceTypes: shared.serviceTypes,
    myScans: myScans,
    ownerName: ownerName,
  };
}

/**
 * The user's App Scans rows uploaded in the last MY_SCANS_DAYS, newest first.
 * Uploaded By is matched against the email (or, for hand-entered rows, the
 * Name). Rows with a blank Uploaded At are kept, at the end.
 */
function myScans_(D, user, today, ownerName) {
  const email = lower_(user.email), name = lower_(user.name);
  const from = addDays_(today, -RULES.MY_SCANS_DAYS);
  const time = s => (s.uploadedAt ? Date.parse(s.uploadedAt) || 0 : -Infinity);
  return (D.appScans || [])
    .filter(s => s.uploadedBy && (s.uploadedBy === email || s.uploadedBy === name))
    .filter(s => !s.uploadedAt || String(s.uploadedAt).slice(0, 10) >= from)
    .sort((a, b) => time(b) - time(a) || a._row - b._row)
    .map(s => scanView_(s, D, ownerName));
}

/**
 * The full Bootstrap for a signed-in user, or null when the email isn't an
 * Active App Users row. Callers authenticate first (see Auth.js).
 * @param {string} email
 * @param {Date} [now] for tests; defaults to the current time
 */
function getBootstrap_(email, now) {
  const p = nowParts_(now);
  const ownerEmail = ownerEmail_();
  let shared = readBootstrapCache_();
  let D;
  if (shared && shared.today === p.ymd) {
    // Cached vehicle-wide part: only the per-user tabs are read.
    const fresh = dataFromTabs_(readTabs_([TAB.APP_USERS, TAB.APP_SCANS]));
    D = lookupDataFromShared_(shared);
    D.appUsers = fresh.appUsers;
    D.appScans = fresh.appScans;
  } else {
    D = loadData_();
    shared = buildSharedBootstrap_(D, p.ymd, p.iso);
    writeBootstrapCache_(shared);
  }
  const appUser = findAppUser_(D.appUsers, email);
  if (!appUser) return null;
  return overlayUser_(shared, D, appUser, {
    today: p.ymd,
    ownerEmail: ownerEmail,
    ownerName: ownerName_(D, ownerEmail),
  });
}

/**
 * Minimal data object rebuilt from a cached shared bootstrap: enough rows
 * (vehicles, visits, documents) for scanView_ to find a scan's vehicle.
 */
function lookupDataFromShared_(shared) {
  const D = dataFromTabs_({});
  shared.vehicles.forEach(v => {
    D.vehicles.push({ name: v.name, make: v.make, model: v.model, active: true });
    v.visits.forEach(x => {
      D.visits.push({ visitId: x.visitId, vehicle: v.name });
      x.documents.forEach(d => D.documents.push({ fileId: d.fileId, visitId: x.visitId, vehicle: v.name }));
    });
  });
  return D;
}

// ---------------------------------------------------------------- shared-part cache

/** Versioned so a new deployment never reads an older shape. */
function bootstrapCacheKey_() {
  return 'bootstrap:v' + BOOTSTRAP_SCHEMA_VERSION + ':' + APP_VERSION;
}

/** JSON → gzip → base64. */
function packForCache_(obj) {
  const gz = Utilities.gzip(Utilities.newBlob(JSON.stringify(obj), 'application/json'));
  return Utilities.base64Encode(gz.getBytes());
}

function unpackFromCache_(s) {
  const blob = Utilities.newBlob(Utilities.base64Decode(s), 'application/x-gzip');
  return JSON.parse(Utilities.ungzip(blob).getDataAsString());
}

/**
 * Stores the shared part: chunks first, then a small index {id, n} under the
 * base key, so a reader never sees an index without its chunks. Best effort:
 * a failure only means the next call rebuilds.
 */
function writeBootstrapCache_(shared) {
  try {
    const packed = packForCache_(shared);
    const base = bootstrapCacheKey_();
    const id = Utilities.getUuid().slice(0, 8);
    const chunks = {};
    let n = 0;
    for (let i = 0; i < packed.length; i += BOOTSTRAP_CACHE_CHUNK_CHARS) {
      chunks[base + ':' + id + ':' + n++] = packed.slice(i, i + BOOTSTRAP_CACHE_CHUNK_CHARS);
    }
    if (n > BOOTSTRAP_CACHE_MAX_CHUNKS) return false;
    const cache = CacheService.getScriptCache();
    cache.putAll(chunks, RULES.BOOTSTRAP_CACHE_SEC);
    cache.put(base, JSON.stringify({ id: id, n: n }), RULES.BOOTSTRAP_CACHE_SEC);
    return true;
  } catch (e) {
    console.warn('Bootstrap cache not written: ' + e);
    return false;
  }
}

/** The cached shared part, or null when missing, incomplete or unreadable. */
function readBootstrapCache_() {
  try {
    const cache = CacheService.getScriptCache();
    const base = bootstrapCacheKey_();
    const index = JSON.parse(cache.get(base) || 'null');
    if (!index || typeof index.id !== 'string' || !(index.n >= 1 && index.n <= BOOTSTRAP_CACHE_MAX_CHUNKS)) return null;
    const keys = [];
    for (let i = 0; i < index.n; i++) keys.push(base + ':' + index.id + ':' + i);
    const got = cache.getAll(keys);
    let packed = '';
    for (let i = 0; i < keys.length; i++) {
      if (typeof got[keys[i]] !== 'string') return null;
      packed += got[keys[i]];
    }
    const shared = unpackFromCache_(packed);
    return shared && shared.schemaVersion === BOOTSTRAP_SCHEMA_VERSION && Array.isArray(shared.vehicles) ? shared : null;
  } catch (e) {
    return null;
  }
}

/** Call after writing anything the shared part shows (odometer, recalls, ...). */
function invalidateBootstrapCache_() {
  CacheService.getScriptCache().remove(bootstrapCacheKey_());
}

// ---------------------------------------------------------------- users

/** Normalized App Users row → User (types.ts). */
function userView_(appUserRow, ownerEmail) {
  const email = lower_(appUserRow.email);
  const name = appUserRow.name || email.split('@')[0];
  return {
    email: email,
    name: name,
    driverName: appUserRow.driverName || name,
    defaultVehicle: appUserRow.defaultVehicle,
    prefs: appUserRow.prefs || {},
    isOwner: email !== '' && email === lower_(ownerEmail),
  };
}

/** The App Users row for an email (any case), ignoring Active. Prefers an active row. */
function findAppUserAny_(appUsers, email) {
  const e = lower_(email);
  if (!e) return null;
  const matches = (appUsers || []).filter(u => u.email === e);
  return matches.filter(u => u.active)[0] || matches[0] || null;
}

/** The App Users row for an email (any case), only when Active = Yes. */
function findAppUser_(appUsers, email) {
  const u = findAppUserAny_(appUsers, email);
  return u && u.active ? u : null;
}

/** Script Property OWNER_EMAIL, else the account the script runs as; lower-cased. */
function ownerEmail_() {
  return lower_(prop_(PROP.OWNER_EMAIL, false) || Session.getEffectiveUser().getEmail());
}

/** Name on the owner's App Users row (for "Check with <name>"), else "the owner". */
function ownerName_(D, ownerEmail) {
  const email = ownerEmail !== undefined ? ownerEmail : ownerEmail_();
  const row = findAppUserAny_(D && D.appUsers, email);
  return (row && row.name) || 'the owner';
}
