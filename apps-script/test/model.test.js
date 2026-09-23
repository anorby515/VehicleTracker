'use strict';
process.env.TZ = 'America/Chicago'; // the fixture's dates are local noon in Chicago

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { makeFakes } = require('./fakes');
const fx = require('./fixtures/sheet');

const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js'];
const gas = load({ files: FILES });
/** Objects built inside the vm have another realm's prototypes; compare as JSON. */
const plain = x => JSON.parse(JSON.stringify(x));
const D = gas.dataFromTabs_(fx.tabs);
const V = fx.vehicleNames;
const find = (rows, pred) => plain(rows.filter(pred)[0]);

test('fixture headers are the live headers plus Config.js setupSchema columns and app tabs', () => {
  assert.deepEqual(plain(gas.NEW_VEHICLE_COLUMNS), fx.newVehicleColumns);
  assert.deepEqual(plain(gas.NEW_WARRANTY_COLUMNS), fx.newWarrantyColumns);
  assert.deepEqual(plain(gas.APP_TAB_HEADERS), fx.appTabHeaders);
  assert.deepEqual(fx.tabs['Vehicles'][0], fx.liveHeaders['Vehicles'].concat(fx.newVehicleColumns));
  assert.deepEqual(fx.tabs['Warranties'][0], fx.liveHeaders['Warranties'].concat(fx.newWarrantyColumns));
});

test('dataFromTabs_ returns every data set the bootstrap needs', () => {
  assert.deepEqual(Object.keys(D), ['vehicles', 'visits', 'visitServices', 'documents', 'recommendations', 'readings',
    'schedule', 'warranties', 'serviceTypes', 'odometer', 'appScans', 'recalls', 'appUsers']);
  assert.equal(gas.bootstrapTabNames_().length, Object.keys(D).length);
  const counts = Object.keys(D).map(k => k + '=' + D[k].length).join(' ');
  assert.equal(counts, 'vehicles=5 visits=53 visitServices=101 documents=31 recommendations=14 readings=85 ' +
    'schedule=15 warranties=9 serviceTypes=21 odometer=3 appScans=9 recalls=5 appUsers=4');
});

test('Vehicles: every column, including the setupSchema ones, typed; blanks are null', () => {
  assert.deepEqual(find(D.vehicles, v => v.name === V.fourRunner), {
    _row: 5,
    name: '2023 Toyota 4Runner', year: 2023, make: 'Toyota', model: '4Runner', vin: 'TESTVIN0000000004',
    vinLast6: '000004', plate: 'SAMPLE4', primaryDriver: 'Leo', active: true, driveFolderId: 'fake-folder-4r',
    originalInServiceDate: '2023-01-25', purchaseDate: '2026-04-10', purchaseMileage: 28640,
    lastVisitDate: '2026-09-03', lastKnownMileage: 36690, avgMilesPerDay: 54.9, estMileage: 37704,
    dealerNextDueDate: '2026-12-25', dealerNextDueMiles: 40000,
    notes: 'Bought used; history before purchase from CarFax. Synthetic sample vehicle.', purchasePrice: null,
    photoFileId: 'fake-photo-4r', oilSpec: '0W-20 full synthetic', oilCapacity: '6.6 qt', oilFilter: 'SAMPLE-OF-400',
    engineAirFilter: 'SAMPLE-AF-400', cabinAirFilter: 'SAMPLE-CF-400', tireSize: '265/70R17',
    tirePressure: '32', // a number typed in the cell comes back as text
    wiperFrontDriver: '22 in', wiperFrontPassenger: '20 in', wiperRear: '14 in', batteryGroup: '24F',
    registrationExpires: '2027-03-31', registrationFileId: 'fake-reg-4r', nhtsaMake: 'TOYOTA', nhtsaModel: '4RUNNER',
    oemAppName: 'Toyota', oemAppLink: 'toyota://', oemAppStoreLink: null,
    latestOdometer: 37320, latestOdometerDate: '2026-09-15',
  });
  const jeep = find(D.vehicles, v => v.name === V.wrangler);
  assert.equal(jeep.plate, null);
  assert.equal(jeep.originalInServiceDate, null);
  assert.equal(jeep.oemAppName, null);
  assert.equal(jeep.registrationExpires, '2026-10-15');
  assert.deepEqual(plain(D.vehicles.map(v => v.name)), [V.highlander, V.wrangler, V.x7, V.fourRunner, V.telluride]);
});

