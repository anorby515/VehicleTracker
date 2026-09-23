'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

/**
 * Scans.js: the location → status table (pure), the Drive walk, and the
 * App Scans writes, against the synthetic fixture and fake Drive.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { makeFakes } = require('./fakes');
const { makeDriveApp } = require('./fakes-jobs');
const fx = require('./fixtures/sheet');

const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js', 'Api.js', 'Auth.js',
  'Scans.js', 'Notify.js'];
const V = fx.vehicleNames;
const plain = x => JSON.parse(JSON.stringify(x));
const HOUR = 3600 * 1000;
const T0 = Date.parse('2026-09-21T18:05:00-05:00');

const pure = load({ files: FILES });

// ---------------------------------------------------------------- classifyScanLocation_ (pure)

const CTX = {
  inboxId: 'inbox',
  needsReviewId: 'review',
  vehicleFolders: { 'folder-4r': V.fourRunner, 'folder-hl': V.highlander },
  documentsByFileId: {
    'file-filed': { visitId: '4r-visit-1', vehicle: V.fourRunner },
    'file-in-hl-folder': { visitId: 'hl-visit-9', vehicle: V.highlander },
  },
  ownerName: 'Robert',
  uploadedAtMs: T0,
  nowMs: T0 + HOUR,
};

function classify(loc, ctxOverrides) {
  return plain(pure.classifyScanLocation_(loc, Object.assign({}, CTX, ctxOverrides || {})));
}

test('classifyScanLocation_: every row of the scan status table', () => {
  // Parent is Inbox → Waiting.
  assert.deepEqual(classify({ exists: true, fileId: 'f', parentIds: ['inbox', 'vehicles-root'] }),
    { status: 'Waiting', statusDetail: null, visitId: null, filedVehicle: null });

  // Under a vehicle folder and on Documents → Filed, with the Visit ID.
  assert.deepEqual(classify({ exists: true, fileId: 'file-filed', parentIds: ['folder-4r', 'vehicles-root'] }),
    { status: 'Filed', statusDetail: null, visitId: '4r-visit-1', filedVehicle: V.fourRunner });

  // In a vehicle folder but not on Documents yet → Adding to journal.
  assert.deepEqual(classify({ exists: true, fileId: 'file-new', parentIds: ['folder-hl', 'vehicles-root'] }),
    { status: 'Adding to journal', statusDetail: null, visitId: null, filedVehicle: V.highlander });

  // Parent is _Needs Review → Needs attention (the app shows the standard
  // "Robert's been notified. You may be asked to rescan." for a blank detail).
  assert.deepEqual(classify({ exists: true, fileId: 'f', parentIds: ['review', 'vehicles-root'] }),
    { status: 'Needs attention', statusDetail: null, visitId: null, filedVehicle: null });
  assert.equal(pure.scanStatusDetail_('Needs attention', null, 'Robert'),
    "Robert's been notified. You may be asked to rescan.");

  // Missing → Check with owner immediately (only an hour after upload).
  assert.deepEqual(classify({ exists: false, fileId: 'gone', parentIds: [] }), {
    status: 'Check with owner', statusDetail: "We couldn't find this scan in Drive. Robert can look into it.",
    visitId: null, filedVehicle: null,
  });
  // Trashed → Check with owner immediately, even though it's still in Inbox.
  assert.deepEqual(classify({ exists: true, trashed: true, fileId: 'f', parentIds: ['inbox'] }), {
    status: 'Check with owner', statusDetail: 'This scan was moved to the trash. Robert can look into it.',
    visitId: null, filedVehicle: null,
  });
});

test('classifyScanLocation_: year and Pages subfolders under a vehicle folder', () => {
  const nested = ['pages-folder', 'year-2026', 'folder-4r', 'vehicles-root', 'my-drive'];
  assert.equal(classify({ exists: true, fileId: 'file-filed', parentIds: nested }).status, 'Filed');
  assert.equal(classify({ exists: true, fileId: 'file-filed', parentIds: nested }).visitId, '4r-visit-1');
  const r = classify({ exists: true, fileId: 'file-new', parentIds: ['year-2026', 'folder-hl', 'vehicles-root'] });
  assert.equal(r.status, 'Adding to journal');
  assert.equal(r.filedVehicle, V.highlander);
});

test('classifyScanLocation_: Filed uses the vehicle the journal has the file under', () => {
  // Cowork put it in the Highlander folder, but Documents says the visit is the 4Runner's.
  const r = classify({ exists: true, fileId: 'file-filed', parentIds: ['year-2026', 'folder-hl'] });
  assert.equal(r.status, 'Filed');
  assert.equal(r.filedVehicle, V.fourRunner);
});

test('classifyScanLocation_: the 24-hour rule for "none of the above"', () => {
  const elsewhere = { exists: true, fileId: 'f', parentIds: ['some-other-folder', 'my-drive'] };
  assert.equal(classify(elsewhere, { nowMs: T0 + 23 * HOUR + 59 * 60 * 1000 }).status, 'Waiting');
  assert.equal(classify(elsewhere, { nowMs: T0 + 24 * HOUR }).status, 'Check with owner');
  assert.equal(classify(elsewhere, { nowMs: T0 + 24 * HOUR }).statusDetail, null);
  // No parents at all (shared-with-me, or detached) follows the same rule.
  assert.equal(classify({ exists: true, fileId: 'f', parentIds: [] }).status, 'Waiting');
  assert.equal(classify({ exists: true, fileId: 'f', parentIds: [] }, { nowMs: T0 + 30 * HOUR }).status, 'Check with owner');
  // An unknown upload time counts as past the 24 hours.
  assert.equal(classify(elsewhere, { uploadedAtMs: null }).status, 'Check with owner');
});

test('scanContextFromData_ maps folders (inactive vehicles too) and documents', () => {
  const tabs = fx.cloneTabs();
  const D = pure.dataFromTabs_(tabs);
  D.vehicles[1].active = false; // the Jeep
  const ctx = plain(pure.scanContextFromData_(D, { inboxId: 'in', needsReviewId: 'rev' }, 'Robert'));
  assert.equal(ctx.inboxId, 'in');
  assert.equal(ctx.needsReviewId, 'rev');
  assert.equal(ctx.vehicleFolders['fake-folder-jp'], V.wrangler);
  assert.equal(ctx.vehicleFolders['fake-folder-4r'], V.fourRunner);
  assert.deepEqual(ctx.documentsByFileId['fake-doc-4r-0903-inv'], { visitId: '4r-20260903-L1102', vehicle: V.fourRunner });
  assert.equal(ctx.ownerName, 'Robert');
});

test('scansToCheck_: not Filed, younger than 30 days, optionally one person', () => {
  const D = pure.dataFromTabs_(fx.tabs);
  const now = Date.parse('2026-09-22T12:00:00-05:00');
  assert.deepEqual(plain(pure.scansToCheck_(D.appScans, now).map(s => s.scanId)),
    ['scan-0001', 'scan-0003', 'scan-0004', 'scan-0005', 'scan-0006', 'scan-0009']);
  assert.deepEqual(plain(pure.scansToCheck_(D.appScans, now, { email: 'leo@example.com' }).map(s => s.scanId)),
    ['scan-0001', 'scan-0009']);
  // A hand-entered row with the Name in Uploaded By matches when the name is given.
  const rows = [Object.assign({}, D.appScans[0], { uploadedBy: 'leo' })];
  assert.equal(pure.scansToCheck_(rows, now, { email: 'leo@example.com' }).length, 0);
  assert.equal(pure.scansToCheck_(rows, now, { email: 'leo@example.com', name: 'Leo' }).length, 1);
});

// ---------------------------------------------------------------- Drive walk

test('locateFile_ walks up the folder chain, stopping at a known folder', () => {
  const drive = makeDriveApp({
    files: {
      'f-nested': { parent: 'pages' },
      'f-trash': { parent: 'inbox', trashed: true },
      'f-flaky': { error: 'Service error: Drive' },
      'f-noauth': { error: 'Exception: Access denied: DriveApp.' },
    },
    folders: { 'pages': 'year-2026', 'year-2026': 'folder-4r', 'folder-4r': 'vehicles-root', 'vehicles-root': 'my-drive' },
  });
  const gas = load({ files: FILES, globals: { DriveApp: drive } });
  assert.deepEqual(plain(gas.locateFile_('f-nested')),
    { fileId: 'f-nested', exists: true, trashed: false, parentIds: ['pages', 'year-2026', 'folder-4r', 'vehicles-root', 'my-drive'] });
  assert.deepEqual(plain(gas.locateFile_('f-nested', { 'folder-4r': true })).parentIds, ['pages', 'year-2026', 'folder-4r']);
  assert.deepEqual(plain(gas.locateFile_('f-trash')), { fileId: 'f-trash', exists: true, trashed: true, parentIds: ['inbox'] });
  assert.deepEqual(plain(gas.locateFile_('missing')), { fileId: 'missing', exists: false, trashed: false, parentIds: [] });
  // Any other Drive error is thrown: a hiccup must never mark a scan missing.
  assert.throws(() => gas.locateFile_('f-flaky'), /Service error/);
  assert.throws(() => gas.locateFile_('f-noauth'), /Access denied/);
});

// ---------------------------------------------------------------- checkScans_ / runScanStatus_ (writes)

const NOW = new Date('2026-09-22T12:00:00-05:00');

function setup(opts = {}) {
  const tabs = fx.cloneTabs();
  if (opts.tabs) opts.tabs(tabs);
  const drive = makeDriveApp(opts.drive || { files: {}, folders: {} });
  const fakes = makeFakes({
    tabs,
    props: Object.assign({ OWNER_EMAIL: fx.users.owner, INBOX_FOLDER_ID: 'inbox', NEEDS_REVIEW_FOLDER_ID: 'review' }, opts.props || {}),
    now: NOW.getTime(),
    extraGlobals: { DriveApp: drive },
  });
  const gas = load({ files: FILES, globals: fakes.globals });
  const sheet = fakes.spreadsheet.getSheetByName('App Scans');
  const headers = sheet.toValues()[0];
  const col = name => headers.indexOf(name) + 1;
  const rowOf = scanId => sheet.toValues().findIndex(r => r[0] === scanId) + 1;
  /** {header: value} of the cells written on one scan's row. */
  const writesFor = scanId => {
    const out = {};
    sheet.writes.filter(w => w.row === rowOf(scanId)).forEach(w => { out[headers[w.col - 1]] = w.value; });
    return out;
  };
  return { gas, fakes, sheet, drive, col, rowOf, writesFor };
}

