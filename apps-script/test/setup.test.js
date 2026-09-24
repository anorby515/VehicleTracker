'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/sheet');
const { loadApi } = require('./fakes-services');

const V = fx.vehicleNames;
const APP_TABS = ['App Users', 'Odometer Readings', 'App Scans', 'Recalls', 'Push Subscriptions', 'Notification Log'];

/** Fictional seed users (the real ones live only in the SEED_APP_USERS Script Property). */
const SEED = [
  { email: 'Robert@Example.com', name: 'Robert', driverName: 'Bob', defaultVehicle: V.x7 },
  { email: 'leo@example.com', name: 'Leo', driverName: 'Leo', defaultVehicle: V.fourRunner },
  { email: 'maya@example.com', name: 'Maya', driverName: 'Maya', defaultVehicle: V.highlander },
  { email: 'nina@example.com', name: 'Nina', driverName: 'Nina', defaultVehicle: V.telluride },
];

// The live formulas on Vehicles row 2 (fixtures/sheet.js liveFormulas(), same text as the real Sheet).
const OLD_P2 = '=IFERROR(IF(OR(L2="",M2="",N2="",O2=""),"",ROUND((O2-M2)/(N2-L2),1)),"")';
const OLD_Q2 = '=IFERROR(IF(OR(O2="",P2=""),O2,ROUND(O2+P2*(TODAY()-N2),0)),"")';
// What setupSchemaApply() must write on row 2, with Latest Odometer in AO and Latest Odometer Date in AP
// (the live 21 columns + the 21 new ones), Visits B/C/D and Odometer Readings B/C/D.
const NEW_AO2 = '=IFERROR(LET(v,MAXIFS(Visits!$D:$D,Visits!$B:$B,$A2),o,MAXIFS(\'Odometer Readings\'!$D:$D,' +
  '\'Odometer Readings\'!$B:$B,$A2),m,MAX(v,o),IF(m=0,"",m)),"")';
const NEW_AP2 = '=IFERROR(IF(AO2="","",LET(d,MAX(MAXIFS(Visits!$C:$C,Visits!$B:$B,$A2,Visits!$D:$D,AO2),' +
  'MAXIFS(\'Odometer Readings\'!$C:$C,\'Odometer Readings\'!$B:$B,$A2,\'Odometer Readings\'!$D:$D,AO2)),' +
  'IF(d=0,"",INT(d)))),"")';
// The first Latest Odometer Date formula (kept the noon time), which setupSchemaApply() upgrades.
const V1_AP2 = NEW_AP2.replace('INT(d)))),"")', 'd))),"")');
const NEW_P2 = '=IFERROR(IF(OR(L2="",M2="",AO2="",AP2=""),"",ROUND((AO2-M2)/(AP2-L2),1)),"")';
const NEW_Q2 = '=IFERROR(IF(OR(AO2="",P2=""),AO2,ROUND(AO2+P2*(TODAY()-AP2),0)),"")';

/** Row 2's formula text moved to row r (every cell reference ending in 2). */
const forRow = (formula, r) => formula.replace(/(\$?[A-Z]+)2(?![0-9])/g, (m, c) => c + r);

/**
 * The journal as it is before setup (live columns, live formulas, no app
 * tabs), plus each vehicle's Drive folder with its photo (or trouble).
 */
