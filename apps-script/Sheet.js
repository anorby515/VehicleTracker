/**
 * Sheet access. Every tab is read by HEADER NAME, never by column position.
 *
 * Guardrail: rows may only be appended/updated on the app-owned tabs listed in
 * APP_OWNED_TABS (Config.js). Journal tabs are read-only here. The one-off
 * schema/formula changes in Setup.js use their own explicitly-guarded writers.
 */

let journal_ = null;

/** The journal Spreadsheet, opened by ID (never getActive: this is a standalone project). */
function openJournal_() {
  if (!journal_) journal_ = SpreadsheetApp.openById(prop_(PROP.SHEET_ID, true));
  return journal_;
}

/** Reads a Script Property; throws a clear error when a required one is missing. */
function prop_(name, required) {
  const v = PropertiesService.getScriptProperties().getProperty(name);
  if (required && !v) throw new Error('Script Property ' + name + ' is not set (see SETUP.md).');
  return v || null;
}

/**
 * Builds a tab object from getValues()-style data (row 0 = headers).
 * Pure: used by readTab_ and by the unit-test fixtures.
 *
 * @return {{name: string, headers: string[], col: Object<string, number>, rows: Object[]}}
 *   col maps header → 1-based column; each row object maps header → raw cell
 *   value and carries `_row` (1-based sheet row number).
 */
function tabFromValues_(name, values) {
  const headers = (values[0] || []).map(h => String(h).trim());
  const col = {};
  headers.forEach((h, i) => { if (h && !(h in col)) col[h] = i + 1; });
  const rows = [];
  for (let r = 1; r < values.length; r++) {
    const raw = values[r];
    if (!raw || raw.every(v => v === '' || v === null || v === undefined)) continue;
    const obj = { _row: r + 1 };
    headers.forEach((h, i) => { if (h) obj[h] = raw[i] === undefined ? '' : raw[i]; });
    rows.push(obj);
  }
  return { name: name, headers: headers, col: col, rows: rows };
}

/** Reads one tab. Returns null when the tab doesn't exist (unless required). */
function readTab_(name, required) {
  const sh = openJournal_().getSheetByName(name);
  if (!sh) {
    if (required) throw new Error('Tab "' + name + '" not found in the journal Sheet.');
    return null;
  }
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 1 || lastCol < 1) return tabFromValues_(name, [[]]);
  return tabFromValues_(name, sh.getRange(1, 1, lastRow, lastCol).getValues());
}

/** Reads several tabs; missing ones come back as empty tabs. */
function readTabs_(names) {
  const out = {};
  names.forEach(n => { out[n] = readTab_(n, false) || tabFromValues_(n, [[]]); });
  return out;
}

// ---------------------------------------------------------------- cell value converters (pure)

/** '' / null / undefined / whitespace → null; strings trimmed; everything else as is. */
function blankToNull_(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') { const t = v.trim(); return t === '' ? null : t; }
  return v;
}

function asStr_(v) {
  v = blankToNull_(v);
  if (v === null) return null;
  if (v instanceof Date) return ymdFromDate_(v);
  return String(v);
}

/** Numbers from cells: 36427, "36,427", "$1,518.98" → number; anything else → null. */
function asNum_(v) {
  v = blankToNull_(v);
  if (v === null) return null;
  if (typeof v === 'number') return isFinite(v) ? v : null;
  const s = String(v).replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  return +s;
}

function asInt_(v) {
  const n = asNum_(v);
  return n === null ? null : Math.round(n);
}

/** Dates from cells: Date objects or "YYYY-MM-DD" strings → "YYYY-MM-DD"; else null. */
function asYmd_(v) {
  v = blankToNull_(v);
  if (v === null) return null;
  if (v instanceof Date) return ymdFromDate_(v);
  const s = String(v);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return m[1] + '-' + m[2] + '-' + m[3];
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s); // US m/d/yyyy typed by hand
  if (m) return m[3] + '-' + pad2_(+m[1]) + '-' + pad2_(+m[2]);
  return null;
}

/** Timestamps: Date → ISO with Chicago offset; strings passed through. */
function asIso_(v) {
  v = blankToNull_(v);
  if (v === null) return null;
  if (v instanceof Date) return isoFromDate_(v);
  return String(v);
}

/** "Yes"/"No" (any case) → true/false; blank/other → null. */
function asYesNo_(v) {
  const s = (asStr_(v) || '').toLowerCase();
  if (s === 'yes' || s === 'y' || s === 'true') return true;
  if (s === 'no' || s === 'n' || s === 'false') return false;
  return null;
}

function lower_(v) {
  return (asStr_(v) || '').toLowerCase();
}

// ---------------------------------------------------------------- guarded writes (app-owned tabs only)

/**
 * A value as the app writes it: strings that Sheets would read as a formula
 * (or as a signed number / an @-reference) get a leading apostrophe, which
 * makes Sheets store them as plain text (the apostrophe isn't part of the
 * value). Text from the phone (odometer notes, reading IDs) and from NHTSA
 * must never become a live formula such as =IMPORTXML(...) or =HYPERLINK(...).
 */
function sheetSafe_(v) {
  return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v;
}

function assertAppOwned_(name) {
  if (APP_OWNED_TABS.indexOf(name) === -1) {
    throw new Error('Refusing to write to "' + name + '": the app only writes to its own tabs.');
  }
}

/** Sheet object for an app-owned tab; throws if the tab is missing (run setupSchema). */
function appSheet_(name) {
  assertAppOwned_(name);
  const sh = openJournal_().getSheetByName(name);
  if (!sh) throw new Error('Tab "' + name + '" is missing. Run setupSchemaApply() (see SETUP.md).');
  return sh;
}

function headerMap_(sh) {
  const lastCol = sh.getLastColumn();
  const map = {};
  if (lastCol < 1) return map;
  sh.getRange(1, 1, 1, lastCol).getValues()[0].forEach((h, i) => {
    const k = String(h).trim();
    if (k && !(k in map)) map[k] = i + 1;
  });
  return map;
}

/**
 * Appends one row to an app-owned tab. `obj` maps header → value; unknown
 * headers are ignored, missing ones left blank. Applies NEW_COLUMN_FORMATS.
 * Returns the new row number.
 */
function appendAppRow_(name, obj) {
  const sh = appSheet_(name);
  const h = headerMap_(sh);
  const width = Math.max(sh.getLastColumn(), 1);
  const row = new Array(width).fill('');
  Object.keys(obj).forEach(k => {
    if (h[k] && obj[k] !== undefined && obj[k] !== null) row[h[k] - 1] = sheetSafe_(obj[k]);
  });
  sh.appendRow(row);
  const r = sh.getLastRow();
  Object.keys(h).forEach(k => {
    if (NEW_COLUMN_FORMATS[k] && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') {
      sh.getRange(r, h[k]).setNumberFormat(NEW_COLUMN_FORMATS[k]);
    }
  });
  return r;
}

/** Updates named cells on one row of an app-owned tab. */
function updateAppRow_(name, rowNumber, obj) {
  const sh = appSheet_(name);
  const h = headerMap_(sh);
  Object.keys(obj).forEach(k => {
    if (!h[k] || obj[k] === undefined) return;
    const cell = sh.getRange(rowNumber, h[k]);
    cell.setValue(obj[k] === null ? '' : sheetSafe_(obj[k]));
    if (NEW_COLUMN_FORMATS[k] && obj[k] !== null && obj[k] !== '') cell.setNumberFormat(NEW_COLUMN_FORMATS[k]);
  });
}

/** Runs fn while holding the script lock (serialises writers across requests/jobs). */
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Busy, please try again.');
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}