/** Where each fixture scan's file is "now" in these tests. */
const DRIVE_NOW = {
  files: {
    'fake-scan-0001': { parent: 'inbox' },                       // still waiting
    'fake-scan-0003': { parent: 'review' },                      // still needs attention
    'fake-scan-0004': { parent: 'tl-2026' },                     // filed and now on Documents (see tabs below)
    'fake-scan-0006': { parent: 'jp-2026' },                     // moved out of review into the Jeep folder
    'fake-scan-0009': { parent: 'inbox' },                       // Check with owner → back in Inbox
    // fake-scan-0005 is missing: stays Check with owner, gets a clearer detail.
  },
  folders: { 'tl-2026': 'fake-folder-tl', 'jp-2026': 'fake-folder-jp', 'fake-folder-tl': 'root', 'fake-folder-jp': 'root' },
};

function addTellurideDocument(tabs) {
  const h = tabs['Documents'][0];
  const row = h.map(() => '');
  row[h.indexOf('Visit ID')] = 'tl-owner-0920';
  row[h.indexOf('Vehicle')] = V.telluride;
  row[h.indexOf('Document Type')] = 'Owner record';
  row[h.indexOf('File Name')] = 'Owner entry.pdf';
  row[h.indexOf('Drive File ID')] = 'fake-scan-0004';
  tabs['Documents'].push(row);
}