function setup(opts = {}) {
  const tabs = opts.tabs || fx.preSetupTabs();
  const formulas = opts.formulas || fx.liveFormulas();
  const props = Object.assign({ SEED_APP_USERS: JSON.stringify(SEED) }, opts.props);
  const logged = [];
  const quiet = Object.assign(Object.create(console), { log: (s) => logged.push(String(s)) });
  const env = loadApi({ tabs, formulas, props, triggers: opts.triggers, globals: { console: quiet } });
  env.logged = logged;
  const d = env.services.drive;
  d.addFolder('fake-folder-hl', V.highlander).addFolder('fake-folder-hl-2025', '2025', 'fake-folder-hl')
    .addFolder('fake-folder-jp', V.wrangler).addFolder('fake-folder-x7', V.x7)
    .addFolder('fake-folder-4r', V.fourRunner).addFolder('fake-folder-4r-2026', '2026', 'fake-folder-4r')
    .addFolder('fake-folder-tl', V.telluride);
  // Highlander: the photo, a receipt beside it, and a same-named photo in a year subfolder (ignored).
  d.addFile({ id: 'photo-hl', name: V.highlander + ' - Photo.png', mimeType: 'image/png', parentId: 'fake-folder-hl' });
  d.addFile({ id: 'receipt-hl', name: V.highlander + ' - 2025 12 02 - Shop.pdf', mimeType: 'application/pdf', parentId: 'fake-folder-hl' });
  d.addFile({ id: 'photo-hl-old', name: V.highlander + ' - Photo.jpg', mimeType: 'image/jpeg', parentId: 'fake-folder-hl-2025' });
  // Jeep: upper-case extension.
  d.addFile({ id: 'photo-jp', name: V.wrangler + ' - Photo.PNG', mimeType: 'image/png', parentId: 'fake-folder-jp' });
  // X7: two candidates → ambiguous.
  d.addFile({ id: 'photo-x7-a', name: V.x7 + ' - Photo.png', mimeType: 'image/png', parentId: 'fake-folder-x7' });
  d.addFile({ id: 'photo-x7-b', name: V.x7 + ' - Photo.jpg', mimeType: 'image/jpeg', parentId: 'fake-folder-x7' });
  // 4Runner: only non-images, a wrong extension, and a photo in a subfolder → none.
  d.addFile({ id: 'not-image-4r', name: V.fourRunner + ' - Photo.png', mimeType: 'application/pdf', parentId: 'fake-folder-4r' });
  d.addFile({ id: 'pdf-4r', name: V.fourRunner + ' - Photo.pdf', mimeType: 'application/pdf', parentId: 'fake-folder-4r' });
  d.addFile({ id: 'sub-4r', name: V.fourRunner + ' - Photo.webp', mimeType: 'image/webp', parentId: 'fake-folder-4r-2026' });
  // Telluride: the photo, and a trashed duplicate.
  d.addFile({ id: 'photo-tl', name: V.telluride + ' - Photo.jpg', mimeType: 'image/jpeg', parentId: 'fake-folder-tl' });
  d.addFile({ id: 'photo-tl-old', name: V.telluride + ' - Photo.png', mimeType: 'image/png', parentId: 'fake-folder-tl', trashed: true });

  env.ss = env.fakes.spreadsheet;
  env.sheet = name => env.ss.getSheetByName(name);
  env.logRows = () => env.sheet('Log').toValues().slice(1).filter(r => r[1] === 'app-setup');
  env.messages = () => env.logRows().map(r => r[3]);
  env.cell = (tab, a1) => {
    const sh = env.sheet(tab);
    return { formula: sh.formulaAt(a1), value: sh.getRange(a1).getValue(), format: sh.getRange(a1).getNumberFormat() };
  };
  env.col = (tab, header) => env.sheet(tab).toValues()[0].indexOf(header) + 1;
  env.letter = (tab, header) => env.gas.colLetter_(env.col(tab, header));
  return env;
}

/** Everything in a sheet a change could touch: values, formulas, number formats. */
function snapshot(ss, names) {
  const out = {};
  (names || ss.getSheets().map(s => s.getName())).forEach(n => {
    const sh = ss.getSheetByName(n);
    out[n] = sh && JSON.stringify({ values: sh.toValues(), formulas: sh.formulas, formats: sh.formats });
  });
  return out;
}

const withoutLog = (ss) => ss.getSheets().map(s => s.getName()).filter(n => n !== 'Log');

// ---------------------------------------------------------------- dry run