test('Vehicles: Active is Yes (any case) only; rows without a Vehicle are dropped', () => {
  const rows = gas.normVehicles_(gas.tabFromValues_('Vehicles', [
    ['Vehicle', 'Active'], ['A', 'Yes'], ['B', 'yes '], ['C', 'No'], ['D', ''], ['', 'Yes'],
  ]));
  assert.deepEqual(plain(rows.map(r => [r.name, r.active])), [['A', true], ['B', true], ['C', false], ['D', false]]);
});

test('before setupSchemaApply: the new columns read as null and missing tabs as []', () => {
  const pre = gas.dataFromTabs_(fx.preSetupTabs());
  const r4 = find(pre.vehicles, v => v.name === V.fourRunner);
  ['photoFileId', 'oilSpec', 'registrationExpires', 'oemAppName', 'latestOdometer', 'latestOdometerDate']
    .forEach(k => assert.equal(r4[k], null, k));
  assert.equal(r4.estMileage, 37704);
  assert.deepEqual(plain(pre.warranties.map(w => [w.type, w.coversText])).slice(0, 2), [[null, null], [null, null]]);
  assert.deepEqual(plain(pre.appUsers), []);
  assert.deepEqual(plain(pre.appScans), []);
  assert.deepEqual(plain(pre.recalls), []);
  assert.deepEqual(plain(pre.odometer), []);
});

test('columns are found by header name, whatever their position', () => {
  const tab = gas.tabFromValues_('Visits', [
    ['Notes', 'Invoice Total', 'Vehicle', 'Date', 'Visit ID', 'RO #', 'Source', 'Extra column'],
    ['n', '$1,642.10', V.fourRunner, '2026-09-03', 'v-1', 827001, 'Receipt', 'ignored'],
    ['', '', V.fourRunner, fx.d('2026-09-04'), 'v-2', '', 'CarFax', ''],
    ['', '', '', '', '', '', '', ''],
    ['', 5, V.fourRunner, '', '', '', '', ''], // no Visit ID: dropped
  ]);
  const rows = plain(gas.normVisits_(tab));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].invoiceTotal, 1642.1);
  assert.equal(rows[0].roNumber, '827001');
  assert.equal(rows[0].date, '2026-09-03');
  assert.equal(rows[0].mileage, null);
  assert.equal(rows[1].invoiceTotal, null);
  assert.equal(rows[1].date, '2026-09-04');
  assert.equal(rows[1].roNumber, null);
});

test('Visits, Visit Services, Documents, Recommendations and Readings rows', () => {
  assert.deepEqual(find(D.visits, x => x.visitId === '4r-20260903-L1102'), {
    _row: 9, visitId: '4r-20260903-L1102', vehicle: V.fourRunner, date: '2026-09-03', mileage: 36690,
    location: 'Lakeview Toyota', roNumber: 'L1102',
    summary: 'Windshield replaced (rock chip); windshield camera recalibrated',
    invoiceTotal: 1642.1, amountPaid: 1683.15, cardSurcharge: 41.05,
    dealerNextDueDate: '2026-12-25', dealerNextDueMiles: 40000, source: 'Receipt', needsReview: false,
    notes: 'Invoice pages 3-4 of 4 not in scan.', addedBy: 'Claude', addedAt: '2026-09-21T15:30:00-05:00',
  });
  assert.equal(find(D.visits, x => x.visitId === 'x7-20230502-carfax').mileage, null);
  assert.equal(find(D.visits, x => x.visitId === 'hl-20180406-R1005').invoiceTotal, null);
  assert.equal(find(D.visits, x => x.visitId === 'x7-20250710-B9001').invoiceTotal, 0);

  assert.deepEqual(find(D.visitServices, s => s.visitId === '4r-20260824-L1101' && s.serviceType === 'Oil Change'), {
    _row: 13, vehicle: V.fourRunner, visitId: '4r-20260824-L1101', date: '2026-08-24', mileage: 36410,
    serviceType: 'Oil Change', description: 'ENGINE OIL CHANGE AND TIRE ROTATE (0W-20)', lineCost: 138.4,
    notes: 'Combined line with tire rotation',
  });

  const docs = D.documents.filter(x => x.vehicle === V.fourRunner);
  assert.deepEqual(plain(docs.map(x => x.complete)), [true, true, false, true]);
  assert.equal(find(D.documents, x => x.fileId === 'fake-doc-jp-sticker').complete, null);
  assert.equal(find(D.documents, x => x.fileId === 'fake-doc-tl-purchase').pages, null);
  assert.equal(find(D.documents, x => x.fileId === 'fake-doc-4r-0824-inv').pages, 8);

  assert.deepEqual(find(D.recommendations, r => r.recId === 'REC-HL-002'), {
    _row: 12, recId: 'REC-HL-002', vehicle: V.highlander, visitId: 'hl-20200519-M3001', date: '2020-05-19',
    mileage: 81400, item: 'Fog light assembly', estimate: 139, status: 'Open', resolvedByVisit: null,
    notes: 'Declined by customer',
  });

  assert.deepEqual(find(D.readings, r => r.item === 'Brake Pad — Rear' && r.value === 3), {
    _row: 76, vehicle: V.highlander, visitId: 'hl-20240924-R1007', date: '2024-09-24', mileage: 123400,
    item: 'Brake Pad — Rear', value: 3, unit: 'mm', rating: 'Caution',
  });
});