test('checkScans_ writes Status/Detail/Visit ID only when they change, Last Checked always', () => {
  const t = setup({ drive: DRIVE_NOW, tabs: addTellurideDocument });
  const D = t.gas.dataFromTabs_(t.gas.readTabs_(['App Scans', 'Vehicles', 'Documents']));
  const ctx = t.gas.scanContextFromData_(D, { inboxId: 'inbox', needsReviewId: 'review' }, 'Robert');
  const rows = D.appScans.filter(s => ['scan-0001', 'scan-0003', 'scan-0004', 'scan-0005', 'scan-0006'].includes(s.scanId));
  const changed = plain(t.gas.checkScans_(rows, { now: NOW, ctx }));

  // Unchanged rows: only Last Checked.
  assert.deepEqual(Object.keys(t.writesFor('scan-0001')), ['Last Checked']);
  assert.equal(t.writesFor('scan-0001')['Last Checked'].getTime(), NOW.getTime());
  assert.deepEqual(Object.keys(t.writesFor('scan-0003')), ['Last Checked']);

  // Filed: Status and Visit ID change (Status Detail was already blank).
  assert.deepEqual(t.writesFor('scan-0004'), { 'Status': 'Filed', 'Visit ID': 'tl-owner-0920', 'Last Checked': NOW });

  // Still Check with owner, but now we know the file is gone: only the detail changes.
  assert.deepEqual(t.writesFor('scan-0005'), {
    'Status Detail': "We couldn't find this scan in Drive. Robert can look into it.", 'Last Checked': NOW,
  });

  // In the Jeep folder, not on Documents yet.
  assert.deepEqual(t.writesFor('scan-0006'), { 'Status': 'Adding to journal', 'Last Checked': NOW });

  assert.deepEqual(changed.map(c => [c.scanId, c.previousStatus, c.status, c.visitId, c.filedVehicle]), [
    ['scan-0004', 'Adding to journal', 'Filed', 'tl-owner-0920', V.telluride],
    ['scan-0006', 'Needs attention', 'Adding to journal', null, V.wrangler],
  ]);

  // A second run with nothing moved writes Last Checked only.
  t.sheet.writes.length = 0;
  const D2 = t.gas.dataFromTabs_(t.gas.readTabs_(['App Scans']));
  const again = t.gas.checkScans_(D2.appScans.filter(s => ['scan-0001', 'scan-0003', 'scan-0005', 'scan-0006'].includes(s.scanId)),
    { now: NOW, ctx });
  assert.equal(again.length, 0);
  assert.ok(t.sheet.writes.every(w => w.col === t.col('Last Checked')));
});