test('setupSchema() dry run lists every change in the Log and changes nothing else', () => {
  const env = setup();
  const before = snapshot(env.ss, withoutLog(env.ss));
  const logBefore = env.sheet('Log').toValues().length;

  const report = env.gas.setupSchema();
  assert.equal(report.apply, false);

  assert.deepEqual(snapshot(env.ss, withoutLog(env.ss)), before, 'only the Log changed');
  assert.deepEqual(env.ss.getSheets().map(s => s.getName()), Object.keys(fx.liveHeaders), 'no tab created');
  assert.equal(env.services.urlFetch.calls.length, 0);

  const rows = env.logRows();
  assert.equal(env.sheet('Log').toValues().length, logBefore + rows.length);
  rows.forEach(r => {
    assert.equal(Object.prototype.toString.call(r[0]), '[object Date]');
    assert.ok(['INFO', 'WARN'].includes(r[2]));
  });
  const msgs = env.messages();
  assert.match(msgs[0], /^setupSchema dry run started/);
  const changes = msgs.filter(m => /^(WOULD|DID) /.test(m));
  assert.ok(changes.every(m => m.startsWith('WOULD ')), 'dry run says WOULD, never DID');
  assert.equal(changes.length, report.changes);

  assert.ok(msgs.includes('WOULD create tab "Odometer Readings" with headers: Reading ID, Vehicle, Date, Mileage, ' +
    'Entered By, Entered At, Note'));
  assert.equal(msgs.filter(m => m.startsWith('WOULD create tab ')).length, 6);
  assert.ok(msgs.includes('WOULD append column V "Photo File ID" at the end of Vehicles'));
  assert.ok(msgs.includes('WOULD append column AO "Latest Odometer" at the end of Vehicles'));
  assert.ok(msgs.includes('WOULD append column AP "Latest Odometer Date" at the end of Vehicles'));
  assert.ok(msgs.includes('WOULD append column H "Type" at the end of Warranties'));
  assert.ok(msgs.includes('WOULD append column I "Covers" at the end of Warranties'));
  assert.ok(msgs.includes('WOULD seed App Users with 4 rows from SEED_APP_USERS: Robert, Leo, Maya, Nina'));
  assert.ok(msgs.includes('WOULD set Photo File ID V2 (' + V.highlander + ') to "' + V.highlander +
    ' - Photo.png" (photo-hl)'));
  assert.ok(msgs.includes('WOULD set Latest Odometer AO2 (' + V.highlander + ') to: ' + NEW_AO2));
  assert.ok(msgs.includes('WOULD set Latest Odometer Date AP2 (' + V.highlander + ') to: ' + NEW_AP2));
  assert.ok(msgs.includes('WOULD replace Avg Miles/Day P2 (' + V.highlander + '); old: ' + OLD_P2 + ' ; new: ' + NEW_P2));
  assert.ok(msgs.includes('WOULD replace Est. Current Mileage Q2 (' + V.highlander + '); old: ' + OLD_Q2 +
    ' ; new: ' + NEW_Q2));
  assert.equal(msgs.filter(m => /^WOULD replace (Avg Miles\/Day|Est\. Current Mileage) [PQ]\d /.test(m)).length, 10);
  assert.match(msgs[msgs.length - 1], /^Dry run: \d+ changes listed above \(2 warnings above\)\. Nothing was changed\./);
});

// ---------------------------------------------------------------- apply

