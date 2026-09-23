/**
 * Setup functions, run by hand from the Apps Script editor (docs/API.md
 * "Setup functions", spec 5.3 / 5.4, SETUP.md steps 4-7).
 *
 *   setupSchema()       dry run: lists every change in the Log tab, changes nothing
 *   setupSchemaApply()  the same with {apply: true} (the Run button can't pass arguments)
 *   installTriggers()   this project's jobScanStatus (30 min) and jobDaily (07:30) timers
 *   checkSetup()        PASS/FAIL report on Script Properties, Drive folders and the Sheet
 *
 * setupSchema is idempotent: a second apply finds nothing to do and logs
 * "No changes needed". It only ever:
 *   - creates the app-owned tabs, and appends missing headers at their end;
 *   - appends the new Vehicles / Warranties columns at the END (never inserts,
 *     moves, renames or deletes anything);
 *   - seeds App Users from Script Property SEED_APP_USERS when it has no rows;
 *   - fills a BLANK Photo File ID with "<Vehicle> - Photo.<ext>" from the
 *     vehicle's Drive folder;
 *   - adds the Latest Odometer / Latest Odometer Date formulas, then replaces
 *     Avg Miles/Day and Est. Current Mileage, but only where the live formula
 *     is exactly the one expected (the old text goes to the Log first).
 *     Anything unexpected is SKIPPED with a WARN, never guessed at.
 * Those writes all go through the small privileged writer below, whose
 * allowlist is checked on every call. Last Visit Date, Last Known Mileage,
 * the journal tabs' data, the ingestion script and its trigger are never
 * touched.
 */

const SETUP_LOG_SOURCE_ = 'app-setup';
const SETUP_PHOTO_EXTENSIONS_ = ['png', 'jpg', 'jpeg', 'webp'];
const SETUP_JOB_HANDLERS_ = ['jobScanStatus', 'jobDaily'];

/**
 * Dry run unless opts.apply === true.
 * @return {{apply: boolean, changes: number, warnings: number, lines: {level: string, message: string}[]}}
 */
function setupSchema(opts) {
  const run = newSetupRun_(!!(opts && opts.apply === true));
  setupLog_(run, 'INFO', 'setupSchema ' + (run.apply ? 'apply' : 'dry run') + ' started (App API ' + APP_VERSION + ')');
  try {
    // Order matters in apply mode: Odometer Readings and the Latest Odometer
    // columns (and their formulas) exist before Avg Miles/Day / Est. Current
    // Mileage are pointed at them.
    setupAppTabs_(run);
    setupJournalColumns_(run, TAB.VEHICLES, NEW_VEHICLE_COLUMNS);
    setupJournalColumns_(run, TAB.WARRANTIES, NEW_WARRANTY_COLUMNS);
    setupSeedAppUsers_(run);
    setupSeedPhotos_(run);
    setupMileageFormulas_(run);
  } catch (e) {
    setupWarn_(run, 'STOPPED: ' + (e && e.message || e) + '. Nothing after this line was ' +
      (run.apply ? 'done' : 'checked') + '.');
    throw e;
  }
  setupLog_(run, 'INFO', setupSummary_(run));
  return { apply: run.apply, changes: run.changes, warnings: run.warnings, lines: run.lines };
}

function setupSchemaApply() {
  return setupSchema({ apply: true });
}

function setupSummary_(run) {
  const warn = run.warnings ? ' (' + run.warnings + ' warning' + (run.warnings === 1 ? '' : 's') + ' above)' : '';
  if (!run.changes) return 'No changes needed' + warn;
  const n = run.changes + ' change' + (run.changes === 1 ? '' : 's');
  return run.apply
    ? 'Done: ' + n + ' made' + warn + '.'
    : 'Dry run: ' + n + ' listed above' + warn + '. Nothing was changed. Run setupSchemaApply() to make them.';
}

// ---------------------------------------------------------------- run state and logging

function newSetupRun_(apply) {
  const ss = openJournal_();
  return {
    ss: ss,
    apply: apply,
    changes: 0,
    warnings: 0,
    lines: [],
    logSheet: ss.getSheetByName(TAB.LOG),
    planned: {},  // dry run: tab name → headers as they WOULD be
  };
}

/** Log tab row [Timestamp, 'app-setup', level, message], plus the execution log. */
function setupLog_(run, level, message) {
  run.lines.push({ level: level, message: message });
  console.log(level + ' ' + message);
  if (!run.logSheet) return;
  // A message must never be read as a formula.
  const text = /^[=+\-@]/.test(message) ? "'" + message : message;
  run.logSheet.appendRow([new Date(), SETUP_LOG_SOURCE_, level, text]);
}

/** One change: "WOULD ..." in a dry run, "DID ..." once done. */
function setupChange_(run, message) {
  run.changes++;
  setupLog_(run, 'INFO', (run.apply ? 'DID ' : 'WOULD ') + message);
}

function setupWarn_(run, message) {
  run.warnings++;
  setupLog_(run, 'WARN', message);
}

// ---------------------------------------------------------------- privileged writer (the only Sheet writes)