test('checkScans_: a Drive error on one row is skipped, the others still run', () => {
  const drive = { files: Object.assign({}, DRIVE_NOW.files, { 'fake-scan-0001': { error: 'Service error: Drive' } }), folders: DRIVE_NOW.folders };
  const t = setup({ drive });
  const D = t.gas.dataFromTabs_(t.gas.readTabs_(['App Scans', 'Vehicles', 'Documents']));
  const ctx = t.gas.scanContextFromData_(D, { inboxId: 'inbox', needsReviewId: 'review' }, 'Robert');
  const rows = D.appScans.filter(s => ['scan-0001', 'scan-0006'].includes(s.scanId));
  const changed = plain(t.gas.checkScans_(rows, { now: NOW, ctx }));
  assert.deepEqual(t.writesFor('scan-0001'), {});
  assert.deepEqual(changed.map(c => c.scanId), ['scan-0006']);
});

test('runScanStatus_ checks every non-final scan under 30 days and invalidates the bootstrap cache', () => {
  const t = setup({ drive: DRIVE_NOW, tabs: addTellurideDocument });
  const cacheKey = t.gas.bootstrapCacheKey_();
  t.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);
  const r = t.gas.runScanStatus_({ now: NOW });
  assert.equal(r.checked, 6); // 0001, 0003, 0004, 0005, 0006, 0009 (0002/0007 Filed, 0008 too old)
  assert.deepEqual(plain(r.changed.map(c => c.scanId + ':' + c.status)),
    ['scan-0004:Filed', 'scan-0006:Adding to journal', 'scan-0009:Waiting']);
  assert.equal(t.fakes.scriptCache.get(cacheKey), null);
  assert.deepEqual(t.writesFor('scan-0002'), {});
  assert.deepEqual(t.writesFor('scan-0008'), {});
  // The row values on the tab.
  const scans = t.gas.normAppScans_(t.gas.readTab_('App Scans'));
  const s4 = scans.filter(s => s.scanId === 'scan-0004')[0];
  assert.equal(s4.status, 'Filed');
  assert.equal(s4.visitId, 'tl-owner-0920');
});

test('runScanStatus_ with nothing to check reads nothing else and keeps the cache', () => {
  const t = setup({
    drive: DRIVE_NOW,
    tabs: tabs => {
      const h = tabs['App Scans'][0];
      tabs['App Scans'].slice(1).forEach(r => { r[h.indexOf('Status')] = 'Filed'; });
    },
  });
  const cacheKey = t.gas.bootstrapCacheKey_();
  t.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);
  assert.deepEqual(plain(t.gas.runScanStatus_({ now: NOW })), { checked: 0, changed: [] });
  assert.equal(t.drive.calls.getFileById, 0);
  assert.notEqual(t.fakes.scriptCache.get(cacheKey), null);
});

test('checkUserScans_: only that user\'s scans, throttled per user, never throws', () => {
  const t = setup({ drive: DRIVE_NOW });
  const first = plain(t.gas.checkUserScans_('Leo@Example.com', { now: NOW }));
  assert.equal(first.checked, 2); // scan-0001 and scan-0009
  assert.equal(t.drive.calls.getFileById, 2);

  // Within RULES.SCAN_CHECK_THROTTLE_SEC: skipped.
  assert.deepEqual(plain(t.gas.checkUserScans_('leo@example.com', { now: NOW })), { checked: 0, throttled: true });
  assert.equal(t.drive.calls.getFileById, 2);
  // Another user isn't throttled by Leo's check.
  assert.equal(t.gas.checkUserScans_('maya@example.com', { now: NOW }).checked, 1); // scan-0003 (0008 is too old)

  t.fakes.clock.advance(121);
  assert.equal(t.gas.checkUserScans_('leo@example.com', { now: NOW }).checked, 2);

  // A broken Sheet never breaks bootstrap.
  const broken = setup({ props: { SHEET_ID: '' } });
  const r = plain(broken.gas.checkUserScans_('leo@example.com', { now: NOW }));
  assert.equal(r.checked, 0);
  assert.match(r.error, /SHEET_ID/);
  assert.deepEqual(plain(broken.gas.checkUserScans_('', { now: NOW })), { checked: 0 });
});