test('setupSchemaApply() creates tabs and columns, seeds, and sets the formulas exactly', () => {
  const env = setup();
  const journalBefore = snapshot(env.ss, ['Visits', 'Visit Services', 'Documents', 'Recommendations',
    'Inspection Readings', 'Schedule', 'Service Types']);
  const vehiclesBefore = env.sheet('Vehicles').toValues();
  const warrantiesBefore = env.sheet('Warranties').toValues();
  const live = fx.liveFormulas();

  const report = env.gas.setupSchemaApply();
  assert.equal(report.apply, true);
  assert.equal(report.warnings, 2);

  // App tabs: added at the end, in order, with bold frozen headers.
  assert.deepEqual(env.ss.getSheets().map(s => s.getName()), Object.keys(fx.liveHeaders).concat(APP_TABS));
  APP_TABS.forEach(name => {
    const sh = env.sheet(name);
    assert.deepEqual(sh.toValues()[0], fx.appTabHeaders[name], name);
    assert.equal(sh.getFrozenRows(), 1);
    assert.equal(sh.fontWeights['1:1'], 'bold');
  });
  assert.equal(env.cell('Odometer Readings', 'C2').format, 'yyyy-mm-dd');
  assert.equal(env.cell('Odometer Readings', 'D2').format, '#,##0');

  // New columns appended at the end; existing cells untouched (P/Q aside).
  const vehicles = env.sheet('Vehicles').toValues();
  assert.deepEqual(vehicles[0], fx.liveHeaders['Vehicles'].concat(fx.newVehicleColumns));
  assert.deepEqual(env.sheet('Vehicles').insertedColumns, [{ after: 26, n: 16 }], 'sheet grown at the end only');
  vehiclesBefore.forEach((row, i) => assert.deepEqual(vehicles[i].slice(0, 21), row, 'Vehicles row ' + (i + 1)));
  assert.deepEqual(env.sheet('Warranties').toValues()[0], fx.liveHeaders['Warranties'].concat(['Type', 'Covers']));
  warrantiesBefore.forEach((row, i) => assert.deepEqual(env.sheet('Warranties').toValues()[i].slice(0, 7), row));
  assert.equal(env.sheet('Warranties').formulaAt('F2'), '=E2+12000');
  assert.equal(env.cell('Vehicles', env.letter('Vehicles', 'Registration Expires') + '4').format, 'yyyy-mm-dd');

  // The exact formulas on row 2, and the right pattern on every row.
  assert.equal(env.letter('Vehicles', 'Latest Odometer'), 'AO');
  assert.equal(env.letter('Vehicles', 'Latest Odometer Date'), 'AP');
  assert.equal(env.cell('Vehicles', 'AO2').formula, NEW_AO2);
  assert.equal(env.cell('Vehicles', 'AP2').formula, NEW_AP2);
  assert.equal(env.cell('Vehicles', 'P2').formula, NEW_P2);
  assert.equal(env.cell('Vehicles', 'Q2').formula, NEW_Q2);
  assert.equal(env.cell('Vehicles', 'AO2').format, '#,##0');
  assert.equal(env.cell('Vehicles', 'AP2').format, 'yyyy-mm-dd');
  for (let r = 2; r <= 6; r++) {
    assert.equal(env.cell('Vehicles', 'AO' + r).formula, forRow(NEW_AO2, r), 'AO' + r);
    assert.equal(env.cell('Vehicles', 'AP' + r).formula, forRow(NEW_AP2, r), 'AP' + r);
    assert.equal(env.cell('Vehicles', 'P' + r).formula, forRow(NEW_P2, r), 'P' + r);
    assert.equal(env.cell('Vehicles', 'Q' + r).formula, forRow(NEW_Q2, r), 'Q' + r);
    // Never touched: VIN Last 6, Last Visit Date, Last Known Mileage, Dealer Next Due Date / Miles.
    for (const c of ['F', 'N', 'O', 'R', 'S']) assert.equal(env.cell('Vehicles', c + r).formula, live['Vehicles'][c + r]);
  }
  assert.deepEqual(snapshot(env.ss, Object.keys(journalBefore)), journalBefore, 'journal tabs untouched');

  // The old formula text is in the Log BEFORE the cell was replaced.
  const msgs = env.messages();
  const saved = msgs.indexOf('DID save old formula for Avg Miles/Day P2 (' + V.highlander + '): ' + OLD_P2);
  const replaced = msgs.indexOf('DID replace Avg Miles/Day P2 (' + V.highlander + ') with: ' + NEW_P2);
  assert.ok(saved !== -1 && replaced === saved + 1, 'saved, then replaced');
  assert.ok(msgs.includes('DID save old formula for Est. Current Mileage Q6 (' + V.telluride + '): ' +
    live['Vehicles']['Q6']));
  // Latest Odometer formulas are all in place before any Avg Miles/Day / Est. Current Mileage replacement.
  const lastLo = Math.max(...msgs.map((m, i) => (/^DID set Latest Odometer/.test(m) ? i : -1)));
  const firstSave = msgs.findIndex(m => m.startsWith('DID save old formula'));
  const oreTab = msgs.findIndex(m => m.startsWith('DID create tab "Odometer Readings"'));
  assert.ok(oreTab < lastLo && lastLo < firstSave);
  assert.ok(msgs.every(m => !m.startsWith('WOULD ')));

  // App Users seeded from SEED_APP_USERS.
  assert.deepEqual(env.sheet('App Users').toValues().slice(1), SEED.map(u =>
    [u.email.toLowerCase(), u.name, u.defaultVehicle, 'Yes', '{}', u.driverName]));

  // Photo File ID: one exact image in the folder root → set; otherwise left blank with a WARN.
  const photo = r => env.cell('Vehicles', 'V' + r).value;
  assert.deepEqual([2, 3, 4, 5, 6].map(photo), ['photo-hl', 'photo-jp', '', '', 'photo-tl']);
  const warns = env.logRows().filter(r => r[2] === 'WARN').map(r => r[3]);
  assert.deepEqual(warns, [
    'Photo File ID V4 (' + V.x7 + ') left blank: found 2 files named "' + V.x7 + ' - Photo.png/.jpg/.jpeg/.webp" in ' +
      'its folder (' + V.x7 + ' - Photo.png, ' + V.x7 + ' - Photo.jpg). Paste the photo\'s file ID by hand.',
    'Photo File ID V5 (' + V.fourRunner + ') left blank: found 0 files named "' + V.fourRunner +
      ' - Photo.png/.jpg/.jpeg/.webp" in its folder. Paste the photo\'s file ID by hand.',
  ]);
  assert.match(msgs[msgs.length - 1], /^Done: \d+ changes made \(2 warnings above\)\.$/);
});

test('a second setupSchemaApply() changes nothing and logs "No changes needed"', () => {
  const env = setup();
  env.gas.setupSchemaApply();
  const after = snapshot(env.ss, withoutLog(env.ss));
  const logLen = env.logRows().length;

  const report = env.gas.setupSchemaApply();
  assert.equal(report.changes, 0);
  assert.deepEqual(snapshot(env.ss, withoutLog(env.ss)), after);
  const second = env.messages().slice(logLen);
  assert.ok(second.every(m => !/^(DID|WOULD) /.test(m)));
  assert.equal(second[second.length - 1], 'No changes needed (2 warnings above)');

  // And a dry run now agrees.
  assert.equal(env.gas.setupSchema().changes, 0);
  // With the photos sorted out by hand, it is simply "No changes needed".
  const vehicles = env.sheet('Vehicles');
  vehicles.getRange('V4').setValue('photo-x7-a');
  vehicles.getRange('V5').setValue('photo-4r');
  env.gas.setupSchemaApply();
  assert.equal(env.messages().pop(), 'No changes needed');
});