/**
 * Guards every write setupSchema makes (besides the Log). A dry run never
 * writes; in apply mode only these operations are allowed:
 *   createTab     a tab named in APP_TAB_HEADERS
 *   appendHeader  a NEW_VEHICLE_COLUMNS / NEW_WARRANTY_COLUMNS header on
 *                 Vehicles / Warranties, or an APP_TAB_HEADERS header on its app tab
 *   formula       Vehicles › Latest Odometer, Latest Odometer Date, Avg Miles/Day, Est. Current Mileage
 *   photo         Vehicles › Photo File ID (blank cells only)
 *   seedUsers     App Users (only while it has no data rows)
 */
function assertSetupWrite_(run, op, tabName, header) {
  if (!run.apply) throw new Error('setupSchema dry run: refusing to write (' + op + ' on ' + tabName + ').');
  let ok = false;
  switch (op) {
    case 'createTab':
      ok = Object.prototype.hasOwnProperty.call(APP_TAB_HEADERS, tabName);
      break;
    case 'appendHeader':
      if (tabName === TAB.VEHICLES) ok = NEW_VEHICLE_COLUMNS.indexOf(header) !== -1;
      else if (tabName === TAB.WARRANTIES) ok = NEW_WARRANTY_COLUMNS.indexOf(header) !== -1;
      else ok = (APP_TAB_HEADERS[tabName] || []).indexOf(header) !== -1;
      break;
    case 'formula':
      ok = tabName === TAB.VEHICLES &&
        ['Latest Odometer', 'Latest Odometer Date', 'Avg Miles/Day', 'Est. Current Mileage'].indexOf(header) !== -1;
      break;
    case 'photo':
      ok = tabName === TAB.VEHICLES && header === 'Photo File ID';
      break;
    case 'seedUsers':
      ok = tabName === TAB.APP_USERS;
      break;
  }
  if (!ok) throw new Error('setupSchema: "' + op + '" is not allowed on ' + tabName + (header ? ' › ' + header : '') + '.');
}

/** New app-owned tab at the end of the tab list: bold, frozen header row, column formats. */
function setupWriteCreateTab_(run, name) {
  assertSetupWrite_(run, 'createTab', name);
  const headers = APP_TAB_HEADERS[name];
  const sh = run.ss.insertSheet(name, run.ss.getSheets().length);
  sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
  sh.setFrozenRows(1);
  setupWriteColumnFormats_(sh, headers, 1);
  return sh;
}

/** Headers appended after the last used column (adding sheet columns at the end when needed). */
function setupWriteAppendHeaders_(run, sh, tabName, headers, startCol) {
  headers.forEach(h => assertSetupWrite_(run, 'appendHeader', tabName, h));
  const lastNeeded = startCol + headers.length - 1;
  const maxCols = sh.getMaxColumns();
  if (lastNeeded > maxCols) sh.insertColumnsAfter(maxCols, lastNeeded - maxCols);
  sh.getRange(1, startCol, 1, headers.length).setValues([headers]).setFontWeight('bold');
  setupWriteColumnFormats_(sh, headers, startCol);
}

/** NEW_COLUMN_FORMATS for the data cells (row 2 down) of freshly added columns. */
function setupWriteColumnFormats_(sh, headers, startCol) {
  const rows = sh.getMaxRows() - 1;
  if (rows < 1) return;
  headers.forEach((h, i) => {
    if (NEW_COLUMN_FORMATS[h]) sh.getRange(2, startCol + i, rows, 1).setNumberFormat(NEW_COLUMN_FORMATS[h]);
  });
}

function setupWriteFormula_(run, sh, row, col, header, formula, numberFormat) {
  assertSetupWrite_(run, 'formula', sh.getName(), header);
  const cell = sh.getRange(row, col);
  cell.setFormula(formula);
  if (numberFormat) cell.setNumberFormat(numberFormat);
}

/** Sets Photo File ID only when the cell is still blank; returns whether it did. */
function setupWritePhoto_(run, sh, row, col, fileId) {
  assertSetupWrite_(run, 'photo', sh.getName(), 'Photo File ID');
  const cell = sh.getRange(row, col);
  if (String(cell.getValue()).trim() !== '' || cell.getFormula()) return false;
  cell.setValue(fileId);
  return true;
}

/** Appends seed rows to App Users, refusing if it has any data rows. */
function setupWriteSeedUsers_(run, sh, rowObjects) {
  assertSetupWrite_(run, 'seedUsers', sh.getName());
  if (setupDataRowCount_(sh) > 0) throw new Error('App Users already has rows; not seeding.');
  const headers = setupSheetHeaders_(sh);
  rowObjects.forEach(o => sh.appendRow(headers.map(h => (h in o ? o[h] : ''))));
}

// ---------------------------------------------------------------- header helpers

/** Row-1 headers (trimmed), one per used column. */
function setupSheetHeaders_(sh) {
  const lastCol = sh.getLastColumn();
  if (lastCol < 1) return [];
  return sh.getRange(1, 1, 1, lastCol).getValues()[0].map(h => String(h).trim());
}

