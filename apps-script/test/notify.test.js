'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

/**
 * Notify.js: planning and selection (pure), delivery through a fake Push
 * Worker, the push/prefs handlers, and runNotifications_ on the fixture.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { makeFakes } = require('./fakes');
const { makeUrlFetchApp, workerHandler } = require('./fakes-jobs');
const fx = require('./fixtures/sheet');

const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js', 'Api.js', 'Auth.js',
  'Scans.js', 'Notify.js', 'Recalls.js', 'Jobs.js'];
const V = fx.vehicleNames;
const U = fx.users;
const plain = x => JSON.parse(JSON.stringify(x));
const TODAY = '2026-09-22';
const APP = 'https://anorby515.github.io/VehicleTracker/';

const gas = load({ files: FILES });
const at = hhmm => plain(gas.nowParts_(new Date(TODAY + 'T' + hhmm + ':00-05:00'))); // CDT
const NOON = at('12:00');
const route = (vehicle, rest) => '#/v/' + encodeURIComponent(vehicle) + (rest ? '/' + rest : '');

// ---------------------------------------------------------------- a small hand-built family

const users = [
  { email: 'robert@example.com', name: 'Robert', driverName: 'Bob', active: true, prefs: {} },
  { email: 'leo@example.com', name: 'Leo', driverName: null, active: true, prefs: {} },
  { email: 'maya@example.com', name: 'Maya', driverName: 'Maya', active: true, prefs: {} },
  { email: 'sam1@example.com', name: 'Sam', driverName: null, active: true, prefs: {} },
  { email: 'sam2@example.com', name: 'Sam', driverName: null, active: true, prefs: {} },
  { email: 'old@example.com', name: 'Old', driverName: 'Leo', active: false, prefs: {} }, // inactive: ignored
];

function sched(vehicle, type, dueBy, dueMiles, status) {
  return { id: 'schedule:' + vehicle + ':' + type, kind: 'schedule', title: type, dueBy, dueMiles, status, serviceType: type };
}

function view(name, shortName, driver, extra) {
  return Object.assign({
    name, shortName, primaryDriver: driver, estMileage: null, upcoming: [], coverage: [],
    registration: { expires: null, fileId: null, daysLeft: null }, lastMileageEvidenceDate: TODAY, visits: [],
  }, extra);
}

const vehicles = [
  view(V.fourRunner, '4Runner', 'Leo', {
    estMileage: 39600,
    upcoming: [
      sched(V.fourRunner, 'Tire Rotation', '2026-10-06', 40000, 'OK'),   // 14 days: due
      sched(V.fourRunner, 'Oil Change', '2026-10-07', 44410, 'OK'),      // 15 days: not yet
      sched(V.fourRunner, 'Wiper Blades', TODAY, null, 'Due soon'),      // today
      sched(V.fourRunner, 'Cabin Air Filter', '2026-09-01', 58630, 'Overdue'),
      { id: 'dealer:' + V.fourRunner + ':next', kind: 'dealer', title: "Dealer's next service", dueBy: '2026-12-25',
        dueMiles: 40000, status: 'OK', serviceType: null },                // 400 mi away: due
      { id: 'recommendation:x', kind: 'recommendation', title: 'Wipers', dueBy: null, status: 'Watch' },
    ],
    coverage: [
      { name: 'Gold Certified', type: 'Warranty', active: true, endsOn: '2026-10-22', endsBy: 'date', endMiles: 40640 },
      { name: 'Toyota powertrain', type: 'Warranty', active: true, endsOn: '2030-01-25', endsBy: 'date', endMiles: 100000 },
      { name: 'Old plan', type: 'Prepaid plan', active: false, endsOn: '2026-10-01', endsBy: 'date', endMiles: null },
    ],
    registration: { expires: '2027-03-31', fileId: null, daysLeft: 190 },
    lastMileageEvidenceDate: '2026-09-15',
    visits: [{ visitId: '4r-1', location: 'Sample Toyota' }],
  }),
  view(V.x7, 'X7', 'Bob', {
    estMileage: 45000,
    upcoming: [{ id: 'dealer:' + V.x7 + ':next', kind: 'dealer', dueBy: '2027-03-01', dueMiles: 47020, status: 'OK' }],
    registration: { expires: '2026-10-17', fileId: null, daysLeft: 25 },
    lastMileageEvidenceDate: '2026-07-01',                               // 83 days
  }),
  view(V.highlander, 'Highlander', 'maya', {                            // case differs from Driver Name
    registration: { expires: '2026-11-06', fileId: null, daysLeft: 45 },
    lastMileageEvidenceDate: null,
    coverage: [{ name: 'Road hazard', type: 'Tire warranty', active: true, endsOn: '2026-10-10', endsBy: 'miles', endMiles: 150000 }],
  }),
  view(V.telluride, 'Telluride', 'Zed', {                                // nobody on App Users
    upcoming: [sched(V.telluride, 'Oil Change', '2026-09-01', 17050, 'Overdue')],
    registration: { expires: '2026-10-02', fileId: null, daysLeft: 10 },
    lastMileageEvidenceDate: '2026-01-01',
  }),
];

const recallsRows = [
  { vehicle: V.telluride, campaignNumber: '26V1', status: 'New', parkIt: true, parkOutside: false },
  { vehicle: V.fourRunner, campaignNumber: '26V2', status: 'Reviewed', parkIt: false },
  { vehicle: 'Sold Car', campaignNumber: '26V3', status: 'New', parkIt: false },
  { vehicle: V.fourRunner, campaignNumber: '26V4', status: 'new', parkIt: false, parkOutside: false },
];

const scans = [
  { scanId: 's1', status: 'Filed', visitId: '4r-1', uploadedBy: 'leo@example.com', uploadedAt: '2026-09-20T10:00:00-05:00', vehicleHint: V.fourRunner },
  { scanId: 's2', status: 'Needs attention', uploadedBy: 'maya@example.com', uploadedAt: '2026-09-21T08:00:00-05:00', vehicleHint: V.highlander },
  { scanId: 's3', status: 'Needs attention', uploadedBy: 'robert@example.com', uploadedAt: '2026-09-21T09:00:00-05:00', vehicleHint: null },
  { scanId: 's4', status: 'Filed', visitId: null, uploadedBy: 'leo', uploadedAt: '2026-09-19T09:00:00-05:00', vehicleHint: V.fourRunner },
  { scanId: 's5', status: 'Filed', visitId: '4r-1', uploadedBy: 'sam', uploadedAt: '2026-09-19T09:00:00-05:00' },  // two Sams: skipped
  { scanId: 's6', status: 'Filed', visitId: '4r-1', uploadedBy: 'leo@example.com', uploadedAt: '2026-08-01T09:00:00-05:00' }, // too old
  { scanId: 's7', status: 'Waiting', uploadedBy: 'leo@example.com', uploadedAt: '2026-09-21T09:00:00-05:00' },
  { scanId: 's8', status: 'Filed', visitId: '4r-1', uploadedBy: 'old@example.com', uploadedAt: '2026-09-21T09:00:00-05:00' }, // inactive
];

const STATE = { vehicles, appUsers: users, ownerEmail: 'Robert@Example.com', scans, recallsRows, today: TODAY };

function plan(overrides) {
  return plain(gas.planNotifications_(Object.assign({}, STATE, overrides || {}), NOON));
}
const find = (list, key, email) => list.filter(c => c.key === key && (!email || c.email === email));

// ---------------------------------------------------------------- text helpers

test('notification text helpers', () => {
  assert.equal(gas.notifySentenceCase_('Tire Rotation'), 'Tire rotation');
  assert.equal(gas.notifySentenceCase_('CVT Fluid Change'), 'CVT fluid change');
  assert.equal(gas.notifyWhen_(0), 'today');
  assert.equal(gas.notifyWhen_(1), 'tomorrow');
  assert.equal(gas.notifyWhen_(5), 'in 5 days');
  assert.equal(gas.notifyWhen_(7), 'in 1 week');
  assert.equal(gas.notifyWhen_(13), 'in 2 weeks');
  assert.equal(gas.notifyWhen_(14), 'in 2 weeks');
  assert.equal(gas.isQuietHours_(at('20:59')), false);
  assert.equal(gas.isQuietHours_(at('21:00')), true);
  assert.equal(gas.isQuietHours_(at('06:59')), true);
  assert.equal(gas.isQuietHours_(at('07:00')), false);
});

// ---------------------------------------------------------------- planNotifications_

test('plan: service due, overdue and dealer go to the primary driver', () => {
  const all = plan();
  const due = find(all, 'due:' + V.fourRunner + ':Tire Rotation:2026-10-06');
  assert.deepEqual(due, [{
    email: 'leo@example.com', urgency: 'normal', key: 'due:' + V.fourRunner + ':Tire Rotation:2026-10-06',
    event: 'serviceDue', title: '4Runner', body: 'Tire rotation due in 2 weeks (or at 40,000 mi)',
    url: route(V.fourRunner, 'upcoming/' + encodeURIComponent('schedule:' + V.fourRunner + ':Tire Rotation')),
    tag: 'service:' + V.fourRunner + ':Tire Rotation', vehicle: V.fourRunner, shortName: '4Runner',
    family: 'due:' + V.fourRunner + ':Tire Rotation:',
  }]);
  assert.equal(gas.notifyLogTitle_(due[0]), '4Runner: Tire rotation due in 2 weeks (or at 40,000 mi)');
  assert.equal(find(all, 'due:' + V.fourRunner + ':Wiper Blades:' + TODAY)[0].body, 'Wiper blades due today');
  assert.equal(find(all, 'due:' + V.fourRunner + ':Oil Change:2026-10-07').length, 0); // 15 days out

  const overdue = find(all, 'overdue:' + V.fourRunner + ':Cabin Air Filter:2026-09-01');
  assert.equal(overdue.length, 1);
  assert.equal(overdue[0].email, 'leo@example.com');
  assert.equal(overdue[0].event, 'serviceOverdue');
  assert.equal(overdue[0].body, 'Cabin air filter is overdue');

  const dealer = find(all, 'dealer:' + V.fourRunner + ':2026-12-25');
  assert.equal(dealer.length, 1);
  assert.equal(dealer[0].body, 'Dealer service due around Dec 25 (or at 40,000 mi)');
  // The X7's dealer service is 2,020 mi and 160 days away: not yet.
  assert.ok(!all.some(c => c.event === 'dealerService' && c.vehicle === V.x7));

  // Within 14 days by date alone also counts; so does an overdue dealer service.
  const soon = plan({ vehicles: [view('Car', 'Car', 'Leo', { estMileage: 10000, upcoming: [
    { id: 'dealer:Car:next', kind: 'dealer', dueBy: '2026-10-01', dueMiles: 20000, status: 'Due soon' }] })] });
  assert.equal(soon.filter(c => c.event === 'dealerService')[0].key, 'dealer:Car:2026-10-01');
  const late = plan({ vehicles: [view('Car', 'Car', 'Leo', { estMileage: 20500, upcoming: [
    { id: 'dealer:Car:next', kind: 'dealer', dueBy: '2026-09-02', dueMiles: 20000, status: 'Overdue' }] })] });
  assert.equal(late.filter(c => c.event === 'dealerService')[0].body, 'Dealer service is overdue (was due around Sep 2)');
  const milesOnly = plan({ vehicles: [view('Car', 'Car', 'Leo', { estMileage: 19700, upcoming: [
    { id: 'dealer:Car:next', kind: 'dealer', dueBy: null, dueMiles: 20000, status: 'OK' }] })] });
  assert.deepEqual(milesOnly.filter(c => c.event === 'dealerService').map(c => [c.key, c.body]),
    [['dealer:Car:20000', 'Dealer service due at 20,000 mi']]);
});

test('plan: registration at 60 and 30 days, to the primary driver and the owner', () => {
  const all = plan();
  // X7: Bob is Robert, who is also the owner: one candidate, not two.
  assert.deepEqual(find(all, 'reg:' + V.x7 + ':2026-10-17:30').map(c => [c.email, c.title, c.body, c.url]),
    [['robert@example.com', 'X7', 'Registration expires Oct 17', route(V.x7, 'registration')]]);
  // Highlander at 45 days: the 60-day notice, to Maya and Robert.
  assert.deepEqual(find(all, 'reg:' + V.highlander + ':2026-11-06:60').map(c => c.email).sort(),
    ['maya@example.com', 'robert@example.com']);
  assert.equal(find(all, 'reg:' + V.highlander + ':2026-11-06:30').length, 0);
  // Telluride's driver isn't on App Users: the owner still hears about it.
  assert.deepEqual(find(all, 'reg:' + V.telluride + ':2026-10-02:30').map(c => c.email), ['robert@example.com']);
  // 190 days away: nothing.
  assert.ok(!all.some(c => c.event === 'registration' && c.vehicle === V.fourRunner));

  const expired = plan({ vehicles: [view('Car', 'Car', 'Leo', { registration: { expires: '2026-09-01', daysLeft: -21 } })] });
  assert.deepEqual(expired.filter(c => c.event === 'registration').map(c => [c.key, c.body]).sort(), [
    ['reg:Car:2026-09-01:30', 'Registration expired Sep 1'], ['reg:Car:2026-09-01:30', 'Registration expired Sep 1'],
  ]);
});

test('plan: warranty ending within 30 days, to the primary driver and the owner', () => {
  const all = plan();
  const gold = find(all, 'warranty:' + V.fourRunner + ':Gold Certified:2026-10-22');
  assert.deepEqual(gold.map(c => c.email).sort(), ['leo@example.com', 'robert@example.com']);
  assert.equal(gold[0].body, 'Gold Certified warranty ends in ~30 days');
  assert.equal(gold[0].url, route(V.fourRunner, 'coverage'));
  // Ends by miles: says where.
  const hazard = find(all, 'warranty:' + V.highlander + ':Road hazard:2026-10-10');
  assert.equal(hazard[0].body, 'Road hazard warranty ends in ~18 days (at 150,000 mi)');
  assert.ok(!all.some(c => c.key.indexOf('Toyota powertrain') !== -1 || c.key.indexOf('Old plan') !== -1));
  assert.equal(gas.notifyPlanLabel_({ name: 'BMW Ultimate Care', type: 'Prepaid plan' }), 'BMW Ultimate Care plan');
  assert.equal(gas.notifyPlanLabel_({ name: 'Kia basic warranty', type: 'Warranty' }), 'Kia basic warranty');
});

test('plan: odometer nudge after 60 days without a reading, then every 60 days', () => {
  const all = plan();
  assert.deepEqual(all.filter(c => c.event === 'odometerNudge').map(c => [c.key, c.email, c.body, c.url]), [
    ['nudge:' + V.x7 + ':2026-07-01:1', 'robert@example.com', "What's the odometer on the X7?", route(V.x7, 'odometer')],
    ['nudge:' + V.highlander + ':none:' + Math.floor(gas.ymdToDay_(TODAY) / 60), 'maya@example.com',
      "What's the odometer on the Highlander?", route(V.highlander, 'odometer')],
    // Telluride: 264 days, but nobody on App Users drives it.
  ]);
  const key = days => plan({ vehicles: [view('Car', 'Car', 'Leo', { lastMileageEvidenceDate: gas.addDays_(TODAY, -days) })] })
    .filter(c => c.event === 'odometerNudge').map(c => c.key.split(':').pop())[0];
  assert.equal(key(60), undefined);
  assert.equal(key(61), '1');
  assert.equal(key(119), '1');
  assert.equal(key(120), '2');
});

test('plan: new recalls to the primary driver and the owner', () => {
  const all = plan();
  assert.deepEqual(all.filter(c => c.event === 'newRecall').map(c => [c.key, c.email, c.body, c.urgency]), [
    ['recall:' + V.telluride + ':26V1', 'robert@example.com', 'New recall may apply to the Telluride. Do not drive until repaired.', 'high'],
    ['recall:' + V.fourRunner + ':26V4', 'leo@example.com', 'New recall may apply to the 4Runner', 'normal'],
    ['recall:' + V.fourRunner + ':26V4', 'robert@example.com', 'New recall may apply to the 4Runner', 'normal'],
  ]);
  assert.equal(find(all, 'recall:' + V.fourRunner + ':26V4')[0].url, route(V.fourRunner, 'recalls'));
});

test('plan: scan filed and scan needs attention go to the person who scanned', () => {
  const all = plan();
  assert.deepEqual(find(all, 'scanfiled:s1').map(c => [c.email, c.title, c.body, c.url]), [[
    'leo@example.com', '4Runner', 'Your Sample Toyota receipt is filed on the 4Runner', route(V.fourRunner, 'visit/4r-1'),
  ]]);
  assert.deepEqual(find(all, 'scanreview:s2').map(c => [c.email, c.title, c.body, c.url]), [[
    'maya@example.com', 'Highlander', "A receipt you scanned needs another look. Robert's been notified.", '#/scans/s2',
  ]]);
  // The owner isn't told that the owner has been notified.
  assert.equal(find(all, 'scanreview:s3')[0].body, 'A receipt you scanned needs another look.');
  assert.equal(find(all, 'scanreview:s3')[0].title, 'Vehicles');
  // Uploaded By holding a Name matches that one user; without a known visit the text stays generic.
  assert.deepEqual(find(all, 'scanfiled:s4').map(c => [c.email, c.title, c.body, c.url]),
    [['leo@example.com', 'Vehicles', 'Your receipt is filed', '#/scans/s4']]);
  // Two users named Sam: ambiguous, skipped. Too old, Waiting, or an inactive uploader: nothing.
  ['s5', 's6', 's7', 's8'].forEach(id => assert.equal(all.filter(c => c.key.endsWith(':' + id)).length, 0, id));
});

test('plan: primary driver who is the owner, nobody on App Users, events filter', () => {
  const all = plan();
  // Every candidate is for an active user (or the owner), never the inactive one sharing the name "Leo".
  assert.ok(all.every(c => c.email !== 'old@example.com'));
  // No App Users match (Telluride's "Zed"): driver-only events are dropped.
  assert.ok(!all.some(c => c.vehicle === V.telluride && ['serviceOverdue', 'odometerNudge'].includes(c.event)));
  // Owner dedupe: one copy each for Robert on his own vehicles.
  const robertX7 = all.filter(c => c.email === 'robert@example.com' && c.vehicle === V.x7);
  assert.equal(new Set(robertX7.map(c => c.key)).size, robertX7.length);
  // Only the requested events.
  assert.deepEqual(plan({ events: ['scanFiled'] }).map(c => c.key).sort(), ['scanfiled:s1', 'scanfiled:s4']);
  // Keys are unique per email.
  assert.equal(new Set(all.map(c => c.email + '|' + c.key)).size, all.length);
});

test('plan: fixture journal end to end', () => {
  const D = gas.dataFromTabs_(fx.tabs);
  const views = gas.activeVehicles_(D.vehicles).map(v => gas.buildVehicleView_(v, D, TODAY));
  const all = plain(gas.planNotifications_({
    vehicles: views, appUsers: D.appUsers.filter(u => u.active), ownerEmail: U.owner,
    scans: D.appScans, recallsRows: D.recalls, today: TODAY,
  }, NOON));
  const maya = U.highlanderDriver;
  assert.deepEqual(find(all, 'overdue:' + V.highlander + ':Oil Change:2026-07-07').map(c => c.email), [maya]);
  assert.deepEqual(find(all, 'reg:' + V.highlander + ':2026-09-01:30').map(c => [c.email, c.body]).sort(),
    [[maya, 'Registration expired Sep 1'], [U.owner, 'Registration expired Sep 1']]);
  assert.deepEqual(find(all, 'reg:' + V.wrangler + ':2026-10-15:30').map(c => c.email), [U.owner]);
  assert.deepEqual(find(all, 'warranty:' + V.highlander + ':Tire Warehouse road hazard:2026-10-15').map(c => [c.email, c.body]), [
    [maya, 'Tire Warehouse road hazard warranty ends in ~23 days'],
    [U.owner, 'Tire Warehouse road hazard warranty ends in ~23 days'],
  ]);
  assert.deepEqual(find(all, 'recall:' + V.wrangler + ':26V901000').map(c => [c.email, c.body, c.urgency]),
    [[U.owner, 'New recall may apply to the Wrangler. Do not drive until repaired.', 'high']]);
  assert.deepEqual(find(all, 'recall:' + V.telluride + ':26V904000').map(c => [c.email, c.body]).sort(), [
    [U.tellurideDriver, 'New recall may apply to the Telluride. Park outside, away from buildings.'],
    [U.owner, 'New recall may apply to the Telluride. Park outside, away from buildings.'],
  ]);
  assert.match(find(all, 'scanfiled:scan-0002')[0].body, /^Your .+ receipt is filed on the 4Runner$/);
  assert.equal(find(all, 'scanfiled:scan-0002')[0].email, U.fourRunnerDriver);
  assert.equal(find(all, 'scanreview:scan-0003')[0].email, maya);
  assert.equal(find(all, 'scanreview:scan-0006')[0].body, 'A receipt you scanned needs another look.');
  assert.equal(find(all, 'scanfiled:scan-0007').length, 0); // 33 days old
});

// ---------------------------------------------------------------- selectToSend_

function cand(key, email, extra) {
  return Object.assign({ key, email, event: 'serviceDue', title: '4Runner', body: key, url: '#/', tag: key,
    vehicle: V.fourRunner, shortName: '4Runner', urgency: 'normal' }, extra || {});
}
function logRow(key, email, sentAt, result) {
  return { key, email, title: key, sentAt, result };
}

test('select: quiet hours hold everything (20:59 sends, 21:00 and 06:59 hold, 07:30 sends)', () => {
  const c = [cand('k1', 'leo@example.com')];
  assert.equal(gas.selectToSend_(c, [], {}, at('20:59')).individual.length, 1);
  const night = plain(gas.selectToSend_(c, [], {}, at('21:00')));
  assert.equal(night.individual.length, 0);
  assert.equal(night.bundles.length, 0);
  assert.deepEqual(night.held.map(x => x.key), ['k1']);
  assert.equal(gas.selectToSend_(c, [], {}, at('06:59')).individual.length, 0);
  assert.equal(gas.selectToSend_(c, [], {}, at('07:30')).individual.length, 1);
});

test('select: daily cap with bundling', () => {
  const leo = 'leo@example.com';
  const five = ['a', 'b', 'c', 'd', 'e'].map(k => cand('k-' + k, leo));
  const log = [logRow('earlier', leo, TODAY + 'T07:31:00-05:00', 'Sent')];
  const r = plain(gas.selectToSend_(five, log, {}, NOON));
  // 3 a day, 1 already sent: 1 individual + 1 bundle of the other 4.
  assert.deepEqual(r.individual.map(c => c.key), ['k-a']);
  assert.equal(r.bundles.length, 1);
  assert.deepEqual(r.bundles[0], {
    email: leo, title: '4Runner', body: '4 things coming up on the 4Runner', url: route(V.fourRunner), tag: 'bundle',
    urgency: 'normal', keys: ['k-b', 'k-c', 'k-d', 'k-e'], items: r.bundles[0].items,
  });

  // Mixed vehicles: "N updates about your vehicles", linking to the app.
  const mixed = five.map((c, i) => Object.assign({}, c, i % 2 ? { vehicle: V.x7, shortName: 'X7' } : {}));
  const m = plain(gas.selectToSend_(mixed, [], {}, NOON));
  assert.equal(m.individual.length, 2);
  assert.equal(m.bundles[0].body, '3 updates about your vehicles');
  assert.equal(m.bundles[0].title, 'Vehicles');
  assert.equal(m.bundles[0].url, '');

  // Bundled rows count toward the cap; No device and yesterday's rows don't.
  const full = [logRow('x1', leo, TODAY + 'T07:31:00-05:00', 'Sent'), logRow('x2', leo, TODAY + 'T07:31:00-05:00', 'Bundled'),
    logRow('x3', leo, TODAY + 'T07:31:00-05:00', 'Bundled')];
  const held = plain(gas.selectToSend_(five, full, {}, NOON));
  assert.equal(held.individual.length + held.bundles.length, 0);
  assert.equal(held.held.length, 5);
  const notCounted = [logRow('x1', leo, TODAY + 'T07:31:00-05:00', 'No device'), logRow('x2', leo, '2026-09-21T19:00:00-05:00', 'Sent'),
    logRow('x3', leo, '2026-09-21T19:00:00-05:00', 'Sent'), logRow('x4', leo, '2026-09-21T19:00:00-05:00', 'Sent')];
  const fresh = plain(gas.selectToSend_(five.slice(0, 3), notCounted, {}, NOON));
  assert.equal(fresh.individual.length, 3);
  assert.equal(fresh.bundles.length, 0);

  // Exactly one left: everything goes as one bundle.
  const one = plain(gas.selectToSend_(five.slice(0, 2), full.slice(0, 2), {}, NOON));
  assert.equal(one.individual.length, 0);
  assert.deepEqual(one.bundles[0].keys, ['k-a', 'k-b']);

  // The cap is per person.
  const two = plain(gas.selectToSend_(five.slice(0, 3).concat([cand('k-m', 'maya@example.com')]), full, {}, NOON));
  assert.deepEqual(two.individual.map(c => c.email), ['maya@example.com']);
});

test('select: the most important go individually when the cap bites', () => {
  const leo = 'leo@example.com';
  const list = [cand('nudge', leo, { event: 'odometerNudge' }), cand('due', leo), cand('recall', leo, { event: 'newRecall', urgency: 'high' }),
    cand('filed', leo, { event: 'scanFiled' })];
  const r = plain(gas.selectToSend_(list, [], {}, NOON));
  assert.deepEqual(r.individual.map(c => c.key), ['recall', 'filed']);
  assert.deepEqual(r.bundles[0].keys, ['due', 'nudge']);
});

test('select: idempotent, and respects prefs', () => {
  const leo = 'leo@example.com', maya = 'maya@example.com';
  const list = [cand('k1', leo), cand('k2', leo), cand('k3', leo), cand('k1', maya), cand('k1', maya)];
  const log = [
    logRow('k1', leo, '2026-09-01T07:31:00-05:00', 'Sent'),
    logRow('k2', leo, '2026-09-01T07:31:00-05:00', 'No device'),
    logRow('k3', leo, '2026-09-01T07:31:00-05:00', 'Silent (first import)'),
  ];
  const r = plain(gas.selectToSend_(list, log, {}, NOON));
  // Already-logged keys (any Result) are never resent; Maya's copy is hers; a duplicate in the plan goes once.
  assert.deepEqual(r.individual.map(c => c.email + ':' + c.key), [maya + ':k1']);

  const prefs = { 'leo@example.com': { serviceDue: false, newRecall: true } };
  const p = plain(gas.selectToSend_([cand('a', leo), cand('b', leo, { event: 'newRecall' }), cand('c', leo, { event: 'scanFiled' })],
    [], prefs, NOON));
  assert.deepEqual(p.individual.map(c => c.key), ['b', 'c']); // serviceDue off; scanFiled missing = on
});

test('select: a drifting due date doesn\'t re-send within the repeat window', () => {
  const leo = 'leo@example.com';
  const fam = 'due:' + V.fourRunner + ':Tire Rotation:';
  const c = cand(fam + '2026-10-08', leo, { family: fam });
  const recent = [logRow(fam + '2026-10-06', leo, '2026-09-12T07:31:00-05:00', 'Sent')];
  assert.equal(gas.selectToSend_([c], recent, {}, NOON).individual.length, 0);
  const old = [logRow(fam + '2026-03-06', leo, '2026-02-20T07:31:00-05:00', 'Sent')];
  assert.equal(gas.selectToSend_([c], old, {}, NOON).individual.length, 1);
  // The family is "due:<vehicle>:<type>:" exactly: another service type doesn't block it.
  const other = [logRow('due:' + V.fourRunner + ':Tire Rotation Check:2026-10-06', leo, '2026-09-12T07:31:00-05:00', 'Sent')];
  assert.equal(gas.selectToSend_([c], other, {}, NOON).individual.length, 1);
});

// ---------------------------------------------------------------- delivery (fake Worker)

const P256 = 'B' + 'A'.repeat(86);
const AUTH = 'x'.repeat(22);
const NOW = new Date(TODAY + 'T12:30:00-05:00');

function subRow(email, endpoint, active, extra) {
  return Object.assign({ 'Email': email, 'Endpoint': endpoint, 'Keys': JSON.stringify({ p256dh: P256, auth: AUTH }),
    'Device Label': 'iPhone', 'Created At': fx.dt('2026-09-01', '10:00'), 'Active': active }, extra || {});
}

function setup(opts = {}) {
  const tabs = fx.cloneTabs();
  if (opts.subs) {
    const h = tabs['Push Subscriptions'][0];
    tabs['Push Subscriptions'] = [h].concat(opts.subs.map(o => h.map(k => (k in o ? o[k] : ''))));
  }
  if (opts.tabs) opts.tabs(tabs);
  const byEndpoint = opts.results || {};
  const http = makeUrlFetchApp(opts.handler || workerHandler(m => byEndpoint[m.subscription.endpoint]));
  const fakes = makeFakes({
    tabs,
    props: Object.assign({ OWNER_EMAIL: U.owner, PUSH_WORKER_URL: 'https://push-worker.example.workers.dev/',
      PUSH_WORKER_SECRET: 'test-secret' }, opts.props || {}),
    now: NOW.getTime(),
    extraGlobals: { UrlFetchApp: http },
  });
  const g = load({ files: FILES, globals: fakes.globals });
  const rows = name => plain(g.readTab_(name).rows);
  const sends = () => http.requests.filter(r => /\/send$/.test(r.url));
  return { gas: g, fakes, http, rows, sends };
}

const DEVICES = [
  subRow('robert@example.com', 'https://web.push.apple.com/robert-a', 'Yes'),
  subRow('robert@example.com', 'https://web.push.apple.com/robert-b', 'Yes'),
  subRow('leo@example.com', 'https://web.push.apple.com/leo-a', 'Yes'),
  subRow('maya@example.com', 'https://fcm.googleapis.com/fcm/send/maya', 'Yes'),
  subRow('maya@example.com', 'https://web.push.apple.com/maya-old', 'No'),
];
const RESULTS = {
  'https://web.push.apple.com/robert-b': { status: 410, error: '{"reason":"Unregistered"}' },
  'https://web.push.apple.com/leo-a': { status: 403, error: '{"reason":"BadJwtToken"}' },
  'https://fcm.googleapis.com/fcm/send/maya': { status: 500, error: 'http_500' },
};

test('deliver: device results, partial success, no device, and the Notification Log', () => {
  const t = setup({ subs: DEVICES, results: RESULTS });
  const selection = {
    individual: [cand('k1', 'robert@example.com'), cand('k2', 'leo@example.com'), cand('k3', 'maya@example.com'),
      cand('k4', 'nina@example.com')],
    bundles: [gas.notifyBundle_('robert@example.com', [cand('k5', 'robert@example.com'), cand('k6', 'robert@example.com')])],
    held: [],
  };
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let stats;
  try {
    stats = plain(t.gas.deliverNotifications_(selection, t.gas.readPushSubscriptions_(), NOW));
  } finally {
    console.error = origError;
  }
  assert.deepEqual(stats, { sent: 1, bundled: 2, noDevice: 1, failed: 2, devices: { ok: 2, gone: 2, config: 1, failed: 1 } });

  // Worker calls: 6 messages (Robert's 2 devices × 2, Leo 1, Maya 1 active) in batches of at most 5.
  const sends = t.sends();
  assert.deepEqual(sends.map(s => s.json.messages.length), [5, 1]);
  assert.equal(sends[0].url, 'https://push-worker.example.workers.dev/send');
  assert.equal(sends[0].opts.headers.Authorization, 'Bearer test-secret');
  assert.equal(sends[0].opts.method, 'post');
  assert.equal(sends[0].opts.muteHttpExceptions, true);
  const first = sends[0].json.messages[0];
  assert.deepEqual(Object.keys(first).sort(), ['id', 'payload', 'subscription', 'ttl', 'urgency']);
  assert.deepEqual(first.subscription, { endpoint: 'https://web.push.apple.com/robert-a', keys: { p256dh: P256, auth: AUTH } });
  assert.deepEqual(first.payload, { title: '4Runner', body: 'k1', url: APP + '#/', tag: 'k1' });
  assert.equal(first.ttl, 86400);
  assert.equal(first.urgency, 'normal');
  const bundleMsg = sends[0].json.messages.filter(m => m.payload.tag === 'bundle')[0];
  assert.deepEqual(bundleMsg.payload, { title: '4Runner', body: '2 things coming up on the 4Runner',
    url: APP + route(V.fourRunner), tag: 'bundle' });

  // Notification Log: Robert's partial success counts as Sent; each bundled key is Bundled; Nina has no
  // device; Leo (config error) and Maya (500) are not logged, so the next run retries them.
  const log = t.rows('Notification Log').slice(2); // after the fixture's two rows
  assert.deepEqual(log.map(r => [r['Key'], r['Email'], r['Title'], r['Result']]), [
    ['k1', 'robert@example.com', '4Runner: k1', 'Sent'],
    ['k4', 'nina@example.com', '4Runner: k4', 'No device'],
    ['k5', 'robert@example.com', '4Runner: k5', 'Bundled'],
    ['k6', 'robert@example.com', '4Runner: k6', 'Bundled'],
  ]);

  // Push Subscriptions: success stamps Last Success; gone → Active No; BadJwtToken keeps the row.
  const subs = t.gas.readPushSubscriptions_();
  const byEnd = e => subs.filter(s => s.endpoint === e)[0];
  assert.equal(byEnd('https://web.push.apple.com/robert-a').lastSuccess, gas.isoFromDate_(NOW));
  assert.equal(byEnd('https://web.push.apple.com/robert-a').active, true);
  assert.equal(byEnd('https://web.push.apple.com/robert-b').active, false);
  assert.equal(byEnd('https://web.push.apple.com/robert-b').lastSuccess, null);
  assert.equal(byEnd('https://web.push.apple.com/leo-a').active, true);
  assert.equal(byEnd('https://web.push.apple.com/leo-a').lastSuccess, null);
  assert.equal(byEnd('https://fcm.googleapis.com/fcm/send/maya').active, true);
  assert.ok(errors.some(e => /BadJwtToken/.test(e)), 'config error logged');
});

test('sendPush_: a Worker that refuses the whole request fails every message in it', () => {
  const t = setup({ subs: DEVICES, handler: () => ({ code: 401, body: { error: 'unauthorized' } }) });
  const origError = console.error;
  console.error = () => {};
  let stats;
  try {
    stats = plain(t.gas.deliverNotifications_({ individual: [cand('k1', 'robert@example.com')], bundles: [], held: [] },
      t.gas.readPushSubscriptions_(), NOW));
  } finally {
    console.error = origError;
  }
  assert.equal(stats.failed, 1);
  assert.equal(stats.sent, 0);
  assert.equal(t.rows('Notification Log').length, 2); // nothing new
  assert.ok(t.gas.readPushSubscriptions_().every(s => s.endpoint.indexOf('robert') === -1 || s.active)); // rows kept
  const r = plain(t.gas.sendPush_([{ id: 'x' }]));
  assert.deepEqual(r, [{ id: 'x', status: 401, ok: false, gone: false, error: 'worker_unauthorized', reason: '' }]);
});

test('sendPush_: reads the reason from the Worker\'s error text', () => {
  assert.equal(gas.pushReason_({ error: '{"reason":"BadJwtToken"}' }), 'BadJwtToken');
  assert.equal(gas.pushReason_({ reason: 'BadVapidPublicKey' }), 'BadVapidPublicKey');
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, reason: 'BadAuthorizationHeader' }), 'config');
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, reason: 'Forbidden' }), 'failed');
  assert.equal(gas.pushResultKind_({ ok: false, gone: true, status: 404 }), 'gone');
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 429 }), 'failed');
});

// ---------------------------------------------------------------- runNotifications_ on the fixture

test('runNotifications_: quiet hours send and log nothing', () => {
  const t = setup({ subs: DEVICES });
  const r = plain(t.gas.runNotifications_({ now: new Date(TODAY + 'T22:00:00-05:00') }));
  assert.equal(r.quiet, true);
  assert.equal(t.sends().length, 0);
  assert.equal(t.rows('Notification Log').length, 2);
});

test('runNotifications_: scan events only, No device when the person has no phone', () => {
  const t = setup(); // fixture: Robert has a phone; Leo's is inactive; Maya has none
  const r = plain(t.gas.runNotifications_({ now: NOW, events: t.gas.SCAN_NOTIFY_EVENTS_ }));
  assert.equal(r.noDevice, 2);
  assert.equal(t.sends().length, 0);
  assert.deepEqual(t.rows('Notification Log').slice(2).map(x => [x['Key'], x['Email'], x['Result']]), [
    ['scanfiled:scan-0002', 'leo@example.com', 'No device'],
    ['scanreview:scan-0003', 'maya@example.com', 'No device'],
  ]);
  // Nothing is logged twice.
  t.gas.runNotifications_({ now: NOW, events: t.gas.SCAN_NOTIFY_EVENTS_ });
  assert.equal(t.rows('Notification Log').length, 4);
});

test('runNotifications_: the daily run caps Robert at 3 with a bundle, and stays capped', () => {
  const t = setup();
  const r = plain(t.gas.runNotifications_({ now: NOW }));
  assert.ok(r.planned > 10);
  const robertMsgs = t.sends().flatMap(s => s.json.messages).filter(m => /robert-phone/.test(m.subscription.endpoint));
  assert.equal(robertMsgs.length, 3);
  // The recall goes first, individually.
  assert.equal(robertMsgs[0].payload.body, 'New recall may apply to the Wrangler. Do not drive until repaired.');
  assert.equal(robertMsgs[0].urgency, 'high');
  const bundle = robertMsgs[2].payload;
  assert.match(bundle.body, /^\d+ updates about your vehicles$/);
  const n = +bundle.body.split(' ')[0];
  const robertLog = t.rows('Notification Log').filter(x => x['Email'] === U.owner).slice(1); // after the fixture's row
  assert.equal(robertLog.filter(x => x['Result'] === 'Sent').length, 2);
  assert.equal(robertLog.filter(x => x['Result'] === 'Bundled').length, n);
  // Everyone else has no working phone: logged No device, never retried.
  assert.ok(t.rows('Notification Log').filter(x => x['Email'] !== U.owner && x['Result'] !== 'Sent')
    .every(x => x['Result'] === 'No device'));

  // Later the same day: Robert is at the cap, nothing new goes out, nothing is re-logged.
  const before = t.rows('Notification Log').length;
  const again = plain(t.gas.runNotifications_({ now: new Date(TODAY + 'T15:00:00-05:00') }));
  assert.equal(again.individual + again.bundles, 0);
  assert.equal(t.sends().length, 1);
  assert.equal(t.rows('Notification Log').length, before);
});

// ---------------------------------------------------------------- router handlers

const SUB = endpoint => ({ endpoint, expirationTime: null, keys: { p256dh: P256, auth: AUTH } });
const APPLE = 'https://web.push.apple.com/QNewPhone';

function apiErrorOf(fn) {
  try { fn(); } catch (e) { return { status: e.status, error: e.error, apiError: e.apiError }; }
  return null;
}

test('subscribePush_: validates, then upserts on Endpoint', () => {
  const t = setup();
  const leo = { email: 'leo@example.com' };
  assert.deepEqual(plain(t.gas.subscribePush_(leo, { subscription: SUB(APPLE), deviceLabel: 'iPhone' })), { done: true });
  let subs = t.gas.readPushSubscriptions_().filter(s => s.endpoint === APPLE);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].email, 'leo@example.com');
  assert.deepEqual(plain(subs[0].keys), { p256dh: P256, auth: AUTH });
  assert.equal(subs[0].deviceLabel, 'iPhone');
  assert.equal(subs[0].active, true);
  assert.ok(subs[0].createdAt);

  // Same endpoint again: no second row; a new label is saved; an inactive row comes back.
  const row = subs[0]._row;
  t.gas.updateAppRow_('Push Subscriptions', row, { 'Active': 'No' });
  t.gas.subscribePush_(leo, { subscription: SUB(APPLE), deviceLabel: 'iPad' });
  subs = t.gas.readPushSubscriptions_().filter(s => s.endpoint === APPLE);
  assert.equal(subs.length, 1);
  assert.equal(subs[0].deviceLabel, 'iPad');
  assert.equal(subs[0].active, true);

  // The device changed hands: the row moves to the new person.
  t.gas.subscribePush_({ email: 'Maya@Example.com' }, { subscription: SUB(APPLE), deviceLabel: 'iPad' });
  subs = t.gas.readPushSubscriptions_().filter(s => s.endpoint === APPLE);
  assert.deepEqual(plain(subs.map(s => s.email)), ['maya@example.com']);

  // Other known push services are fine.
  t.gas.subscribePush_(leo, { subscription: SUB('https://fcm.googleapis.com/fcm/send/abc'), deviceLabel: '=cmd' });
  const fcm = t.gas.readPushSubscriptions_().filter(s => s.endpoint.indexOf('fcm') !== -1)[0];
  assert.equal(fcm.deviceLabel, 'cmd');

  // Refused: unknown host, http, a port, credentials, missing or bad keys.
  const bad = [
    { subscription: SUB('https://evil.example.com/push') },
    { subscription: SUB('http://web.push.apple.com/x') },
    { subscription: SUB('https://web.push.apple.com:8443/x') },
    { subscription: SUB('https://user@web.push.apple.com/x') },
    { subscription: SUB('https://web.push.apple.com.evil.com/x') },
    { subscription: { endpoint: APPLE } },
    { subscription: { endpoint: APPLE, keys: { p256dh: P256, auth: '' } } },
    { subscription: { endpoint: APPLE, keys: { p256dh: 'not base64!', auth: AUTH } } },
  ];
  bad.forEach((p, i) => assert.deepEqual(apiErrorOf(() => t.gas.subscribePush_(leo, p)),
    { status: 400, error: 'bad_request', apiError: true }, 'case ' + i));
  // Subdomains of the allowed suffixes are fine.
  assert.equal(t.gas.isPushEndpoint_('https://api.push.apple.com/x'), true);
  assert.equal(t.gas.isPushEndpoint_('https://wns2-by3p.notify.windows.com/w/?token=x'), true);
});

test('subscribePush_: duplicate rows for one endpoint are collapsed', () => {
  const t = setup({ subs: [subRow('leo@example.com', APPLE, 'Yes'), subRow('leo@example.com', APPLE, 'Yes')] });
  t.gas.subscribePush_({ email: 'leo@example.com' }, { subscription: SUB(APPLE), deviceLabel: 'iPhone' });
  assert.deepEqual(plain(t.gas.readPushSubscriptions_().map(s => s.active)), [true, false]);
});

test('unsubscribePush_ and signOutDevice_ only touch the caller\'s own rows', () => {
  const t = setup({ subs: DEVICES });
  const leo = { email: 'leo@example.com' };
  assert.deepEqual(plain(t.gas.unsubscribePush_(leo, { endpoint: 'https://web.push.apple.com/robert-a' })), { done: true });
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('robert-a'))[0].active, true);
  t.gas.unsubscribePush_(leo, { endpoint: 'https://web.push.apple.com/leo-a' });
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('leo-a'))[0].active, false);

  const maya = { email: 'maya@example.com' };
  assert.deepEqual(plain(t.gas.signOutDevice_(maya, {})), { done: true });
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('/maya'))[0].active, true);
  t.gas.signOutDevice_(maya, { endpoint: 'https://web.push.apple.com/robert-b' });
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('robert-b'))[0].active, true);
  t.gas.signOutDevice_(maya, { endpoint: 'https://fcm.googleapis.com/fcm/send/maya' });
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('/maya'))[0].active, false);
});

test('savePrefs_: validates and writes the caller\'s Notification Prefs', () => {
  const t = setup();
  const cacheKey = t.gas.bootstrapCacheKey_();
  t.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);
  const maya = { email: 'maya@example.com' };  // stored as "Maya@Example.com"
  assert.deepEqual(plain(t.gas.savePrefs_(maya, { prefs: { odometerNudge: false, serviceDue: true } })),
    { prefs: { serviceDue: true, odometerNudge: false } });
  const row = t.rows('App Users').filter(r => r['Email'] === 'Maya@Example.com')[0];
  assert.equal(row['Notification Prefs'], '{"serviceDue":true,"odometerNudge":false}');
  assert.equal(t.fakes.scriptCache.get(cacheKey), null);
  assert.deepEqual(plain(t.gas.normAppUsers_(t.gas.readTab_('App Users')).filter(u => u.email === 'maya@example.com')[0].prefs),
    { serviceDue: true, odometerNudge: false });

  assert.deepEqual(apiErrorOf(() => t.gas.savePrefs_(maya, { prefs: { bogus: true } })),
    { status: 400, error: 'bad_request', apiError: true });
  assert.deepEqual(apiErrorOf(() => t.gas.savePrefs_(maya, { prefs: { scanFiled: 'no' } })),
    { status: 400, error: 'bad_request', apiError: true });
  assert.deepEqual(apiErrorOf(() => t.gas.savePrefs_(maya, { prefs: ['scanFiled'] })),
    { status: 400, error: 'bad_request', apiError: true });
  assert.deepEqual(apiErrorOf(() => t.gas.savePrefs_({ email: 'stranger@example.com' }, { prefs: {} })),
    { status: 403, error: 'not_family', apiError: true });
  // An empty object turns everything back on.
  assert.deepEqual(plain(t.gas.savePrefs_(maya, { prefs: {} })), { prefs: {} });
});

test('testPush_: every active device of the caller, no Notification Log rows', () => {
  const t = setup({ subs: DEVICES, results: RESULTS, props: { APP_URL: 'https://example.org/app/' } });
  assert.deepEqual(plain(t.gas.testPush_({ email: 'robert@example.com' })), { sent: 1, failed: 1 });
  const msgs = t.sends().flatMap(s => s.json.messages);
  assert.deepEqual(msgs.map(m => m.payload), [
    { title: 'Vehicles', body: 'Test notification — it works!', url: 'https://example.org/app/', tag: 'test' },
    { title: 'Vehicles', body: 'Test notification — it works!', url: 'https://example.org/app/', tag: 'test' },
  ]);
  assert.equal(t.gas.readPushSubscriptions_().filter(s => s.endpoint.endsWith('robert-b'))[0].active, false);
  assert.equal(t.rows('Notification Log').length, 2);
  // Nobody with a phone: nothing to send.
  assert.deepEqual(plain(t.gas.testPush_({ email: 'nina@example.com' })), { sent: 0, failed: 0 });
  assert.equal(t.sends().length, 1);
});

// ---------------------------------------------------------------- regressions (review)

test('pushResultKind_: VAPID config reasons are matched exactly, whatever the status; only 404/410 are gone', () => {
  for (const reason of ['BadJwtToken', 'BadAuthorizationHeader', 'BadVapidPublicKey']) {
    assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 400, reason }), 'config', reason + ' on 400');
    assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, reason }), 'config', reason + ' on 403');
  }
  // Near misses and other reasons are ordinary failures (the row is kept either way).
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, reason: 'NotBadJwtTokenAtAll' }), 'failed');
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, reason: 'VapidPkHashMismatch' }), 'failed');
  assert.equal(gas.pushResultKind_({ ok: false, gone: false, status: 403, error: 'BadJwtToken somewhere in text' }), 'failed');
  // gone wins over a reason: an expired subscription is deactivated.
  assert.equal(gas.pushResultKind_({ ok: false, gone: true, status: 410, reason: 'BadJwtToken' }), 'gone');
  // The Worker's parsed `reason` field is used as is; the raw text is only a fallback; no reason → ''.
  assert.equal(gas.pushReason_({ error: '{"reason":"Unregistered"}', reason: 'BadJwtToken' }), 'BadJwtToken');
  assert.equal(gas.pushReason_({ error: 'http_500' }), '');
});

test('deliver: a config error from the Worker\'s reason field keeps the subscription and is console.error-ed', () => {
  const t = setup({
    subs: [subRow('leo@example.com', 'https://web.push.apple.com/leo-a', 'Yes'),
      subRow('maya@example.com', 'https://fcm.googleapis.com/fcm/send/maya', 'Yes')],
    results: {
      'https://web.push.apple.com/leo-a': { status: 403, error: '{"reason":"BadVapidPublicKey"}', reason: 'BadVapidPublicKey' },
      'https://fcm.googleapis.com/fcm/send/maya': { status: 404, error: 'http_404', reason: null },
    },
  });
  const errors = [];
  const origError = console.error;
  console.error = (...a) => errors.push(a.join(' '));
  let stats;
  try {
    stats = plain(t.gas.deliverNotifications_({ individual: [cand('k1', 'leo@example.com'), cand('k2', 'maya@example.com')],
      bundles: [], held: [] }, t.gas.readPushSubscriptions_(), NOW));
  } finally {
    console.error = origError;
  }
  assert.deepEqual(stats.devices, { ok: 0, gone: 1, config: 1, failed: 0 });
  const subs = t.gas.readPushSubscriptions_();
  assert.equal(subs.filter(s => /leo-a$/.test(s.endpoint))[0].active, true, 'config error: row kept');
  assert.equal(subs.filter(s => /maya$/.test(s.endpoint))[0].active, false, '404: deactivated');
  assert.ok(errors.some(e => /BadVapidPublicKey/.test(e)));
  assert.equal(t.rows('Notification Log').length, 2, 'nothing logged: both are retried or dropped next run');
});

test('notification URLs are absolute https in-scope URLs, whatever APP_URL looks like', () => {
  const urlFor = (appUrl) => {
    const t = setup({ subs: DEVICES.slice(0, 1), props: appUrl === undefined ? {} : { APP_URL: appUrl } });
    const origError = console.error;
    console.error = () => {};
    try {
      t.gas.deliverNotifications_({ individual: [cand('k1', 'robert@example.com', { url: route(V.x7, 'odometer') })],
        bundles: [], held: [] }, t.gas.readPushSubscriptions_(), NOW);
    } finally {
      console.error = origError;
    }
    return t.sends()[0].json.messages[0].payload.url;
  };
  const hash = route(V.x7, 'odometer');
  assert.equal(urlFor(undefined), APP + hash);
  assert.equal(urlFor('https://example.org/app/'), 'https://example.org/app/' + hash);
  // No trailing slash: "/app#/..." would be outside the web app's scope (iOS opens Safari), so one is added.
  assert.equal(urlFor('https://example.org/app'), 'https://example.org/app/' + hash);
  assert.equal(urlFor('https://example.org'), 'https://example.org/' + hash);
  assert.equal(urlFor('  https://example.org/app/#/old?x=1 '), 'https://example.org/app/' + hash);
  // Not an absolute https URL: the default instead (the Worker would refuse it anyway).
  for (const bad of ['http://example.org/app/', '/VehicleTracker/', 'example.org/app', 'javascript:alert(1)']) {
    assert.equal(urlFor(bad), APP + hash, bad);
  }
});