test('the first Latest Odometer Date formula is updated to whole days, and only that one', () => {
  const env = setup();
  env.gas.setupSchemaApply();
  const vehicles = env.sheet('Vehicles');
  // As the live Sheet was set up: the first version on every row except row 6, which was hand-edited.
  for (const r of [2, 3, 4, 5]) vehicles.getRange('AP' + r).setFormula(forRow(V1_AP2, r));
  const custom = '=MAX(Visits!$C:$C)';
  vehicles.getRange('AP6').setFormula(custom);
  const logLen = env.logRows().length;

  const dry = env.gas.setupSchema();
  assert.equal(dry.changes, 4);
  const msgs = env.messages().slice(logLen);
  assert.ok(msgs.includes('WOULD update Latest Odometer Date AP2 (' + V.highlander + ') from: ' + V1_AP2 +
    ' ; to: ' + NEW_AP2));
  assert.equal(env.cell('Vehicles', 'AP2').formula, V1_AP2, 'dry run changes nothing');

  env.gas.setupSchemaApply();
  for (const r of [2, 3, 4, 5]) assert.equal(env.cell('Vehicles', 'AP' + r).formula, forRow(NEW_AP2, r), 'AP' + r);
  assert.equal(env.cell('Vehicles', 'AP6').formula, custom, 'a hand-edited formula is left alone');
  assert.ok(env.logRows().some(r => r[2] === 'WARN' && r[3].startsWith('SKIPPED Latest Odometer Date AP6')));
  // Avg Miles/Day and Est. Current Mileage were already the new formulas: untouched.
  assert.equal(env.cell('Vehicles', 'Q2').formula, NEW_Q2);

  assert.equal(env.gas.setupSchema().changes, 0);
});

test('a hand-edited Avg Miles/Day formula is SKIPPED with a WARN, never guessed at', () => {
  const formulas = fx.liveFormulas();
  const custom = '=IFERROR(ROUND((O4-M4)/(N4-L4),2),"")';
  formulas['Vehicles']['P4'] = custom;
  // Same formula as live but typed differently: still recognised (whitespace and case don't matter).
  formulas['Vehicles']['P3'] = '= iferror( if( or(L3="", M3="", N3="", O3=""), "", round((O3-M3)/(N3-L3), 1)), "")';
  const env = setup({ formulas });
  env.gas.setupSchemaApply();

  assert.equal(env.cell('Vehicles', 'P4').formula, custom, 'left alone');
  assert.equal(env.cell('Vehicles', 'Q4').formula, forRow(NEW_Q2, 4), 'Q4 is still replaced');
  assert.equal(env.cell('Vehicles', 'P3').formula, forRow(NEW_P2, 3));
  const warn = env.logRows().filter(r => r[2] === 'WARN' && r[3].startsWith('SKIPPED Avg Miles/Day P4'));
  assert.equal(warn.length, 1);
  assert.equal(warn[0][3], 'SKIPPED Avg Miles/Day P4 (' + V.x7 + "): it isn't the formula setupSchema expects, so it " +
    'was left alone. Found: ' + custom + ' ; expected: ' + forRow(OLD_P2, 4));
  assert.ok(!env.messages().some(m => m.startsWith('DID save old formula for Avg Miles/Day P4')));

  // It stays skipped on the next run too.
  const again = env.gas.setupSchemaApply();
  assert.equal(again.changes, 0);
  assert.ok(env.messages().filter(m => m.startsWith('SKIPPED Avg Miles/Day P4')).length === 2);
});

