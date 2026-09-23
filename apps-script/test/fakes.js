'use strict';
/**
 * In-memory fakes of the Apps Script services the API uses, for Node tests:
 * SpreadsheetApp, CacheService, PropertiesService, Session and LockService.
 * They follow the real services' behaviour where tests can notice it
 * (getLastRow ignores trailing blank rows, setValues checks dimensions, cache
 * values over 100 KB are rejected, cache entries expire, ...).
 *
 * Usage:
 *   const { makeFakes } = require('./fakes');
 *   const fx = require('./fixtures/sheet');
 *   const fakes = makeFakes({ tabs: fx.tabs, props: { OWNER_EMAIL: fx.users.owner } });
 *   const gas = load({ files: [...], globals: fakes.globals });
 *   fakes.spreadsheet.getSheetByName('Odometer Readings').toValues();  // inspect writes
 *   fakes.clock.advance(301);                                           // expire cache entries
 *
 * Add fakes for other services (DriveApp, UrlFetchApp, ...) by passing
 * `extraGlobals`, or by adding them to fakes.globals before load().
 */

const CACHE_MAX_VALUE_BYTES = 100 * 1024;
const CACHE_MAX_KEY_CHARS = 250;
const CACHE_DEFAULT_TTL_SEC = 600;
const CACHE_MAX_TTL_SEC = 21600;

function cloneCell(v) {
  return v instanceof Date ? new Date(v.getTime()) : v;
}

function isBlank(v) {
  return v === '' || v === null || v === undefined;
}

/** "B3" → {row: 3, col: 2}; "AA10" → {row: 10, col: 27}. */
function parseA1Cell(a1) {
  const m = /^\$?([A-Z]+)\$?(\d+)$/i.exec(a1.trim());
  if (!m) throw new Error('Bad A1 reference: ' + a1);
  let col = 0;
  for (const ch of m[1].toUpperCase()) col = col * 26 + (ch.charCodeAt(0) - 64);
  return { row: +m[2], col };
}