/** Headers of a tab as they are, or as they WOULD be after this dry run's planned changes; null if no tab. */
function setupHeaders_(run, tabName) {
  if (run.planned[tabName]) return run.planned[tabName];
  const sh = run.ss.getSheetByName(tabName);
  return sh ? setupSheetHeaders_(sh) : null;
}

/** Data rows (any non-blank cell below the header). */
function setupDataRowCount_(sh) {
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2 || lastCol < 1) return 0;
  return tabFromValues_(sh.getName(), sh.getRange(1, 1, lastRow, lastCol).getValues()).rows.length;
}

/** 1 → "A", 27 → "AA", 41 → "AO". */
function colLetter_(n) {
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ---------------------------------------------------------------- tabs and columns

/** Creates missing app tabs; appends any missing header at the end of existing ones. */
function setupAppTabs_(run) {
  Object.keys(APP_TAB_HEADERS).forEach(name => {
    const want = APP_TAB_HEADERS[name];
    const sh = run.ss.getSheetByName(name);
    if (!sh) {
      if (run.apply) setupWriteCreateTab_(run, name);
      else run.planned[name] = want.slice();
      setupChange_(run, 'create tab "' + name + '" with headers: ' + want.join(', '));
      return;
    }
    setupAppendMissing_(run, sh, name, want);
  });
}

/** New columns on a journal tab (Vehicles, Warranties), appended at the end. */
function setupJournalColumns_(run, tabName, wanted) {
  const sh = run.ss.getSheetByName(tabName);
  if (!sh) {
    setupWarn_(run, 'SKIPPED the new ' + tabName + ' columns: there is no "' + tabName + '" tab.');
    return;
  }
  setupAppendMissing_(run, sh, tabName, wanted);
}

function setupAppendMissing_(run, sh, tabName, wanted) {
  const have = setupSheetHeaders_(sh);
  const missing = wanted.filter(h => have.indexOf(h) === -1);
  if (!missing.length) return;
  const start = have.length + 1;
  if (run.apply) setupWriteAppendHeaders_(run, sh, tabName, missing, start);
  else run.planned[tabName] = have.concat(missing);
  missing.forEach((h, i) => {
    setupChange_(run, 'append column ' + colLetter_(start + i) + ' "' + h + '" at the end of ' + tabName);
  });
}

// ---------------------------------------------------------------- App Users seed

/**
 * Seeds App Users from Script Property SEED_APP_USERS (JSON array of
 * {email, name, driverName, defaultVehicle}) when the tab has no data rows.
 * The real emails live only in that property, never in the repo.
 */
function setupSeedAppUsers_(run) {
  const sh = run.ss.getSheetByName(TAB.APP_USERS);
  if (sh && setupDataRowCount_(sh) > 0) return;

  const raw = prop_(PROP.SEED_APP_USERS, false);
  const byHand = 'Andrew: add the family rows to App Users by hand (Email, Name, Default Vehicle, ' +
    'Active = Yes, Notification Prefs = {}, Driver Name), or set it and run setupSchemaApply() again.';
  if (!raw) {
    setupWarn_(run, 'App Users is empty and Script Property SEED_APP_USERS is not set. ' + byHand);
    return;
  }
  let list;
  try { list = JSON.parse(raw); } catch (e) { list = null; }
  if (!Array.isArray(list)) {
    setupWarn_(run, 'Script Property SEED_APP_USERS is not a JSON array, so App Users was not seeded. ' + byHand);
    return;
  }
  const vehicleNames = setupVehicleNames_(run);
  const rows = [];
  list.forEach((u, i) => {
    const email = u && typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
    if (!/^[^@\s]+@[^@\s]+$/.test(email)) {
      setupWarn_(run, 'SEED_APP_USERS entry ' + (i + 1) + ' has no valid email; left out.');
      return;
    }
    const defaultVehicle = u.defaultVehicle ? String(u.defaultVehicle).trim() : '';
    if (defaultVehicle && vehicleNames.indexOf(defaultVehicle) === -1) {
      setupWarn_(run, 'SEED_APP_USERS entry ' + (i + 1) + ': Default Vehicle "' + defaultVehicle +
        '" is not a Vehicles name (seeded anyway; fix it on App Users).');
    }
    rows.push({
      'Email': email,
      'Name': u.name ? String(u.name).trim() : '',
      'Default Vehicle': defaultVehicle,
      'Active': 'Yes',
      'Notification Prefs': '{}',
      'Driver Name': u.driverName ? String(u.driverName).trim() : '',
    });
  });
  if (!rows.length) {
    setupWarn_(run, 'SEED_APP_USERS has no usable entries, so App Users was not seeded. ' + byHand);
    return;
  }
  if (run.apply) setupWriteSeedUsers_(run, run.ss.getSheetByName(TAB.APP_USERS), rows);
  setupChange_(run, 'seed App Users with ' + rows.length + ' row' + (rows.length === 1 ? '' : 's') +
    ' from SEED_APP_USERS: ' + rows.map(r => r['Name'] || '(no name)').join(', '));
}

function setupVehicleNames_(run) {
  const sh = run.ss.getSheetByName(TAB.VEHICLES);
  if (!sh || sh.getLastRow() < 2) return [];
  const col = setupSheetHeaders_(sh).indexOf('Vehicle') + 1;
  if (!col) return [];
  return sh.getRange(2, col, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()).filter(Boolean);
}

// ---------------------------------------------------------------- Photo File ID seed

/**
 * For each Vehicles row with a blank Photo File ID: the one image named
 * exactly "<Vehicle> - Photo.<png|jpg|jpeg|webp>" in the ROOT of its Drive
 * Folder ID (Cowork files receipts into year subfolders, which are ignored).
 * No match or several matches → WARN, nothing set.
 */
function setupSeedPhotos_(run) {
  const sh = run.ss.getSheetByName(TAB.VEHICLES);
  const headers = setupHeaders_(run, TAB.VEHICLES);
  if (!sh || !headers) return;
  const photoCol = headers.indexOf('Photo File ID') + 1;
  const vehicleCol = headers.indexOf('Vehicle') + 1;
  const folderCol = headers.indexOf('Drive Folder ID') + 1;
  if (!photoCol) return;
  if (!vehicleCol || !folderCol) {
    setupWarn_(run, 'SKIPPED Photo File ID: Vehicles has no "Vehicle" or "Drive Folder ID" column.');
    return;
  }
  const lastRow = sh.getLastRow(), lastCol = sh.getLastColumn();
  if (lastRow < 2) return;
  const values = sh.getRange(2, 1, lastRow - 1, lastCol).getValues();
  values.forEach((row, i) => {
    const r = i + 2;
    const name = String(row[vehicleCol - 1]).trim();
    if (!name) return;
    const current = photoCol <= lastCol ? String(row[photoCol - 1]).trim() : '';
    if (current) return;
    const where = colLetter_(photoCol) + r + ' (' + name + ')';
    const folderId = String(row[folderCol - 1]).trim();
    if (!folderId) {
      setupWarn_(run, 'Photo File ID ' + where + ' left blank: the vehicle has no Drive Folder ID.');
      return;
    }
    let matches;
    try {
      matches = setupFindVehiclePhotos_(folderId, name);
    } catch (e) {
      setupWarn_(run, 'Photo File ID ' + where + " left blank: couldn't open its Drive folder (" + e.message + ').');
      return;
    }
    if (matches.length !== 1) {
      setupWarn_(run, 'Photo File ID ' + where + ' left blank: found ' + matches.length + ' files named "' + name +
        ' - Photo.png/.jpg/.jpeg/.webp" in its folder' + (matches.length ? ' (' + matches.map(m => m.name).join(', ') + ')' : '') +
        '. Paste the photo\'s file ID by hand.');
      return;
    }
    if (run.apply && !setupWritePhoto_(run, sh, r, photoCol, matches[0].id)) return;
    setupChange_(run, 'set Photo File ID ' + where + ' to "' + matches[0].name + '" (' + matches[0].id + ')');
  });
}

/** Image files directly in the folder named "<vehicle> - Photo.<ext>" (extension in any case). */
function setupFindVehiclePhotos_(folderId, vehicleName) {
  const prefix = vehicleName + ' - Photo.';
  const out = [];
  const files = DriveApp.getFolderById(folderId).getFiles();  // this folder only, not subfolders
  while (files.hasNext()) {
    const f = files.next();
    const n = f.getName();
    if (n.indexOf(prefix) !== 0) continue;
    if (SETUP_PHOTO_EXTENSIONS_.indexOf(n.slice(prefix.length).toLowerCase()) === -1) continue;
    if (!/^image\//.test(String(f.getMimeType())) || f.isTrashed()) continue;
    out.push({ id: f.getId(), name: n });
  }
  return out;
}

// ---------------------------------------------------------------- mileage formulas (spec 5.3)

/** "Visits" → "Visits!", "Odometer Readings" → "'Odometer Readings'!". */
function sheetRef_(name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name + '!' : "'" + name.replace(/'/g, "''") + "'!";
}

/**
 * Column letters for the formulas, from the headers (never hard-coded).
 * @return {object} {VEH, PD, PM, LVD, LKM, AVG, EST, LO, LD, VV, VD, VM, OV, OD, OM} letters,
 *   the same keys + "Col" as column numbers, and `missing` (["Tab › Header", ...]).
 */
function formulaLetters_(vehicleHeaders, visitHeaders, odometerHeaders) {
  const need = [
    ['VEH', vehicleHeaders, TAB.VEHICLES, 'Vehicle'],
    ['PD', vehicleHeaders, TAB.VEHICLES, 'Purchase Date'],
    ['PM', vehicleHeaders, TAB.VEHICLES, 'Purchase Mileage'],
    ['LVD', vehicleHeaders, TAB.VEHICLES, 'Last Visit Date'],
    ['LKM', vehicleHeaders, TAB.VEHICLES, 'Last Known Mileage'],
    ['AVG', vehicleHeaders, TAB.VEHICLES, 'Avg Miles/Day'],
    ['EST', vehicleHeaders, TAB.VEHICLES, 'Est. Current Mileage'],
    ['LO', vehicleHeaders, TAB.VEHICLES, 'Latest Odometer'],
    ['LD', vehicleHeaders, TAB.VEHICLES, 'Latest Odometer Date'],
    ['VV', visitHeaders, TAB.VISITS, 'Vehicle'],
    ['VD', visitHeaders, TAB.VISITS, 'Date'],
    ['VM', visitHeaders, TAB.VISITS, 'Mileage'],
    ['OV', odometerHeaders, TAB.ODOMETER_READINGS, 'Vehicle'],
    ['OD', odometerHeaders, TAB.ODOMETER_READINGS, 'Date'],
    ['OM', odometerHeaders, TAB.ODOMETER_READINGS, 'Mileage'],
  ];
  const L = { missing: [] };
  need.forEach(n => {
    const i = (n[1] || []).indexOf(n[3]);
    if (i === -1) {
      L.missing.push(n[2] + ' › ' + n[3]);
      return;
    }
    L[n[0]] = colLetter_(i + 1);
    L[n[0] + 'Col'] = i + 1;
  });
  return L;
}

/**
 * The expected formula texts for Vehicles row r. Pure.
 *   oldAvg / oldEst  the live Avg Miles/Day and Est. Current Mileage formulas
 *   lo / ld          the new Latest Odometer / Latest Odometer Date formulas
 *   newAvg / newEst  the replacements, reading Latest Odometer (Date)
 */
function vehicleFormulas_(L, r) {
  const V = sheetRef_(TAB.VISITS);
  const O = sheetRef_(TAB.ODOMETER_READINGS);
  const veh = '$' + L.VEH + r;
  const col = k => '$' + L[k] + ':$' + L[k];
  const [PD, PM, LVD, LKM, AVG, LO, LD] = ['PD', 'PM', 'LVD', 'LKM', 'AVG', 'LO', 'LD'].map(k => L[k] + r);
  return {
    oldAvg: `=IFERROR(IF(OR(${PD}="",${PM}="",${LVD}="",${LKM}=""),"",ROUND((${LKM}-${PM})/(${LVD}-${PD}),1)),"")`,
    oldEst: `=IFERROR(IF(OR(${LKM}="",${AVG}=""),${LKM},ROUND(${LKM}+${AVG}*(TODAY()-${LVD}),0)),"")`,
    lo: `=IFERROR(LET(v,MAXIFS(${V}${col('VM')},${V}${col('VV')},${veh}),` +
      `o,MAXIFS(${O}${col('OM')},${O}${col('OV')},${veh}),m,MAX(v,o),IF(m=0,"",m)),"")`,
    ld: `=IFERROR(IF(${LO}="","",LET(d,MAX(MAXIFS(${V}${col('VD')},${V}${col('VV')},${veh},${V}${col('VM')},${LO}),` +
      `MAXIFS(${O}${col('OD')},${O}${col('OV')},${veh},${O}${col('OM')},${LO})),IF(d=0,"",d))),"")`,
    newAvg: `=IFERROR(IF(OR(${PD}="",${PM}="",${LO}="",${LD}=""),"",ROUND((${LO}-${PM})/(${LD}-${PD}),1)),"")`,
    newEst: `=IFERROR(IF(OR(${LO}="",${AVG}=""),${LO},ROUND(${LO}+${AVG}*(TODAY()-${LD}),0)),"")`,
  };
}

/** Formula text for comparison: no whitespace, upper case (Sheets upper-cases function names). */
function normFormula_(f) {
  return String(f || '').replace(/\s+/g, '').toUpperCase();
}

function sameFormula_(a, b) {
  return normFormula_(a) !== '' && normFormula_(a) === normFormula_(b);
}

/**
 * Latest Odometer + Latest Odometer Date on every Vehicles row first; then
 * Avg Miles/Day + Est. Current Mileage, only on rows whose Latest Odometer
 * cells are (or would be) the new formulas.
 */
function setupMileageFormulas_(run) {
  const sh = run.ss.getSheetByName(TAB.VEHICLES);
  if (!sh) return;  // already warned by setupJournalColumns_
  const L = formulaLetters_(setupHeaders_(run, TAB.VEHICLES), setupHeaders_(run, TAB.VISITS),
    setupHeaders_(run, TAB.ODOMETER_READINGS));
  if (L.missing.length) {
    setupWarn_(run, 'SKIPPED the mileage formulas (Latest Odometer, Avg Miles/Day, Est. Current Mileage): ' +
      'missing column' + (L.missing.length === 1 ? '' : 's') + ' ' + L.missing.join(', ') + '.');
    return;
  }
  const rows = setupVehicleRows_(sh, L.VEHCol);
  const cells = setupReadCells_(sh, rows, [L.LOCol, L.LDCol, L.AVGCol, L.ESTCol]);
  const cell = (r, c) => cells[r + ':' + c] || { formula: '', value: '' };

  const ready = {};
  rows.forEach(v => {
    const f = vehicleFormulas_(L, v.row);
    const lo = setupNewFormulaCell_(run, sh, v, 'Latest Odometer', L.LOCol, f.lo,
      NEW_COLUMN_FORMATS['Latest Odometer'], cell(v.row, L.LOCol));
    const ld = setupNewFormulaCell_(run, sh, v, 'Latest Odometer Date', L.LDCol, f.ld,
      NEW_COLUMN_FORMATS['Latest Odometer Date'], cell(v.row, L.LDCol));
    ready[v.row] = lo && ld;
  });

  rows.forEach(v => {
    const f = vehicleFormulas_(L, v.row);
    const avg = cell(v.row, L.AVGCol), est = cell(v.row, L.ESTCol);
    if (!ready[v.row]) {
      if (!sameFormula_(avg.formula, f.newAvg) || !sameFormula_(est.formula, f.newEst)) {
        setupWarn_(run, 'SKIPPED Avg Miles/Day and Est. Current Mileage on row ' + v.row + ' (' + v.name +
          '): its Latest Odometer formulas are not in place (see the warnings above).');
      }
      return;
    }
    setupReplaceFormulaCell_(run, sh, v, 'Avg Miles/Day', L.AVGCol, f.oldAvg, f.newAvg, avg);
    setupReplaceFormulaCell_(run, sh, v, 'Est. Current Mileage', L.ESTCol, f.oldEst, f.newEst, est);
  });
}

/** Vehicles data rows: [{row, name}] for every row with a Vehicle. */
function setupVehicleRows_(sh, vehicleCol) {
  const lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  return sh.getRange(2, vehicleCol, lastRow - 1, 1).getValues()
    .map((r, i) => ({ row: i + 2, name: String(r[0]).trim() }))
    .filter(v => v.name);
}

/** {"row:col": {formula, value}} for the given columns; columns that don't exist yet read as blank. */
function setupReadCells_(sh, rows, cols) {
  const out = {};
  if (!rows.length) return out;
  const first = rows[0].row, last = rows[rows.length - 1].row;
  const lastCol = sh.getLastColumn();
  cols.forEach(c => {
    if (c > lastCol) return;
    const range = sh.getRange(first, c, last - first + 1, 1);
    const formulas = range.getFormulas(), values = range.getValues();
    for (let i = 0; i < formulas.length; i++) {
      out[(first + i) + ':' + c] = { formula: formulas[i][0] || '', value: values[i][0] };
    }
  });
  return out;
}

/**
 * A new formula cell (Latest Odometer / Latest Odometer Date): set when
 * blank; nothing when it already holds the formula; anything else is
 * SKIPPED. Returns true when the cell holds (or would hold) the formula.
 */
function setupNewFormulaCell_(run, sh, v, header, col, formula, numberFormat, current) {
  const where = header + ' ' + colLetter_(col) + v.row + ' (' + v.name + ')';
  if (sameFormula_(current.formula, formula)) return true;
  const blank = !current.formula && (current.value === '' || current.value === null || current.value === undefined);
  if (blank) {
    if (run.apply) setupWriteFormula_(run, sh, v.row, col, header, formula, numberFormat);
    setupChange_(run, 'set ' + where + ' to: ' + formula);
    return true;
  }
  setupWarn_(run, 'SKIPPED ' + where + ': the cell already holds ' +
    (current.formula ? 'another formula: ' + current.formula : 'a typed value: ' + current.value) +
    '. It was left alone; clear it and run setupSchemaApply() again to add the formula.');
  return false;
}

/**
 * Avg Miles/Day / Est. Current Mileage: replaced only when the live formula
 * is exactly the expected old one (its text goes to the Log first); nothing
 * when it's already the new one; anything else is SKIPPED, never guessed.
 */
function setupReplaceFormulaCell_(run, sh, v, header, col, oldFormula, newFormula, current) {
  const where = header + ' ' + colLetter_(col) + v.row + ' (' + v.name + ')';
  if (sameFormula_(current.formula, newFormula)) return;
  if (sameFormula_(current.formula, oldFormula)) {
    if (!run.apply) {
      setupChange_(run, 'replace ' + where + '; old: ' + current.formula + ' ; new: ' + newFormula);
      return;
    }
    setupLog_(run, 'INFO', 'DID save old formula for ' + where + ': ' + current.formula);
    setupWriteFormula_(run, sh, v.row, col, header, newFormula);
    setupChange_(run, 'replace ' + where + ' with: ' + newFormula);
    return;
  }
  setupWarn_(run, 'SKIPPED ' + where + ": it isn't the formula setupSchema expects, so it was left alone. Found: " +
    (current.formula || '(no formula; value ' + JSON.stringify(current.value) + ')') + ' ; expected: ' + oldFormula);
}

// ---------------------------------------------------------------- triggers

/**
 * Replaces THIS project's jobScanStatus / jobDaily triggers (never another
 * project's, e.g. the ingestion script's 15-minute trigger): the scan-status
 * check every 30 minutes and the daily job at about 07:30 Chicago time.
 */
function installTriggers() {
  let removed = 0;
  ScriptApp.getProjectTriggers().forEach(t => {
    if (SETUP_JOB_HANDLERS_.indexOf(t.getHandlerFunction()) !== -1) {
      ScriptApp.deleteTrigger(t);
      removed++;
    }
  });
  ScriptApp.newTrigger('jobScanStatus').timeBased().everyMinutes(30).create();
  ScriptApp.newTrigger('jobDaily').timeBased().atHour(7).nearMinute(30).everyDays(1).inTimezone(TZ).create();
  console.log('installTriggers: removed ' + removed + ' old trigger(s); installed jobScanStatus (every 30 minutes) ' +
    'and jobDaily (daily around 7:30 AM ' + TZ + ').');
}

// ---------------------------------------------------------------- checkSetup

/** Script Properties the API can't run without. */
function requiredScriptProps_() {
  return [PROP.SHEET_ID, PROP.INBOX_FOLDER_ID, PROP.NEEDS_REVIEW_FOLDER_ID, PROP.OAUTH_CLIENT_ID,
    PROP.PUSH_WORKER_URL, PROP.PUSH_WORKER_SECRET];
}

/** Journal tabs and the headers the app or the formulas read (docs/DATA_CONTRACT.md). */
function requiredJournalHeaders_() {
  const h = {};
  h[TAB.VEHICLES] = ['Vehicle', 'Year', 'Make', 'Model', 'VIN', 'Plate', 'Primary Driver', 'Active', 'Drive Folder ID',
    'Original In-Service Date', 'Purchase Date', 'Purchase Mileage', 'Last Visit Date', 'Last Known Mileage',
    'Avg Miles/Day', 'Est. Current Mileage', 'Dealer Next Due Date', 'Dealer Next Due Miles'];
  h[TAB.VISITS] = ['Visit ID', 'Vehicle', 'Date', 'Mileage', 'Location', 'RO #', 'Summary', 'Invoice Total',
    'Amount Paid', 'Card Surcharge', 'Source', 'Notes'];
  h[TAB.VISIT_SERVICES] = ['Vehicle', 'Visit ID', 'Date', 'Mileage', 'Service Type', 'Description (as printed)',
    'Line Cost', 'Notes'];
  h[TAB.DOCUMENTS] = ['Visit ID', 'Vehicle', 'Document Type', 'File Name', 'Drive File ID', 'Pages', 'Complete', 'Notes'];
  h[TAB.RECOMMENDATIONS] = ['Rec ID', 'Vehicle', 'Visit ID', 'Date', 'Mileage', 'Item', 'Estimate', 'Status',
    'Resolved By Visit', 'Notes'];
  h[TAB.INSPECTION_READINGS] = ['Vehicle', 'Visit ID', 'Date', 'Mileage', 'Item', 'Value', 'Unit', 'Rating'];
  h[TAB.SCHEDULE] = ['Vehicle', 'Service Type', 'Interval Months', 'Interval Miles', 'Interval Source',
    'Last Done Date', 'Last Done Miles', 'Next Due Date', 'Next Due Miles', 'Est. Date for Miles', 'Due By', 'Status'];
  h[TAB.WARRANTIES] = ['Vehicle', 'Warranty', 'Start Date', 'End Date', 'Start Miles', 'End Miles', 'Notes'];
  h[TAB.SERVICE_TYPES] = ['Service Type', 'Receipt Synonyms (for matching)'];
  h[TAB.LOG] = ['Timestamp', 'Source', 'Level', 'Message'];
  return h;
}

/**
 * Checks the Script Properties, the Drive folders and the Sheet's structure
 * and writes a readable report to the execution log. Never throws for a
 * failed check. TODO lines are things setupSchemaApply() / installTriggers()
 * will fix.
 * @return {{pass: number, fail: number, todo: number, lines: string[]}}
 */
function checkSetup() {
  const report = { pass: 0, fail: 0, todo: 0, lines: [] };
  const add = (status, what, detail) => {
    if (status === 'PASS') report.pass++;
    else if (status === 'FAIL') report.fail++;
    else if (status === 'TODO') report.todo++;
    report.lines.push(status + '  ' + what + (detail ? ': ' + detail : ''));
  };
  const check = (what, fn) => {
    try {
      fn();
    } catch (e) {
      add('FAIL', what, e && e.message || String(e));
    }
  };

  let props = null;
  check('Script Properties', () => {
    props = PropertiesService.getScriptProperties();
    requiredScriptProps_().forEach(name => {
      const v = props.getProperty(name);
      add(v ? 'PASS' : 'FAIL', 'Script Property ' + name, v ? 'set' : 'missing (Project Settings › Script Properties)');
    });
    add('INFO', 'Script Property SESSION_SECRET',
      props.getProperty(PROP.SESSION_SECRET) ? 'set' : 'not set yet; created on the first sign-in');
    add('INFO', 'Script Property OWNER_EMAIL', props.getProperty(PROP.OWNER_EMAIL) ? 'set' : 'not set; the deploying account is the owner');
    const seed = props.getProperty(PROP.SEED_APP_USERS);
    if (seed) {
      let ok = false;
      try { ok = Array.isArray(JSON.parse(seed)); } catch (e) { ok = false; }
      add(ok ? 'PASS' : 'FAIL', 'Script Property SEED_APP_USERS', ok ? 'a JSON array' : 'not a JSON array');
    }
  });
  const getProp = name => (props ? props.getProperty(name) : null);

  let ss = null;
  check('Journal Sheet opens', () => {
    const id = getProp(PROP.SHEET_ID);
    if (!id) throw new Error('SHEET_ID is not set');
    ss = SpreadsheetApp.openById(id);
    add('PASS', 'Journal Sheet opens', '"' + ss.getName() + '"');
  });

  [[PROP.INBOX_FOLDER_ID, 'Inbox folder opens'], [PROP.NEEDS_REVIEW_FOLDER_ID, '_Needs Review folder opens']]
    .forEach(pair => check(pair[1], () => {
      const id = getProp(pair[0]);
      if (!id) throw new Error(pair[0] + ' is not set');
      add('PASS', pair[1], '"' + DriveApp.getFolderById(id).getName() + '"');
    }));

  if (ss) {
    const required = requiredJournalHeaders_();
    Object.keys(required).forEach(tab => check('Tab ' + tab, () => {
      const sh = ss.getSheetByName(tab);
      if (!sh) return add('FAIL', 'Tab ' + tab, 'missing');
      const have = setupSheetHeaders_(sh);
      const missing = required[tab].filter(h => have.indexOf(h) === -1);
      add(missing.length ? 'FAIL' : 'PASS', 'Tab ' + tab + ' headers',
        missing.length ? 'missing ' + missing.join(', ') : required[tab].length + ' checked');
    }));
    [[TAB.VEHICLES, NEW_VEHICLE_COLUMNS], [TAB.WARRANTIES, NEW_WARRANTY_COLUMNS]].forEach(pair => check('New ' + pair[0] + ' columns', () => {
      const sh = ss.getSheetByName(pair[0]);
      if (!sh) return;
      const have = setupSheetHeaders_(sh);
      const missing = pair[1].filter(h => have.indexOf(h) === -1);
      add(missing.length ? 'TODO' : 'PASS', 'New ' + pair[0] + ' columns',
        missing.length ? missing.length + ' missing; run setupSchemaApply()' : 'all present');
    }));
    Object.keys(APP_TAB_HEADERS).forEach(tab => check('App tab ' + tab, () => {
      const sh = ss.getSheetByName(tab);
      if (!sh) return add('TODO', 'App tab ' + tab, 'missing; run setupSchemaApply()');
      const have = setupSheetHeaders_(sh);
      const missing = APP_TAB_HEADERS[tab].filter(h => have.indexOf(h) === -1);
      add(missing.length ? 'TODO' : 'PASS', 'App tab ' + tab,
        missing.length ? 'missing ' + missing.join(', ') + '; run setupSchemaApply()' : 'present');
    }));
    check('App Users', () => {
      const sh = ss.getSheetByName(TAB.APP_USERS);
      if (!sh) return;
      const users = normAppUsers_(tabFromValues_(TAB.APP_USERS, sh.getDataRange().getValues())).filter(u => u.active);
      add(users.length ? 'PASS' : 'TODO', 'App Users', users.length ? users.length + ' active' :
        'no active rows; run setupSchemaApply() with SEED_APP_USERS set, or add rows by hand');
    });
    check('Vehicle Drive folders', () => {
      const sh = ss.getSheetByName(TAB.VEHICLES);
      if (!sh) return;
      const vehicles = normVehicles_(tabFromValues_(TAB.VEHICLES, sh.getDataRange().getValues())).filter(v => v.active);
      if (!vehicles.length) return add('FAIL', 'Vehicles', 'no rows with Active = Yes');
      vehicles.forEach(v => {
        const what = 'Drive folder for ' + v.name;
        if (!v.driveFolderId) return add('FAIL', what, 'Drive Folder ID is blank');
        try {
          add('PASS', what, '"' + DriveApp.getFolderById(v.driveFolderId).getName() + '"');
        } catch (e) {
          add('FAIL', what, "Drive Folder ID doesn't open (" + e.message + ')');
        }
      });
    });
  }

  check('Triggers', () => {
    const handlers = ScriptApp.getProjectTriggers().map(t => t.getHandlerFunction());
    SETUP_JOB_HANDLERS_.forEach(fn => add(handlers.indexOf(fn) !== -1 ? 'PASS' : 'TODO', 'Trigger ' + fn,
      handlers.indexOf(fn) !== -1 ? 'installed' : 'not installed; run installTriggers()'));
  });

  const summary = 'checkSetup: ' + report.pass + ' passed, ' + report.fail + ' failed, ' + report.todo + ' to do.' +
    (report.fail ? ' Fix the FAIL lines and run checkSetup again.' : '');
  const text = ['checkSetup (App API ' + APP_VERSION + ')'].concat(report.lines, [summary]).join('\n');
  try { Logger.log(text); } catch (e) { /* Logger is optional */ }
  console.log(text);
  report.summary = summary;
  return report;
}