test('a typed value in Latest Odometer is SKIPPED, and so are that row\'s Avg Miles/Day and Est. Current Mileage', () => {
  // The new columns already exist (Andrew added them by hand), one Latest Odometer typed in,
  // and one Photo File ID already chosen.
  const tabs = fx.preSetupTabs();
  tabs['Vehicles'][0] = tabs['Vehicles'][0].concat(fx.newVehicleColumns);
  for (let i = 1; i < tabs['Vehicles'].length; i++) tabs['Vehicles'][i] = tabs['Vehicles'][i].concat(fx.newVehicleColumns.map(() => ''));
  tabs['Vehicles'][4][40] = 36000;            // AO5 (4Runner)
  tabs['Vehicles'][2][21] = 'hand-picked-jp';  // V3 (Jeep)
  const env = setup({ tabs });
  env.gas.setupSchemaApply();

  assert.equal(env.cell('Vehicles', 'AO5').value, 36000);
  assert.equal(env.cell('Vehicles', 'AO5').formula, '');
  assert.equal(env.cell('Vehicles', 'P5').formula, fx.liveFormulas()['Vehicles']['P5'], 'P5 kept');
  assert.equal(env.cell('Vehicles', 'Q5').formula, fx.liveFormulas()['Vehicles']['Q5'], 'Q5 kept');
  assert.equal(env.cell('Vehicles', 'P6').formula, forRow(NEW_P2, 6), 'other rows go ahead');
  assert.equal(env.cell('Vehicles', 'V3').value, 'hand-picked-jp', 'a filled Photo File ID is never replaced');
  const msgs = env.messages();
  assert.ok(msgs.includes('SKIPPED Latest Odometer AO5 (' + V.fourRunner + '): the cell already holds a typed value: ' +
    '36000. It was left alone; clear it and run setupSchemaApply() again to add the formula.'));
  assert.ok(msgs.includes('SKIPPED Avg Miles/Day and Est. Current Mileage on row 5 (' + V.fourRunner + '): its Latest ' +
    'Odometer formulas are not in place (see the warnings above).'));
  assert.ok(!msgs.some(m => /append column/.test(m) && /Vehicles/.test(m)), 'no Vehicles column appended');
});

// ---------------------------------------------------------------- App Users seed

test('App Users is seeded only when it has no data rows; without SEED_APP_USERS it WARNs', () => {
  // Already has a row: never seeded.
  const tabs = fx.preSetupTabs();
  tabs['App Users'] = [fx.appTabHeaders['App Users'], ['someone@example.com', 'Someone', '', 'Yes', '{}', '']];
  const env = setup({ tabs });
  env.gas.setupSchemaApply();
  assert.equal(env.sheet('App Users').toValues().length, 2);
  assert.ok(!env.messages().some(m => /seed App Users/.test(m)));

  // Empty, no property: a WARN telling Andrew to add rows by hand.
  const bare = setup({ props: { SEED_APP_USERS: null } });
  bare.gas.setupSchemaApply();
  assert.equal(bare.sheet('App Users').toValues().length, 1);
  const warn = bare.messages().filter(m => m.startsWith('App Users is empty'));
  assert.equal(warn.length, 1);
  assert.match(warn[0], /SEED_APP_USERS is not set\. Andrew: add the family rows to App Users by hand/);

  // Not JSON, or bad entries.
  const broken = setup({ props: { SEED_APP_USERS: '[{"email": "oops"' } });
  broken.gas.setupSchemaApply();
  assert.ok(broken.messages().some(m => /SEED_APP_USERS is not a JSON array/.test(m)));
  const partial = setup({ props: { SEED_APP_USERS: JSON.stringify([{ name: 'No Email' }, SEED[1]]) } });
  partial.gas.setupSchemaApply();
  assert.deepEqual(partial.sheet('App Users').toValues().slice(1).map(r => r[0]), ['leo@example.com']);
  assert.ok(partial.messages().includes('SEED_APP_USERS entry 1 has no valid email; left out.'));

  // An existing but empty App Users tab is seeded.
  const emptyTabs = fx.preSetupTabs();
  emptyTabs['App Users'] = [fx.appTabHeaders['App Users']];
  const empty = setup({ tabs: emptyTabs });
  empty.gas.setupSchemaApply();
  assert.equal(empty.sheet('App Users').toValues().length, 5);
});

// ---------------------------------------------------------------- guards and helpers