function columnLetter(col) {
  let s = '';
  while (col > 0) {
    const r = (col - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    col = Math.floor((col - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------- SpreadsheetApp

class FakeRange {
  constructor(sheet, row, col, numRows, numCols) {
    if (row < 1 || col < 1 || numRows < 1 || numCols < 1) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    this.sheet = sheet;
    this.row = row;
    this.col = col;
    this.numRows = numRows;
    this.numCols = numCols;
  }

  getRow() { return this.row; }
  getColumn() { return this.col; }
  getNumRows() { return this.numRows; }
  getNumColumns() { return this.numCols; }
  getLastRow() { return this.row + this.numRows - 1; }
  getLastColumn() { return this.col + this.numCols - 1; }
  getSheet() { return this.sheet; }
  getA1Notation() {
    const tl = columnLetter(this.col) + this.row;
    return this.numRows === 1 && this.numCols === 1 ? tl
      : tl + ':' + columnLetter(this.getLastColumn()) + this.getLastRow();
  }

  forEachCell(fn) {
    for (let r = 0; r < this.numRows; r++) {
      for (let c = 0; c < this.numCols; c++) fn(this.row + r, this.col + c, r, c);
    }
  }

  getValues() {
    const out = [];
    for (let r = 0; r < this.numRows; r++) {
      const row = [];
      for (let c = 0; c < this.numCols; c++) row.push(this.sheet.cell(this.row + r, this.col + c));
      out.push(row);
    }
    return out;
  }

  getValue() { return this.sheet.cell(this.row, this.col); }

  getDisplayValues() {
    return this.getValues().map(row => row.map(v => (v instanceof Date ? v.toISOString() : String(v))));
  }

  setValues(values) {
    if (!Array.isArray(values) || values.length !== this.numRows) {
      throw new Error('The number of rows in the data does not match the number of rows in the range. ' +
        'The data has ' + (values && values.length) + ' but the range has ' + this.numRows + '.');
    }
    values.forEach(row => {
      if (!Array.isArray(row) || row.length !== this.numCols) {
        throw new Error('The number of columns in the data does not match the number of columns in the range. ' +
          'The data has ' + (row && row.length) + ' but the range has ' + this.numCols + '.');
      }
    });
    this.forEachCell((r, c, i, j) => this.sheet.write(r, c, values[i][j]));
    return this;
  }

  /** Like Range.setValue: every cell in the range gets the value. */
  setValue(v) {
    this.forEachCell((r, c) => this.sheet.write(r, c, v));
    return this;
  }

  clearContent() { return this.setValue(''); }

  getFormula() { return this.sheet.formulas[this.row + ':' + this.col] || ''; }
  getFormulas() {
    return this.getValues().map((row, i) => row.map((_, j) => this.sheet.formulas[(this.row + i) + ':' + (this.col + j)] || ''));
  }
  setFormula(f) {
    this.forEachCell((r, c) => { this.sheet.formulas[r + ':' + c] = f; this.sheet.touch(r, c); });
    return this;
  }
  setFormulas(fs) {
    this.forEachCell((r, c, i, j) => { this.sheet.formulas[r + ':' + c] = fs[i][j]; this.sheet.touch(r, c); });
    return this;
  }

  getNumberFormat() { return this.sheet.formats[this.row + ':' + this.col] || 'General'; }
  setNumberFormat(fmt) {
    this.forEachCell((r, c) => { this.sheet.formats[r + ':' + c] = fmt; });
    return this;
  }
  setNumberFormats(fmts) {
    this.forEachCell((r, c, i, j) => { this.sheet.formats[r + ':' + c] = fmts[i][j]; });
    return this;
  }

  /** Records the weight per cell in sheet.fontWeights ("row:col" → weight). */
  setFontWeight(w) {
    this.forEachCell((r, c) => { this.sheet.fontWeights[r + ':' + c] = w; });
    return this;
  }

  getNote() { return this.sheet.notes[this.row + ':' + this.col] || ''; }
  setNote(n) { this.forEachCell((r, c) => { this.sheet.notes[r + ':' + c] = n; }); return this; }
}

class FakeSheet {
  constructor(spreadsheet, name, values, formulas) {
    this.spreadsheet = spreadsheet;
    this.name = name;
    this.rows = (values || []).map(r => r.map(cloneCell));
    this.formulas = {};   // "row:col" → formula
    this.formats = {};    // "row:col" → number format
    this.notes = {};
    this.fontWeights = {};  // "row:col" → weight (setFontWeight)
    this.frozenRows = 0;
    this.maxColumns = 0;    // grown by insertColumnsAfter
    this.insertedColumns = [];
    this.writes = [];     // log of {row, col, value} for assertions
    Object.keys(formulas || {}).forEach(a1 => {
      const p = parseA1Cell(a1);
      this.formulas[p.row + ':' + p.col] = formulas[a1];
    });
  }

  getName() { return this.name; }
  getParent() { return this.spreadsheet; }
  getSheetId() { return this.spreadsheet.sheets.indexOf(this); }

  cell(row, col) {
    const r = this.rows[row - 1];
    const v = r ? r[col - 1] : undefined;
    return v === undefined || v === null ? '' : cloneCell(v);
  }

  /**
   * Like setValue / appendRow in Sheets: a string starting with "=" becomes a
   * FORMULA (which is why the API escapes outside text), and a leading
   * apostrophe forces plain text and is not part of the stored value.
   */
  write(row, col, value) {
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1];
    while (r.length < col) r.push('');
    delete this.formulas[row + ':' + col];  // a typed value replaces a formula
    this.writes.push({ row, col, value: cloneCell(value) });
    if (typeof value === 'string' && value.charAt(0) === "'") {
      r[col - 1] = value.slice(1);
    } else if (typeof value === 'string' && value.length > 1 && value.charAt(0) === '=') {
      this.formulas[row + ':' + col] = value;
      r[col - 1] = '#FORMULA';                // the fakes don't evaluate formulas
    } else {
      r[col - 1] = cloneCell(value === undefined || value === null ? '' : value);
    }
  }

  /** Makes sure a cell exists (so setFormula on an empty cell counts toward the extent). */
  touch(row, col) {
    while (this.rows.length < row) this.rows.push([]);
    const r = this.rows[row - 1];
    while (r.length < col) r.push('');
  }

  /** Last row with content (a formula counts), like Sheet.getLastRow(). */
  getLastRow() {
    for (let i = this.rows.length; i >= 1; i--) {
      if (this.rows[i - 1].some((v, j) => !isBlank(v) || this.formulas[i + ':' + (j + 1)])) return i;
    }
    return 0;
  }

  getLastColumn() {
    let last = 0;
    this.rows.forEach((r, i) => {
      for (let j = r.length; j > last; j--) {
        if (!isBlank(r[j - 1]) || this.formulas[(i + 1) + ':' + j]) { last = j; break; }
      }
    });
    return last;
  }

  getMaxRows() { return Math.max(this.getLastRow(), 1000); }
  getMaxColumns() { return Math.max(this.getLastColumn(), 26, this.maxColumns); }

  /**
   * Adds empty columns. The API may only ever add them at the very END of the
   * grid (setupSchema appends, never inserts), so anything else throws here.
   */
  insertColumnsAfter(after, n) {
    if (after !== this.getMaxColumns()) {
      throw new Error('fakes: columns may only be added after the last column (got ' + after + ', max ' +
        this.getMaxColumns() + ')');
    }
    if (!(n >= 1)) throw new Error('fakes: insertColumnsAfter needs a positive count');
    this.insertedColumns.push({ after, n });
    this.maxColumns = after + n;
    return this;
  }

  getRange(a, b, c, d) {
    if (typeof a === 'string') {
      const parts = a.split(':');
      const tl = parseA1Cell(parts[0]);
      const br = parts[1] ? parseA1Cell(parts[1]) : tl;
      return new FakeRange(this, tl.row, tl.col, br.row - tl.row + 1, br.col - tl.col + 1);
    }
    const range = new FakeRange(this, a, b, c === undefined ? 1 : c, d === undefined ? 1 : d);
    // Like Sheets: a range past the grid's last column throws (appendRow grows the grid; getRange doesn't).
    if (range.getLastColumn() > this.getMaxColumns()) {
      throw new Error('The coordinates of the range are outside the dimensions of the sheet.');
    }
    return range;
  }

  getDataRange() {
    return new FakeRange(this, 1, 1, Math.max(this.getLastRow(), 1), Math.max(this.getLastColumn(), 1));
  }

  appendRow(values) {
    const row = this.getLastRow() + 1;
    values.forEach((v, i) => this.write(row, i + 1, v));
    return this;
  }

  setFrozenRows(n) { this.frozenRows = n; }
  getFrozenRows() { return this.frozenRows; }
  activate() { return this; }

  /** Test helper: the sheet's current contents as getValues() would return them. */
  toValues() {
    const lr = this.getLastRow(), lc = this.getLastColumn();
    return lr && lc ? this.getRange(1, 1, lr, lc).getValues() : [];
  }

  /** Test helper: the formula in an A1 cell ('' when none). */
  formulaAt(a1) {
    const p = parseA1Cell(a1);
    return this.formulas[p.row + ':' + p.col] || '';
  }
}

class FakeSpreadsheet {
  /**
   * @param {string} id
   * @param {Object<string, any[][]>} tabs tab name → getValues()-style rows
   * @param {Object<string, Object<string, string>>} [formulas] tab name → {A1: formula}
   */
  constructor(id, tabs, formulas) {
    this.id = id;
    this.sheets = Object.keys(tabs || {}).map(name => new FakeSheet(this, name, tabs[name], (formulas || {})[name]));
  }

  getId() { return this.id; }
  getName() { return 'Vehicle Maintenance Journal (test)'; }
  getSpreadsheetTimeZone() { return 'America/Chicago'; }
  getSheets() { return this.sheets.slice(); }
  getSheetByName(name) { return this.sheets.filter(s => s.name === name)[0] || null; }

  insertSheet(name) {
    if (this.getSheetByName(name)) {
      throw new Error('A sheet with the name "' + name + '" already exists. Please enter another name.');
    }
    const sh = new FakeSheet(this, name, []);
    this.sheets.push(sh);
    return sh;
  }
}

function makeSpreadsheetApp(spreadsheet) {
  return {
    opened: 0,
    openById(id) {
      if (id !== spreadsheet.id) throw new Error('Unexpected spreadsheet ID: ' + id);
      this.opened++;
      return spreadsheet;
    },
    getActive() { return null; },            // the API is a standalone project
    getActiveSpreadsheet() { return null; },
    flush() {},
  };
}

// ---------------------------------------------------------------- CacheService

class FakeCache {
  constructor(clock) {
    this.clock = clock;
    this.entries = new Map();  // key → {value, expires}
  }

  checkKey(key) {
    if (typeof key !== 'string' || key.length === 0 || key.length > CACHE_MAX_KEY_CHARS) {
      throw new Error('Argument too large: key');
    }
  }

  get(key) {
    this.checkKey(key);
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expires <= this.clock.now()) { this.entries.delete(key); return null; }
    return e.value;
  }

  getAll(keys) {
    const out = {};
    keys.forEach(k => {
      const v = this.get(k);
      if (v !== null) out[k] = v;
    });
    return out;
  }

  put(key, value, ttlSec) {
    this.checkKey(key);
    const s = String(value);
    if (Buffer.byteLength(s, 'utf8') > CACHE_MAX_VALUE_BYTES) throw new Error('Argument too large: value');
    const ttl = Math.min(ttlSec === undefined ? CACHE_DEFAULT_TTL_SEC : ttlSec, CACHE_MAX_TTL_SEC);
    this.entries.set(key, { value: s, expires: this.clock.now() + ttl * 1000 });
  }

  putAll(values, ttlSec) {
    Object.keys(values).forEach(k => this.put(k, values[k], ttlSec));
  }

  remove(key) { this.entries.delete(key); }
  removeAll(keys) { keys.forEach(k => this.entries.delete(k)); }
}

// ---------------------------------------------------------------- PropertiesService

class FakeProperties {
  constructor(initial) {
    this.map = new Map(Object.entries(initial || {}).map(([k, v]) => [k, String(v)]));
  }
  getProperty(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setProperty(k, v) { this.map.set(k, String(v)); return this; }
  setProperties(obj, deleteAllOthers) {
    if (deleteAllOthers) this.map.clear();
    Object.keys(obj).forEach(k => this.map.set(k, String(obj[k])));
    return this;
  }
  getProperties() { return Object.fromEntries(this.map); }
  getKeys() { return Array.from(this.map.keys()); }
  deleteProperty(k) { this.map.delete(k); return this; }
  deleteAllProperties() { this.map.clear(); return this; }
}

// ---------------------------------------------------------------- clock, Session, LockService

/** A controllable clock for cache expiry. Pass `start` (ms) to fix it, else it follows real time. */
function makeClock(start) {
  let offset = 0;
  const base = start === undefined ? null : start;
  return {
    now: () => (base === null ? Date.now() : base) + offset,
    advance(sec) { offset += sec * 1000; },
  };
}

function makeSession(effectiveEmail, activeEmail) {
  return {
    getEffectiveUser: () => ({ getEmail: () => effectiveEmail }),
    getActiveUser: () => ({ getEmail: () => activeEmail || '' }),
    getScriptTimeZone: () => 'America/Chicago',
    getTemporaryActiveUserKey: () => 'fake-temp-user-key',
  };
}

function makeLock() {
  let held = false;
  return {
    tryLock() { held = true; return true; },
    waitLock() { held = true; },
    releaseLock() { held = false; },
    hasLock() { return held; },
  };
}

// ---------------------------------------------------------------- all together

/**
 * @param {object} [opts]
 * @param {Object<string, any[][]>} [opts.tabs] the journal (e.g. fixture.tabs); cloned
 * @param {Object<string, Object<string, string>>} [opts.formulas] tab → {A1: formula}
 * @param {string} [opts.sheetId] Script Property SHEET_ID (default 'test-sheet-id')
 * @param {Object<string, string>} [opts.props] more Script Properties
 * @param {string} [opts.effectiveUser] Session.getEffectiveUser() email
 * @param {number} [opts.now] fixed clock start in ms (default: real time)
 * @param {object} [opts.extraGlobals] more fake services to expose
 */
function makeFakes(opts = {}) {
  const sheetId = opts.sheetId || 'test-sheet-id';
  const clock = makeClock(opts.now);
  const spreadsheet = new FakeSpreadsheet(sheetId, opts.tabs || {}, opts.formulas);
  const scriptProperties = new FakeProperties(Object.assign({ SHEET_ID: sheetId }, opts.props || {}));
  const userProperties = new FakeProperties();
  const scriptCache = new FakeCache(clock);
  const userCache = new FakeCache(clock);
  const scriptLock = makeLock();
  const globals = Object.assign({
    SpreadsheetApp: makeSpreadsheetApp(spreadsheet),
    CacheService: {
      getScriptCache: () => scriptCache,
      getUserCache: () => userCache,
      getDocumentCache: () => null,
    },
    PropertiesService: {
      getScriptProperties: () => scriptProperties,
      getUserProperties: () => userProperties,
      getDocumentProperties: () => null,
    },
    Session: makeSession(opts.effectiveUser || 'owner@example.com'),
    LockService: {
      getScriptLock: () => scriptLock,
      getUserLock: () => makeLock(),
      getDocumentLock: () => null,
    },
  }, opts.extraGlobals || {});
  return { globals, spreadsheet, scriptCache, userCache, scriptProperties, userProperties, clock };
}

module.exports = {
  makeFakes,
  makeClock,
  FakeSpreadsheet,
  FakeSheet,
  FakeRange,
  FakeCache,
  FakeProperties,
  parseA1Cell,
  columnLetter,
  CACHE_MAX_VALUE_BYTES,
};