test('Schedule values pass through exactly as the Sheet computed them', () => {
  assert.deepEqual(find(D.schedule, s => s.vehicle === V.fourRunner && s.serviceType === 'Wiper Blades'), {
    _row: 6, vehicle: V.fourRunner, serviceType: 'Wiper Blades', intervalMonths: 12, intervalMiles: null,
    intervalSource: "Assumed — verify in owner's guide", lastDoneDate: '2026-09-01', lastDoneMiles: 36500,
    nextDueDate: '2027-09-01', nextDueMiles: null, estDateForMiles: null, dueBy: '2027-09-01', status: 'OK',
    todoistTaskId: 'fake-task-02',
  });
  const nh = find(D.schedule, s => s.serviceType === 'Transmission Fluid');
  assert.equal(nh.status, 'No history');
  assert.equal(nh.dueBy, null);
  assert.equal(nh.lastDoneDate, null);
});

test('Warranties keep Type and the Covers text; Service Types split their synonyms', () => {
  assert.deepEqual(find(D.warranties, w => w.name === 'Gold Certified (comprehensive)'), {
    _row: 2, vehicle: V.fourRunner, name: 'Gold Certified (comprehensive)', startDate: '2026-04-10',
    endDate: '2027-04-10', startMiles: 28640, endMiles: 40640, notes: '12 mo / 12k mi from purchase',
    type: 'Warranty', coversText: 'All',
  });
  assert.equal(find(D.warranties, w => w.vehicle === V.wrangler).endMiles, null);
  assert.equal(find(D.warranties, w => w.name === 'Toyota powertrain').startMiles, 0);
  assert.equal(find(D.warranties, w => w.name === 'Toyota powertrain').coversText, null);

  assert.deepEqual(plain(D.serviceTypes[0]), {
    _row: 2, name: 'Oil Change', synonyms: ['LOF', 'oil and filter', 'OILROTATE', 'synthetic oil service', 'oil & filter'],
  });
  assert.deepEqual(plain(D.serviceTypes.map(t => t.name)).slice(-2), ['Other', 'Unknown']);
});

test('app-owned tabs: Odometer Readings, App Scans, Recalls', () => {
  assert.deepEqual(find(D.odometer, r => r.readingId === 'odo-0003'), {
    _row: 4, readingId: 'odo-0003', vehicle: V.fourRunner, date: '2026-09-15', mileage: 37320, enteredBy: 'Leo',
    enteredAt: '2026-09-15T17:02:00-05:00', note: 'Before a road trip',
  });
  assert.deepEqual(find(D.appScans, s => s.scanId === 'scan-0002'), {
    _row: 3, scanId: 'scan-0002', kind: 'Receipt', vehicleHint: V.fourRunner, fileId: 'fake-doc-4r-0903-inv',
    fileName: 'App scan - 2023 Toyota 4Runner - 2026-09-04 0810 - Leo.pdf', pages: 3, uploadedBy: 'leo@example.com',
    uploadedAt: '2026-09-04T08:10:00-05:00', status: 'Filed', statusDetail: null, visitId: '4r-20260903-L1102',
    lastChecked: '2026-09-04T12:00:00-05:00',
  });
  assert.equal(find(D.appScans, s => s.scanId === 'scan-0005').statusDetail, 'The file is no longer in Drive.');
  assert.deepEqual(find(D.recalls, r => r.campaignNumber === '26V901000'), {
    _row: 2, vehicle: V.wrangler, campaignNumber: '26V901000', reportDate: '2026-08-20', component: 'AIR BAGS:FRONTAL',
    summary: 'Sample recall summary.', consequence: 'Sample consequence.', remedy: 'Dealers will replace the part.',
    status: 'New', firstSeen: '2026-08-21', notes: null, parkIt: true, parkOutside: false,
  });
  assert.equal(find(D.recalls, r => r.campaignNumber === '26V904000').parkOutside, true);
  assert.equal(find(D.recalls, r => r.campaignNumber === '19V902000').parkIt, false);
});