test('the privileged writer only allows its allowlist, and nothing in a dry run', () => {
  const { gas } = setup();
  const run = { apply: true };
  assert.throws(() => gas.assertSetupWrite_(run, 'formula', 'Vehicles', 'Last Visit Date'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'formula', 'Vehicles', 'Last Known Mileage'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'formula', 'Schedule', 'Avg Miles/Day'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'appendHeader', 'Vehicles', 'Notes 2'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'appendHeader', 'Visits', 'Type'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'createTab', 'Visits'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'photo', 'Vehicles', 'VIN'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_(run, 'deleteRow', 'App Users'), /not allowed/);
  assert.throws(() => gas.assertSetupWrite_({ apply: false }, 'createTab', 'Recalls'), /dry run/);
  gas.assertSetupWrite_(run, 'formula', 'Vehicles', 'Est. Current Mileage');
  gas.assertSetupWrite_(run, 'appendHeader', 'Warranties', 'Covers');
  gas.assertSetupWrite_(run, 'createTab', 'Recalls');
});

test('formula column letters come from the headers, wherever the columns are', () => {
  const { gas } = setup();
  const vehicles = ['Notes', 'Vehicle', 'Purchase Date', 'Purchase Mileage', 'Last Visit Date', 'Last Known Mileage',
    'Avg Miles/Day', 'Est. Current Mileage', 'Latest Odometer', 'Latest Odometer Date'];
  const visits = ['Visit ID', 'Date', 'Vehicle', 'Location', 'Mileage'];
  const odo = ['Vehicle', 'Mileage', 'Date'];
  const L = gas.formulaLetters_(vehicles, visits, odo);
  assert.deepEqual(JSON.parse(JSON.stringify(L.missing)), []);
  const f = gas.vehicleFormulas_(L, 7);
  assert.equal(f.lo, '=IFERROR(LET(v,MAXIFS(Visits!$E:$E,Visits!$C:$C,$B7),o,MAXIFS(\'Odometer Readings\'!$B:$B,' +
    '\'Odometer Readings\'!$A:$A,$B7),m,MAX(v,o),IF(m=0,"",m)),"")');
  assert.equal(f.oldAvg, '=IFERROR(IF(OR(C7="",D7="",E7="",F7=""),"",ROUND((F7-D7)/(E7-C7),1)),"")');
  assert.equal(f.newEst, '=IFERROR(IF(OR(I7="",G7=""),I7,ROUND(I7+G7*(TODAY()-J7),0)),"")');

  const missing = gas.formulaLetters_(vehicles.slice(0, 5), visits, []);
  assert.deepEqual(JSON.parse(JSON.stringify(missing.missing)), ['Vehicles › Last Known Mileage', 'Vehicles › Avg Miles/Day',
    'Vehicles › Est. Current Mileage', 'Vehicles › Latest Odometer', 'Vehicles › Latest Odometer Date',
    'Odometer Readings › Vehicle', 'Odometer Readings › Date', 'Odometer Readings › Mileage']);
  assert.equal(gas.colLetter_(1), 'A');
  assert.equal(gas.colLetter_(26), 'Z');
  assert.equal(gas.colLetter_(27), 'AA');
  assert.equal(gas.colLetter_(42), 'AP');
  assert.equal(gas.normFormula_(' =iferror( A1 ,"") '), '=IFERROR(A1,"")');
});

test('a Visits tab without Mileage stops the formula step with a WARN (no guessing)', () => {
  const tabs = fx.preSetupTabs();
  tabs['Visits'][0] = tabs['Visits'][0].map(h => (h === 'Mileage' ? 'Odometer' : h));
  const env = setup({ tabs });
  env.gas.setupSchemaApply();
  assert.equal(env.cell('Vehicles', 'P2').formula, OLD_P2);
  assert.equal(env.cell('Vehicles', 'AO2').formula, '');
  assert.ok(env.messages().includes('SKIPPED the mileage formulas (Latest Odometer, Avg Miles/Day, Est. Current ' +
    'Mileage): missing column Visits › Mileage.'));
});

// ---------------------------------------------------------------- installTriggers, checkSetup

test('installTriggers replaces only this project\'s job triggers', () => {
  const env = setup({ triggers: [{ handler: 'jobScanStatus' }, { handler: 'jobDaily' }, { handler: 'somethingElse' }] });
  env.gas.installTriggers();
  env.gas.installTriggers();
  const t = env.services.scriptApp.triggers;
  assert.deepEqual(t.map(x => x.handler).sort(), ['jobDaily', 'jobScanStatus', 'somethingElse']);
  const scan = t.find(x => x.handler === 'jobScanStatus');
  const daily = t.find(x => x.handler === 'jobDaily');
  assert.equal(scan.everyMinutes, 30);
  assert.deepEqual([daily.atHour, daily.nearMinute, daily.everyDays, daily.timezone], [7, 30, 1, 'America/Chicago']);
  assert.equal(env.services.scriptApp.deleted.length, 4);
  assert.ok(env.logged.some(s => /installTriggers: removed 2 old trigger/.test(s)));
});

test('checkSetup reports PASS / FAIL / TODO and never throws', () => {
  const env = setup({ props: { PUSH_WORKER_SECRET: null } });
  env.services.drive.addFolder('fake-inbox', 'Inbox').addFolder('fake-needs-review', '_Needs Review');
  const report = env.gas.checkSetup();
  const lines = Array.from(report.lines);
  assert.ok(lines.includes('PASS  Script Property SHEET_ID: set'));
  assert.ok(lines.includes('FAIL  Script Property PUSH_WORKER_SECRET: missing (Project Settings › Script Properties)'));
  assert.ok(lines.includes('PASS  Journal Sheet opens: "Vehicle Maintenance Journal (test)"'));
  assert.ok(lines.includes('PASS  Inbox folder opens: "Inbox"'));
  assert.ok(lines.includes('PASS  Tab Visits headers: 12 checked'));
  assert.ok(lines.includes('TODO  App tab Recalls: missing; run setupSchemaApply()'));
  assert.ok(lines.includes('TODO  New Vehicles columns: 21 missing; run setupSchemaApply()'));
  assert.ok(lines.includes('PASS  Drive folder for ' + V.fourRunner + ': "' + V.fourRunner + '"'));
  assert.ok(lines.includes('TODO  Trigger jobDaily: not installed; run installTriggers()'));
  assert.equal(report.fail, 1);
  assert.ok(env.services.logger.lines[0].includes('checkSetup: '));
  assert.ok(!env.services.logger.lines[0].includes('test-session-secret'), 'secrets are never printed');

  // After setup and triggers, only the missing property fails.
  env.gas.setupSchemaApply();
  env.gas.installTriggers();
  const after = env.gas.checkSetup();
  assert.deepEqual([after.fail, after.todo], [1, 0]);

  // A broken SHEET_ID and missing folders are FAIL lines, not exceptions.
  const broken = setup({ props: { SHEET_ID: 'wrong-id', INBOX_FOLDER_ID: 'no-such-folder' } });
  const r = broken.gas.checkSetup();
  assert.ok(Array.from(r.lines).some(l => l.startsWith('FAIL  Journal Sheet opens: Unexpected spreadsheet ID')));
  assert.ok(Array.from(r.lines).some(l => l.startsWith('FAIL  Inbox folder opens: No item with the given ID')));
});

test('dry run on the live layout, counted by hand: 55 changes, no warnings, and a second apply finds none', () => {
  // The live Sheet (formulas.md survey): Vehicles A:U with the per-row P/Q formulas, Warranties A:G,
  // no app tabs, every vehicle's photo alone in its folder root. By hand:
  //   6 app tabs + 21 Vehicles columns (V..AP) + 2 Warranties columns (H, I) + 1 App Users seed
  //   + 5 Photo File IDs + 5 × (Latest Odometer, Latest Odometer Date) + 5 × (Avg Miles/Day, Est. Current Mileage)
  //   = 6 + 21 + 2 + 1 + 5 + 10 + 10 = 55.
  const env = loadApi({ tabs: fx.preSetupTabs(), formulas: fx.liveFormulas(), props: { SEED_APP_USERS: JSON.stringify(SEED) },
    globals: { console: Object.assign(Object.create(console), { log: () => {} }) } });
  const d = env.services.drive;
  [['fake-folder-hl', V.highlander, 'png'], ['fake-folder-jp', V.wrangler, 'png'], ['fake-folder-x7', V.x7, 'png'],
    ['fake-folder-4r', V.fourRunner, 'png'], ['fake-folder-tl', V.telluride, 'jpg']].forEach(([folder, name, ext]) => {
    d.addFolder(folder, name);
    d.addFile({ id: 'photo-' + folder, name: name + ' - Photo.' + ext, mimeType: 'image/' + (ext === 'jpg' ? 'jpeg' : ext), parentId: folder });
  });
  const dry = env.gas.setupSchema();
  assert.deepEqual([dry.apply, dry.changes, dry.warnings], [false, 55, 0]);
  const msgs = Array.from(dry.lines).map(l => l.message);
  const count = re => msgs.filter(m => re.test(m)).length;
  assert.equal(count(/^WOULD create tab /), 6);
  assert.equal(count(/^WOULD append column [A-Z]+ ".*" at the end of Vehicles$/), 21);
  assert.equal(count(/^WOULD append column [HI] ".*" at the end of Warranties$/), 2);
  assert.equal(count(/^WOULD set Photo File ID V[2-6] /), 5);
  assert.equal(count(/^WOULD set Latest Odometer (Date )?A[OP][2-6] /), 10);
  assert.equal(count(/^WOULD replace (Avg Miles\/Day P|Est\. Current Mileage Q)[2-6] /), 10);
  // Never listed: anything on Last Visit Date (N) or Last Known Mileage (O), or any journal tab but Vehicles/Warranties.
  assert.ok(!msgs.some(m => /Last Visit Date|Last Known Mileage| N[2-6] | O[2-6] /.test(m) && /^WOULD/.test(m)));

  const applied = env.gas.setupSchemaApply();
  assert.deepEqual([applied.changes, applied.warnings], [55, 0]);
  const again = env.gas.setupSchemaApply();
  assert.deepEqual([again.changes, again.warnings], [0, 0]);
  assert.equal(Array.from(again.lines).pop().message, 'No changes needed');
});