test('App Users: emails lower-cased, Driver Name, prefs parsed (bad JSON → {})', () => {
  assert.deepEqual(plain(D.appUsers), [
    { _row: 2, email: 'robert@example.com', name: 'Robert', defaultVehicle: V.x7, active: true,
      prefs: { scanFiled: false, odometerNudge: true }, driverName: 'Bob' },
    { _row: 3, email: 'leo@example.com', name: 'Leo', defaultVehicle: V.fourRunner, active: true, prefs: {},
      driverName: null },
    { _row: 4, email: 'maya@example.com', name: 'Maya', defaultVehicle: V.highlander, active: true, prefs: {},
      driverName: 'Maya' },
    // Unknown keys and non-boolean values are dropped.
    { _row: 5, email: 'nina@example.com', name: 'Nina', defaultVehicle: V.telluride, active: true,
      prefs: { newRecall: true }, driverName: null },
  ]);
  ['[true]', '42', 'null', '"text"', '{"serviceDue": "false"}'].forEach(json => {
    assert.deepEqual(plain(gas.parsePrefs_(json)), {}, json);
  });
});

test('Push Subscriptions and Notification Log (simple)', () => {
  const tabs = {
    'Push Subscriptions': gas.tabFromValues_('Push Subscriptions', fx.tabs['Push Subscriptions']),
    'Notification Log': gas.tabFromValues_('Notification Log', fx.tabs['Notification Log']),
  };
  const subs = plain(gas.normPushSubscriptions_(tabs['Push Subscriptions']));
  assert.deepEqual(subs[0], {
    _row: 2, email: 'robert@example.com', endpoint: 'https://push.example.com/send/robert-phone',
    keys: { p256dh: 'BFakeP256dhKey', auth: 'fakeAuthSecret' }, deviceLabel: 'iPhone',
    createdAt: '2026-09-01T10:00:00-05:00', lastSuccess: '2026-09-20T07:31:00-05:00', active: true,
  });
  assert.equal(subs[1].keys, null);
  assert.equal(subs[1].active, false);
  assert.equal(subs[1].lastSuccess, null);
  const log = plain(gas.normNotificationLog_(tabs['Notification Log']));
  assert.deepEqual(log[0], {
    _row: 2, key: 'scanreview:scan-0006', email: 'robert@example.com',
    title: 'A receipt you scanned needs another look', sentAt: '2026-09-20T07:31:00-05:00', result: 'Sent',
  });
  assert.deepEqual(plain(gas.normPushSubscriptions_(null)), []);
});

test('dataFromTabs_ accepts tab objects or raw arrays, and treats missing tabs as empty', () => {
  const a = gas.dataFromTabs_({ 'Vehicles': fx.tabs['Vehicles'] });
  const b = gas.dataFromTabs_({ 'Vehicles': gas.tabFromValues_('Vehicles', fx.tabs['Vehicles']) });
  assert.deepEqual(plain(a), plain(b));
  assert.equal(a.vehicles.length, 5);
  assert.deepEqual(plain(a.visits), []);
  assert.deepEqual(plain(gas.dataFromTabs_(null).appUsers), []);
});

test('loadData_ reads each tab once from the Sheet and matches dataFromTabs_', () => {
  const fakes = makeFakes({ tabs: fx.tabs });
  const reads = [];
  const orig = fakes.spreadsheet.getSheetByName.bind(fakes.spreadsheet);
  fakes.spreadsheet.getSheetByName = name => { reads.push(name); return orig(name); };
  const g = load({ files: FILES, globals: fakes.globals });
  const loaded = g.loadData_();
  assert.deepEqual(plain(loaded), plain(D));
  assert.deepEqual(reads.slice().sort(), plain(g.bootstrapTabNames_()).sort());
  assert.equal(new Set(reads).size, 13);
});

test('loadData_ works on a Sheet that is missing the app-owned tabs', () => {
  const fakes = makeFakes({ tabs: fx.preSetupTabs() });
  const g = load({ files: FILES, globals: fakes.globals });
  const loaded = g.loadData_();
  assert.equal(loaded.vehicles.length, 5);
  assert.deepEqual(plain(loaded.appUsers), []);
});
