'use strict';
process.env.TZ = 'America/Chicago'; // the fixture's dates are local noon in Chicago

/**
 * Logic.js against the synthetic fixture (TODAY = 2026-09-22) plus small
 * hand-built cases for the edges. Expected numbers are worked out by hand in
 * the comments; the Sheet-side values (Est. Current Mileage, Avg Miles/Day,
 * Schedule dates) are the fixture's.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const fx = require('./fixtures/sheet');

const gas = load({ files: ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js'] });
const plain = x => JSON.parse(JSON.stringify(x));
const TODAY = fx.TODAY;
const V = fx.vehicleNames;
const D = gas.dataFromTabs_(fx.tabs);
const vehicle = name => D.vehicles.filter(v => v.name === name)[0];
const upcoming = name => plain(gas.buildUpcoming_(vehicle(name), D, TODAY));

/** A normalized vehicle row with every field blank, plus overrides. */
function car(overrides) {
  return Object.assign(plain(gas.normVehicle_({ _row: 2, 'Vehicle': 'Test Car', 'Active': 'Yes' })), overrides || {});
}

/** An empty data object with some sets filled in. */
function data(sets) {
  return Object.assign(gas.dataFromTabs_({}), sets || {});
}

// ---------------------------------------------------------------- helpers

test('display formatting', () => {
  assert.equal(gas.fmtDate_('2026-12-25'), 'Dec 25, 2026');
  assert.equal(gas.fmtDate_('2026-09-01'), 'Sep 1, 2026');
  assert.equal(gas.fmtMonthDay_('2026-10-15'), 'Oct 15');
  assert.equal(gas.fmtDate_(null), '');
  assert.equal(gas.fmtMiles_(40000), '40,000');
  assert.equal(gas.fmtMiles_(1234567.4), '1,234,567');
  assert.equal(gas.fmtMiles_(999), '999');
  assert.equal(gas.fmtMoney_(1518.98), '$1,518.98');
  assert.equal(gas.fmtMoney_(59.9), '$59.90');
  assert.equal(gas.fmtMoney_(0), '$0.00');
  assert.equal(gas.fmtMoney_(-12.5), '-$12.50');
  // Sheets ROUND: halves away from zero.
  assert.equal(gas.roundHalfAway_(2.5), 3);
  assert.equal(gas.roundHalfAway_(-2.5), -3);
  assert.equal(gas.roundHalfAway_(-2.4), -2);
});

test('activeVehicles_: Active = Yes, in tab order', () => {
  assert.deepEqual(plain(gas.activeVehicles_(D.vehicles).map(v => v.name)),
    [V.highlander, V.wrangler, V.x7, V.fourRunner, V.telluride]);
  const tabs = fx.cloneTabs();
  tabs['Vehicles'][2][tabs['Vehicles'][0].indexOf('Active')] = 'No'; // the Jeep
  const d2 = gas.dataFromTabs_(tabs);
  assert.deepEqual(plain(gas.activeVehicles_(d2.vehicles).map(v => v.name)),
    [V.highlander, V.x7, V.fourRunner, V.telluride]);
});

test('shortName_ uses the first word of Model unless it is too generic', () => {
  assert.deepEqual(plain(D.vehicles.map(v => gas.shortName_(v))), ['Highlander', 'Wrangler', 'X7', '4Runner', 'Telluride']);
  assert.equal(gas.shortName_(car({ model: 'Grand Cherokee L' })), 'Grand Cherokee');
  assert.equal(gas.shortName_(car({ model: 'Model Y' })), 'Model Y');
  assert.equal(gas.shortName_(car({ model: 'Range Rover Sport' })), 'Range Rover');
  assert.equal(gas.shortName_(car({ model: '3 Series' })), '3 Series');
  assert.equal(gas.shortName_(car({ model: 'F-150 Lariat' })), 'F-150');
  assert.equal(gas.shortName_(car({ model: 'Grand' })), 'Grand');
  assert.equal(gas.shortName_(car({ make: 'Kia' })), 'Kia');
  assert.equal(gas.shortName_(car()), 'Test Car');
  assert.equal(gas.shortNameFor_(V.telluride, D), 'Telluride');
  assert.equal(gas.shortNameFor_('2001 Unknown Car', D), '2001 Unknown Car');
});

test('isDriverOf_ matches Driver Name (fallback Name) to Primary Driver, ignoring case', () => {
  const x7 = vehicle(V.x7); // Primary Driver "Bob"
  assert.equal(gas.isDriverOf_(x7, { name: 'Robert', driverName: 'Bob' }), true);
  assert.equal(gas.isDriverOf_(x7, { name: 'Robert', driverName: 'BOB' }), true);
  assert.equal(gas.isDriverOf_(x7, { name: 'Robert', driverName: null }), false);
  assert.equal(gas.isDriverOf_(vehicle(V.fourRunner), { name: 'leo', driverName: null }), true);
  assert.equal(gas.isDriverOf_(car(), { name: '', driverName: '' }), false);
});

test('lastMileageEvidenceDate_: newest visit with mileage or odometer reading, not in the future', () => {
  assert.equal(gas.lastMileageEvidenceDate_(vehicle(V.fourRunner), D, TODAY), '2026-09-15'); // odometer reading
  assert.equal(gas.lastMileageEvidenceDate_(vehicle(V.wrangler), D, TODAY), '2026-08-30');   // odometer reading
  assert.equal(gas.lastMileageEvidenceDate_(vehicle(V.x7), D, TODAY), '2026-02-12');         // visit
  const v = car();
  const d2 = data({
    visits: [{ vehicle: 'Test Car', date: '2026-09-01', mileage: null }, { vehicle: 'Test Car', date: '2026-05-01', mileage: 100 }],
    odometer: [{ vehicle: 'Test Car', date: '2026-10-01', mileage: 200 }, { vehicle: 'Other', date: '2026-09-20', mileage: 5 }],
  });
  assert.equal(gas.lastMileageEvidenceDate_(v, d2, TODAY), '2026-05-01');
  assert.equal(gas.lastMileageEvidenceDate_(v, data(), TODAY), null);
});

test('needsOdometerNudge_: more than 60 days without mileage evidence', () => {
  assert.equal(gas.needsOdometerNudge_({ lastMileageEvidenceDate: '2026-07-24' }, TODAY), false); // 60 days
  assert.equal(gas.needsOdometerNudge_({ lastMileageEvidenceDate: '2026-07-23' }, TODAY), true);  // 61 days
  assert.equal(gas.needsOdometerNudge_({ lastMileageEvidenceDate: null }, TODAY), true);
});

// ---------------------------------------------------------------- service types

test('matchServiceType_: names and synonyms, whole words, longest match wins', () => {
  const m = t => gas.matchServiceType_(t, D.serviceTypes);
  assert.equal(m('Cabin air filter'), 'Cabin Air Filter');          // "cabin air filter" beats "air filter"
  assert.equal(m('Engine air filter'), 'Engine Air Filter');
  assert.equal(m('Air filter'), 'Engine Air Filter');                // synonym
  assert.equal(m('Tires — tread 6/32" all four'), 'Tires');          // plural-insensitive
  assert.equal(m('Brake pads — 6 mm front / 5 mm rear'), 'Brake Service');
  assert.equal(m('Front wiper blades'), 'Wiper Blades');
  assert.equal(m('Four wheel alignment'), 'Alignment');
  assert.equal(m('Coolant service (cooling system)'), 'Coolant');
  assert.equal(m('Oil & filter change'), 'Oil Change');              // "&" = "and"
  assert.equal(m('TRANSMISSION SERVICE recommended'), 'Transmission Fluid');
  assert.equal(m('OILROTATE'), 'Oil Change');                        // tie → earlier Service Types row
  assert.equal(m('Detailed inspection'), 'Multi-Point Inspection');  // "detail" is not a whole word here
  assert.equal(m('Fuel service'), null);
  assert.equal(m('Fog light assembly'), null);
  assert.equal(m('no service listed'), null);                        // Unknown is ignored
  assert.equal(m('anything else'), null);                            // Other is ignored
  assert.equal(m(''), null);
  assert.equal(m(null), null);
});

// ---------------------------------------------------------------- coverage

test('parseCovers_: list, All (any case, anywhere), blank', () => {
  assert.deepEqual(plain(gas.parseCovers_('Oil Change, Tire Rotation')), ['Oil Change', 'Tire Rotation']);
  assert.deepEqual(plain(gas.parseCovers_(' all ')), ['All']);
  assert.deepEqual(plain(gas.parseCovers_('Oil Change, ALL')), ['All']);
  assert.deepEqual(plain(gas.parseCovers_('')), []);
  assert.deepEqual(plain(gas.parseCovers_(null)), []);
});

test('buildCoverage_: 4Runner plans, endsOn the earlier of End Date and the End Miles date', () => {
  // Gold Certified: End Miles 40,640 − est 37,704 = 2,936 mi ÷ 54.9 = 53.5 → 53 days → 2026-11-14,
  // earlier than End Date 2027-04-10. Powertrain: (100,000 − 37,704) ÷ 54.9 = 1,134.7 → 1,135 days → 2029-10-31.
  assert.deepEqual(plain(gas.buildCoverage_(vehicle(V.fourRunner), D.warranties, TODAY)), [
    { name: 'Gold Certified (comprehensive)', type: 'Warranty', startDate: '2026-04-10', endDate: '2027-04-10',
      startMiles: 28640, endMiles: 40640, endMilesDate: '2026-11-14', endsOn: '2026-11-14', endsBy: 'miles',
      covers: ['All'], active: true, notes: '12 mo / 12k mi from purchase' },
    { name: 'Toyota powertrain', type: 'Warranty', startDate: '2023-01-25', endDate: '2030-01-25', startMiles: 0,
      endMiles: 100000, endMilesDate: '2029-10-31', endsOn: '2029-10-31', endsBy: 'miles', covers: [], active: true,
      notes: '7 yr / 100k mi from in-service date' },
  ]);
  const hl = plain(gas.buildCoverage_(vehicle(V.highlander), D.warranties, TODAY))[0];
  assert.deepEqual([hl.endsOn, hl.endsBy, hl.active, hl.covers], ['2026-10-15', 'date', true, ['Tires', 'Tire Rotation']]);
  // BMW prepaid: est 48,388 is past End Miles 36,000 → inactive; its miles date is in the past.
  const x7 = plain(gas.buildCoverage_(vehicle(V.x7), D.warranties, TODAY));
  assert.deepEqual(x7.map(p => [p.name, p.active, p.endsOn, p.endsBy]), [
    ['BMW prepaid maintenance', false, '2025-12-02', 'miles'],
    ['New vehicle limited warranty', true, '2026-10-30', 'miles'],
  ]);
  // Jeep plan: End Date passed, no End Miles → inactive, ends by date.
  const jp = plain(gas.buildCoverage_(vehicle(V.wrangler), D.warranties, TODAY))[0];
  assert.deepEqual([jp.active, jp.endsOn, jp.endsBy, jp.endMilesDate], [false, '2020-07-20', 'date', null]);
});

test('coverage active rule: blank limits and a blank estimate do not count', () => {
  const plan = (w, v) => plain(gas.coveragePlan_(Object.assign({ name: 'P', type: null, startDate: null, endDate: null,
    startMiles: null, endMiles: null, notes: null, coversText: null }, w), car(v), TODAY));
  assert.equal(plan({}, {}).active, true);
  assert.equal(plan({}, {}).endsOn, null);
  assert.equal(plan({ endDate: '2026-09-23' }).active, true);
  assert.equal(plan({ endDate: TODAY }).active, false);                        // "before" the End Date
  assert.equal(plan({ endMiles: 50000 }, { estMileage: 49999 }).active, true);
  assert.equal(plan({ endMiles: 50000 }, { estMileage: 50000 }).active, false);
  assert.equal(plan({ endMiles: 50000 }, { estMileage: null }).active, true);
  const noAvg = plan({ endDate: '2027-01-01', endMiles: 50000 }, { estMileage: 10000, avgMilesPerDay: null });
  assert.deepEqual([noAvg.endMilesDate, noAvg.endsOn, noAvg.endsBy], [null, '2027-01-01', 'date']);
  const sameDay = plan({ endDate: '2026-10-02', endMiles: 10100 }, { estMileage: 10000, avgMilesPerDay: 10 });
  assert.deepEqual([sameDay.endMilesDate, sameDay.endsBy], ['2026-10-02', 'date']);  // a tie counts as the date
});

test('coveredBy_: active plans whose Covers lists the service type (any case) or is All', () => {
  const plans = [
    { name: 'All plan', active: true, covers: ['All'] },
    { name: 'Oil plan', active: true, covers: ['oil change', 'Tire Rotation'] },
    { name: 'Expired', active: false, covers: ['All'] },
    { name: 'Blank', active: true, covers: [] },
  ];
  assert.deepEqual(plain(gas.coveredBy_('Oil Change', plans)), ['All plan', 'Oil plan']);
  assert.deepEqual(plain(gas.coveredBy_('Brake Service', plans)), ['All plan']);
  assert.deepEqual(plain(gas.coveredBy_(null, plans)), []);
});

// ---------------------------------------------------------------- upcoming

const R4_UPCOMING = [
  // dueBy asc; the dealer's miles date (40,000 − 37,704) ÷ 54.9 = 41.8 → 42 days → 2026-11-03 beats Dec 25.
  ['dealer:2023 Toyota 4Runner:next', 'OK', '2026-11-03', 40000],
  ['warranty:2023 Toyota 4Runner:Gold Certified (comprehensive)', 'OK', '2026-11-14', 40640],
  ['schedule:2023 Toyota 4Runner:Oil Change', 'OK', '2027-01-22', 44410],
  ['schedule:2023 Toyota 4Runner:Tire Rotation', 'OK', '2027-01-22', 44410],
  ['schedule:2023 Toyota 4Runner:Wiper Blades', 'OK', '2027-09-01', null],
  ['schedule:2023 Toyota 4Runner:Cabin Air Filter', 'OK', '2027-10-08', 58630],
  ['schedule:2023 Toyota 4Runner:Engine Air Filter', 'OK', '2027-10-08', 58630],
  // undated Watch rows, by title
  ['recommendation:2023 Toyota 4Runner:REC-4R-006', 'Watch', null, null],
  ['recommendation:2023 Toyota 4Runner:REC-4R-003', 'Watch', null, null],
  ['recommendation:2023 Toyota 4Runner:REC-4R-004', 'Watch', null, null],
  ['recommendation:2023 Toyota 4Runner:REC-4R-005', 'Watch', null, null],
];

test('4Runner Upcoming: Schedule rows as the Sheet has them, dealer service, Watch items, warranty', () => {
  const up = upcoming(V.fourRunner);
  assert.deepEqual(up.upcoming.map(u => [u.id, u.status, u.dueBy, u.dueMiles]), R4_UPCOMING);
  assert.deepEqual(up.noHistory, []);
  const gold = ['Gold Certified (comprehensive)'];
  assert.deepEqual(up.upcoming.map(u => [u.serviceType, u.coveredBy]), [
    [null, []], [null, []],
    ['Oil Change', gold], ['Tire Rotation', gold], ['Wiper Blades', gold], ['Cabin Air Filter', gold],
    ['Engine Air Filter', gold],
    ['Brake Service', gold], ['Cabin Air Filter', gold], ['Engine Air Filter', gold], ['Tires', gold],
  ]);
});

test('4Runner Upcoming: full rows for each kind', () => {
  const up = upcoming(V.fourRunner).upcoming;
  assert.deepEqual(up[0], {
    id: 'dealer:2023 Toyota 4Runner:next', kind: 'dealer', title: "Dealer's next service",
    subtitle: 'Dealer suggested Dec 25, 2026 or 40,000 mi', dueBy: '2026-11-03', dueMiles: 40000, status: 'OK',
    serviceType: null, coveredBy: [],
  });
  assert.deepEqual(up[1], {
    id: 'warranty:2023 Toyota 4Runner:Gold Certified (comprehensive)', kind: 'warranty',
    title: 'Gold Certified (comprehensive) ends', subtitle: 'Warranty', dueBy: '2026-11-14', dueMiles: 40640,
    status: 'OK', serviceType: null, coveredBy: [],
    warranty: { name: 'Gold Certified (comprehensive)', endsBy: 'miles' },
  });
  assert.deepEqual(up[2], {
    id: 'schedule:2023 Toyota 4Runner:Oil Change', kind: 'schedule', title: 'Oil Change', subtitle: null,
    dueBy: '2027-01-22', dueMiles: 44410, status: 'OK', serviceType: 'Oil Change',
    coveredBy: ['Gold Certified (comprehensive)'],
    schedule: {
      intervalMonths: 12, intervalMiles: 8000,
      intervalSource: 'Household rule: every 12 months or 8,000 miles, whichever comes first',
      lastDoneDate: '2026-08-24', lastDoneMiles: 36410, lastDoneVisitId: '4r-20260824-L1101',
      nextDueDate: '2027-08-24', nextDueMiles: 44410, estDateForMiles: '2027-01-22', sheetStatus: 'OK',
    },
  });
  assert.equal(up[4].schedule.lastDoneVisitId, '4r-20260901-owner');   // Wiper Blades, done by the owner
  assert.equal(up[5].schedule.lastDoneVisitId, '4r-20260328-carfax');  // Cabin Air Filter, before purchase
  assert.deepEqual(up[10], {
    id: 'recommendation:2023 Toyota 4Runner:REC-4R-005', kind: 'recommendation',
    title: 'Tires — tread 6/32" all four', subtitle: 'Keep an eye on', dueBy: null, dueMiles: null, status: 'Watch',
    serviceType: 'Tires', coveredBy: ['Gold Certified (comprehensive)'],
    recommendation: { recId: 'REC-4R-005', status: 'Watch', estimate: null, visitId: '4r-20260824-L1101',
      date: '2026-08-24', mileage: 36410 },
  });
});

test('Highlander Upcoming: Overdue first, registration expired, tire warranty ending, Declined items', () => {
  const up = upcoming(V.highlander);
  assert.deepEqual(up.upcoming.map(u => [u.title, u.status, u.dueBy, u.subtitle, u.coveredBy]), [
    ['Tire Rotation', 'Overdue', '2026-07-06', null, ['Tire Warehouse road hazard']],
    ['Oil Change', 'Overdue', '2026-07-07', null, []],
    ['Registration renewal', 'Overdue', '2026-09-01', 'Expired', []],
    ['Tire Warehouse road hazard ends', 'Due soon', '2026-10-15', 'Tire warranty', []], // 23 days
    ['Air filter', 'Declined', null, 'Declined at last visit', []],
    ['Fog light assembly', 'Declined', null, 'Declined at last visit · $139.00', []],
  ]);
  // The dealer's 2024-08-20 / 119,800 mi is far more than 90 days past: hidden.
  assert.equal(up.upcoming.some(u => u.kind === 'dealer'), false);
  assert.equal(up.upcoming[4].serviceType, 'Engine Air Filter');
  assert.equal(up.upcoming[5].serviceType, null);
  assert.deepEqual(up.upcoming[5].recommendation, { recId: 'REC-HL-002', status: 'Open', estimate: 139,
    visitId: 'hl-20200519-M3001', date: '2020-05-19', mileage: 81400 });
  assert.deepEqual(up.upcoming.map(u => u.schedule && u.schedule.lastDoneVisitId).slice(0, 2),
    ['hl-20250913-T2005', 'hl-20250913-owner']);
  assert.equal(up.upcoming.some(u => u.title === 'Rear brakes starting to show wear'), false); // Done
});

test('Wrangler Upcoming: Overdue rotation, registration due soon, recall and Watch after dated rows; No history group', () => {
  const up = upcoming(V.wrangler);
  assert.deepEqual(up.upcoming.map(u => [u.id, u.status, u.dueBy]), [
    ['schedule:2016 Jeep Wrangler:Tire Rotation', 'Overdue', '2025-09-29'],
    ['registration:2016 Jeep Wrangler:2026-10-15', 'Due soon', '2026-10-15'],
    ['schedule:2016 Jeep Wrangler:Oil Change', 'OK', '2026-12-20'],
    ['recall:2016 Jeep Wrangler:26V901000', 'Recall', null],
    ['recommendation:2016 Jeep Wrangler:REC-JP-001', 'Watch', null],
  ]);
  // The rotation's Visit Services row has no mileage, and the Sheet's Last Done Miles
  // (67,420) came from an older row: the match falls back to the date alone.
  assert.equal(up.upcoming[0].schedule.lastDoneVisitId, 'jp-20251220-rot');
  assert.deepEqual(up.upcoming[3], {
    id: 'recall:2016 Jeep Wrangler:26V901000', kind: 'recall', title: 'Recall: Air bags',
    subtitle: 'May apply to this model', dueBy: null, dueMiles: null, status: 'Recall', serviceType: null,
    coveredBy: [], recall: { campaignNumber: '26V901000' },
  });
  assert.equal(up.upcoming[4].serviceType, null); // "Battery tested weak" matches no Service Type
  // An expired plan covers nothing.
  assert.deepEqual(up.upcoming[2].coveredBy, []);
  assert.deepEqual(up.noHistory, [{
    id: 'schedule:2016 Jeep Wrangler:Transmission Fluid', kind: 'schedule', title: 'Transmission Fluid',
    subtitle: null, dueBy: null, dueMiles: null, status: 'No history', serviceType: 'Transmission Fluid',
    coveredBy: [],
    schedule: { intervalMonths: 60, intervalMiles: 60000, intervalSource: "Assumed — verify in owner's guide",
      lastDoneDate: null, lastDoneMiles: null, lastDoneVisitId: null, nextDueDate: null, nextDueMiles: null,
      estDateForMiles: null, sheetStatus: 'No history' },
  }]);
});

test('X7 and Telluride Upcoming', () => {
  assert.deepEqual(upcoming(V.x7).upcoming.map(u => [u.title, u.status, u.dueBy, u.serviceType]), [
    ['Oil Change', 'Overdue', '2026-08-21', 'Oil Change'],
    ['Tire Rotation', 'Overdue', '2026-08-21', 'Tire Rotation'],
    // (50,000 − 48,388) ÷ 42.2 = 38.2 → 38 days → 2026-10-30
    ['New vehicle limited warranty ends', 'OK', '2026-10-30', null],
    ['Four wheel alignment', 'Declined', null, 'Alignment'],
    ['Fuel service', 'Declined', null, null],
  ]);
  assert.equal(upcoming(V.x7).upcoming[3].subtitle, 'Declined at last visit · $189.95');
  // The BMW prepaid plan covers oil changes but is past its End Miles.
  assert.deepEqual(upcoming(V.x7).upcoming[0].coveredBy, []);

  const tl = upcoming(V.telluride);
  assert.deepEqual(tl.upcoming.map(u => [u.title, u.status, u.dueBy, u.coveredBy]), [
    ['Oil Change', 'OK', '2027-01-30', ['Dealer prepaid maintenance']],
    ['Tire Rotation', 'OK', '2027-01-30', ['Dealer prepaid maintenance']],
    ['Recall: Electrical system', 'Recall', null, []],
  ]);
  assert.deepEqual(tl.noHistory.map(u => [u.title, u.status, u.coveredBy]), [['Cabin Air Filter', 'No history', []]]);
});

test('compareUpcoming_: Overdue first, then dueBy, undated Declined → Recall → Watch, ties by title', () => {
  const items = [
    { title: 'w', status: 'Watch', dueBy: null },
    { title: 'b', status: 'OK', dueBy: '2026-10-01' },
    { title: 'r', status: 'Recall', dueBy: null },
    { title: 'late', status: 'Overdue', dueBy: '2026-09-01' },
    { title: 'a', status: 'Due soon', dueBy: '2026-10-01' },
    { title: 'd2', status: 'Declined', dueBy: null },
    { title: 'D1', status: 'Declined', dueBy: null },
    { title: 'later', status: 'Overdue', dueBy: '2026-01-01' },
    { title: 'no date overdue', status: 'Overdue', dueBy: null },
  ];
  assert.deepEqual(items.sort(gas.compareUpcoming_).map(i => i.title),
    ['later', 'late', 'no date overdue', 'a', 'b', 'D1', 'd2', 'r', 'w']);
});

test('scheduleStatus_: the Sheet word, any case; blank → No history when undated, else OK', () => {
  const s = (status, dueBy) => gas.scheduleStatus_({ status, dueBy: dueBy || null });
  assert.equal(s('Due soon', '2026-10-01'), 'Due soon');
  assert.equal(s('OVERDUE', '2026-01-01'), 'Overdue');
  assert.equal(s('ok', '2027-01-01'), 'OK');
  assert.equal(s('No History'), 'No history');
  assert.equal(s(null, '2027-01-01'), 'OK');
  assert.equal(s(null), 'No history');
});

test('lastDoneVisitId_: exact date and miles, else date only, else null', () => {
  const services = [
    { visitId: 'A', date: '2026-01-01', mileage: 100, serviceType: 'Oil Change' },
    { visitId: 'B', date: '2026-01-01', mileage: 200, serviceType: 'oil change' },
    { visitId: 'C', date: '2026-01-01', mileage: 200, serviceType: 'Tire Rotation' },
  ];
  const s = (d, m) => gas.lastDoneVisitId_({ serviceType: 'Oil Change', lastDoneDate: d, lastDoneMiles: m }, services);
  assert.equal(s('2026-01-01', 200), 'B');
  assert.equal(s('2026-01-01', 999), 'A');
  assert.equal(s('2026-02-01', 100), null);
  assert.equal(s(null, 100), null);
});

test("dealer's next service: shown until 90 days past; dueBy is the earlier of date and miles date", () => {
  const v = o => car(Object.assign({ estMileage: 30000, avgMilesPerDay: 50 }, o));
  const dealer = o => plain(gas.dealerItem_(v(o), TODAY));
  assert.equal(gas.dealerItem_(v({}), TODAY), null);
  // Date only.
  assert.deepEqual(pick(dealer({ dealerNextDueDate: '2026-06-24' })), ['Overdue', '2026-06-24', 'Dealer suggested Jun 24, 2026']); // 90 days past
  assert.equal(dealer({ dealerNextDueDate: '2026-06-23' }), null);                                                            // 91 days past
  assert.deepEqual(pick(dealer({ dealerNextDueDate: '2026-10-22' })), ['Due soon', '2026-10-22', 'Dealer suggested Oct 22, 2026']);
  assert.deepEqual(pick(dealer({ dealerNextDueDate: '2026-10-23' })), ['OK', '2026-10-23', 'Dealer suggested Oct 23, 2026']);
  // Miles only: 32,500 is 2,500 mi ÷ 50 = 50 days away.
  assert.deepEqual(pick(dealer({ dealerNextDueMiles: 32500 })), ['OK', '2026-11-11', 'Dealer suggested 32,500 mi']);
  assert.deepEqual(pick(dealer({ dealerNextDueMiles: 31000 })), ['Due soon', '2026-10-12', 'Dealer suggested 31,000 mi']);
  // Past by 4,500 mi = 90 days of driving: still shown (Overdue); by 4,550 mi: hidden.
  assert.deepEqual(pick(dealer({ dealerNextDueMiles: 25500 })), ['Overdue', '2026-06-24', 'Dealer suggested 25,500 mi']);
  assert.equal(dealer({ dealerNextDueMiles: 25450 }), null);
  // Miles only without an average: no date, shown; Overdue once the estimate reaches the miles.
  assert.deepEqual(pick(dealer({ dealerNextDueMiles: 25000, avgMilesPerDay: null })), ['Overdue', null, 'Dealer suggested 25,000 mi']);
  assert.deepEqual(pick(dealer({ dealerNextDueMiles: 35000, avgMilesPerDay: null })), ['OK', null, 'Dealer suggested 35,000 mi']);
  // Both: the earlier wins; reaching the miles makes it Overdue even with a future date.
  assert.deepEqual(pick(dealer({ dealerNextDueDate: '2026-12-25', dealerNextDueMiles: 32500 })),
    ['OK', '2026-11-11', 'Dealer suggested Dec 25, 2026 or 32,500 mi']);
  assert.deepEqual(pick(dealer({ dealerNextDueDate: '2026-12-25', dealerNextDueMiles: 29000 })),
    ['Overdue', '2026-09-02', 'Dealer suggested Dec 25, 2026 or 29,000 mi']);
  function pick(item) { return [item.status, item.dueBy, item.subtitle]; }
});

test('registration: shown within 60 days, Overdue once expired, Due soon within 30', () => {
  const reg = expires => plain(gas.registrationItem_(car({ registrationExpires: expires }), TODAY));
  assert.equal(reg('2026-11-22'), null);                       // 61 days
  assert.equal(reg('2026-11-21').status, 'OK');                // 60 days
  assert.equal(reg('2026-10-23').status, 'OK');                // 31 days
  assert.equal(reg('2026-10-22').status, 'Due soon');          // 30 days
  assert.equal(reg(TODAY).status, 'Due soon');
  assert.deepEqual([reg('2026-09-21').status, reg('2026-09-21').subtitle], ['Overdue', 'Expired']);
  assert.equal(reg('2025-01-01').status, 'Overdue');           // long expired still shows
  assert.equal(gas.registrationItem_(car(), TODAY), null);
});

test('warranty rows: active plans ending within 90 days; Due soon within 30', () => {
  const w = (p) => plain(gas.warrantyItem_(Object.assign({ name: 'P', type: 'Warranty', endMiles: null, endsBy: 'date',
    active: true }, p), car(), TODAY));
  assert.equal(w({ endsOn: '2026-12-21' }).status, 'OK');       // 90 days
  assert.equal(w({ endsOn: '2026-12-21' }).dueBy, '2026-12-21');
  assert.equal(w({ endsOn: '2026-12-22' }), null);              // 91 days
  assert.equal(w({ endsOn: '2026-10-23' }).status, 'OK');       // 31 days
  assert.equal(w({ endsOn: '2026-10-22' }).status, 'Due soon'); // 30 days
  assert.equal(w({ endsOn: TODAY }).status, 'Due soon');
  assert.equal(w({ endsOn: '2026-09-21' }), null);              // already ended
  assert.equal(w({ endsOn: '2026-10-01', active: false }), null);
  assert.equal(w({ endsOn: null }), null);
});

// ---------------------------------------------------------------- visits

test('Highlander journal: newest first by Date then Mileage, starting with 2025-12-02 at the Toyota dealer', () => {
  const visits = plain(gas.buildVisits_(vehicle(V.highlander), D));
  assert.equal(visits.length, 18);
  assert.deepEqual(visits.slice(0, 4).map(x => [x.date, x.mileage, x.visitId, x.location]), [
    ['2025-12-02', 134120, 'hl-20251202-R1008', 'Riverside Toyota'],
    ['2025-09-13', 133005, 'hl-20250913-owner', 'Quick Lube Express'],   // same day, higher mileage first
    ['2025-09-13', 133000, 'hl-20250913-T2005', 'Tire Warehouse'],
    ['2024-10-27', 124700, 'hl-20241027-T2004', 'Tire Warehouse'],
  ]);
  assert.equal(visits[visits.length - 1].visitId, 'hl-20140517-purchase');
  assert.deepEqual(visits[0], {
    visitId: 'hl-20251202-R1008', date: '2025-12-02', mileage: 134120, location: 'Riverside Toyota', roNumber: 'R1008',
    summary: 'Rear brake service (pads, shim kit)', invoiceTotal: 412.5, amountPaid: 412.5, cardSurcharge: null,
    dealerNextDueDate: null, dealerNextDueMiles: null, source: 'Receipt', sourceTag: null, beforeOwnership: false,
    notes: null,
    services: [{ serviceType: 'Brake Service', description: 'REAR BRAKE PADS, SHIM KIT', lineCost: 398.2, notes: null }],
    documents: [
      { documentType: 'Invoice', fileName: '2014 Toyota Highlander - 2025 12 02 - Riverside Toyota.png',
        fileId: 'fake-doc-hl-1202-inv', pages: 1, complete: true, notes: null, kind: 'image' },
      { documentType: 'Payment', fileName: '2014 Toyota Highlander - 2025 12 02 - Riverside Toyota (payment receipt).png',
        fileId: 'fake-doc-hl-1202-pay', pages: 1, complete: true, notes: null, kind: 'image' },
    ],
    recommendations: [],
    readings: [
      { item: 'Brake Pad — Front', value: 5, unit: 'mm', rating: 'Caution' },
      { item: 'Brake Pad — Rear', value: 10, unit: 'mm', rating: 'Good' },
    ],
  });
  const blank = visits.filter(x => x.invoiceTotal === null).map(x => x.visitId);
  assert.deepEqual(blank, ['hl-20250913-owner', 'hl-20241027-T2004', 'hl-20240924-R1007', 'hl-20230328-T2003',
    'hl-20180406-R1005', 'hl-20140517-purchase']);
  const pagesMissing = visits.filter(x => x.documents.some(dd => dd.complete === false)).map(x => x.visitId);
  assert.deepEqual(pagesMissing, ['hl-20180406-R1005', 'hl-20161026-R1003']);
});

test('X7 journal: CarFax visits before the purchase date are tagged; merged PDF before page images', () => {
  const visits = plain(gas.buildVisits_(vehicle(V.x7), D));
  assert.deepEqual(visits.map(x => [x.date, x.sourceTag, x.beforeOwnership]), [
    ['2026-02-12', null, false],
    ['2025-07-10', null, false],
    ['2024-11-30', 'Purchase', false],   // the purchase day itself is ours
    ['2024-10-22', 'CarFax', true],
    ['2023-12-19', 'CarFax', true],
    ['2023-08-08', 'CarFax', true],
    ['2023-05-02', 'CarFax', true],      // no mileage reported
    ['2023-02-20', 'CarFax', true],
  ]);
  assert.deepEqual(visits[0].documents.map(dd => [dd.fileId, dd.kind]), [
    ['fake-doc-x7-0212-merged', 'pdf'],
    ['fake-doc-x7-0212-p1', 'image'], ['fake-doc-x7-0212-p2', 'image'],
    ['fake-doc-x7-0212-p3', 'image'], ['fake-doc-x7-0212-p4', 'image'],
  ]);
  assert.equal(visits[0].services.length, 9);
  assert.deepEqual(visits[1].recommendations.map(r => [r.recId, r.status, r.resolvedByVisit]), [
    ['REC-X7-001', 'Open', null], ['REC-X7-002', 'Done', 'x7-20260212-B9002'], ['REC-X7-003', 'Open', null],
  ]);
  assert.equal(visits[1].documents[0].complete, false);
});

test('sourceTag_, document kinds, and joins on Visit ID + Vehicle', () => {
  assert.deepEqual(['Receipt', 'CarFax', 'carfax', 'Purchase', 'Owner-reported', 'Owner journal', 'Something', null]
    .map(s => gas.sourceTag_(s)), [null, 'CarFax', 'CarFax', 'Purchase', 'Owner', 'Owner', null, null]);
  assert.deepEqual(['a.PDF', 'b.png', 'c.JPG', 'd.heic', 'e.docx', 'no extension', null].map(f => gas.documentKind_(f)),
    ['pdf', 'image', 'image', 'image', 'other', 'other', 'other']);

  const jeep = plain(gas.buildVisits_(vehicle(V.wrangler), D));
  assert.deepEqual(jeep.slice(0, 2).map(x => [x.visitId, x.mileage]), [['jp-20251220-oil', 77900], ['jp-20251220-rot', null]]);
  const purchase = jeep.filter(x => x.visitId === 'jp-20160812-purchase')[0];
  assert.deepEqual(purchase.documents.map(dd => [dd.kind, dd.complete]), [['image', true], ['other', null]]);
  assert.equal(jeep.filter(x => x.visitId === 'jp-20160628-F5001')[0].beforeOwnership, true);

  // Rows for the same Visit ID on another vehicle are not joined; documents without a file ID are skipped.
  const d2 = data({
    visits: [{ _row: 2, visitId: 'V1', vehicle: 'Test Car', date: '2026-01-01', mileage: 1, source: 'Receipt', invoiceTotal: null }],
    visitServices: [{ vehicle: 'Test Car', visitId: 'V1', serviceType: 'Oil Change', description: 'x', lineCost: 1, notes: null },
      { vehicle: 'Other Car', visitId: 'V1', serviceType: 'Tires', description: 'y', lineCost: 2, notes: null }],
    documents: [{ _row: 2, vehicle: 'Test Car', visitId: 'V1', fileId: null, fileName: 'a.pdf' },
      { _row: 3, vehicle: 'Test Car', visitId: 'V1', fileId: 'F', fileName: 'b.png' }],
  });
  const v1 = plain(gas.buildVisits_(car(), d2))[0];
  assert.deepEqual(v1.services.map(s => s.serviceType), ['Oil Change']);
  assert.deepEqual(v1.documents.map(dd => dd.fileId), ['F']);
  assert.equal(v1.beforeOwnership, false); // no Purchase Date
});

test('4Runner visit detail joins services, documents (PDF first), recommendations and readings', () => {
  const v = plain(gas.buildVisits_(vehicle(V.fourRunner), D)).filter(x => x.visitId === '4r-20260824-L1101')[0];
  assert.deepEqual(v.services.map(s => [s.serviceType, s.lineCost]),
    [['Multi-Point Inspection', 0], ['Oil Change', 138.4], ['Tire Rotation', null]]);
  assert.deepEqual(v.documents.map(dd => dd.kind), ['pdf', 'image']);
  assert.equal(v.recommendations.length, 6);
  assert.equal(v.readings.length, 8);
  assert.deepEqual([v.dealerNextDueDate, v.dealerNextDueMiles, v.cardSurcharge], ['2026-12-06', 40000, 4.75]);
});

// ---------------------------------------------------------------- costs

test('costs, 4Runner: three visits since purchase; cost per mile from Latest Odometer', () => {
  // 158.40 + 32.50 (owner-reported) + 1,642.10 = 1,833.00; per mile 1,833 ÷ (37,320 − 28,640) = 0.2112.
  assert.deepEqual(plain(gas.buildCosts_(vehicle(V.fourRunner), D, TODAY)), {
    thisYear: 1833, last12Months: 1833, sincePurchase: 1833, costPerMile: 0.2112, visitsWithoutTotal: 0,
    byYear: [{ year: 2026, total: 1833 }],
    byServiceType: [
      { serviceType: 'Windshield Replacement', total: 1150.1 },
      { serviceType: 'Windshield Calibration', total: 372 },
      { serviceType: 'Oil Change', total: 138.4 },
      { serviceType: 'Wiper Blades', total: 32.5 },
    ],
  });
});

test('costs, Highlander: blank totals counted, zero years included, last 12 months = (today − 365, today]', () => {
  // 76.15 + 812.40 + 64.10 + 309.80 + 486.25 + 71.30 + 905.16 + 96.20 + 412.50 = 3,233.86 (plus four $0 visits).
  // Per mile: 3,233.86 ÷ (134,120 − 7) = 0.0241. Only 2025-12-02 falls after 2025-09-22.
  assert.deepEqual(plain(gas.buildCosts_(vehicle(V.highlander), D, TODAY)), {
    thisYear: 0, last12Months: 412.5, sincePurchase: 3233.86, costPerMile: 0.0241, visitsWithoutTotal: 5,
    byYear: [
      { year: 2014, total: 0 }, { year: 2015, total: 0 }, { year: 2016, total: 76.15 }, { year: 2017, total: 876.5 },
      { year: 2018, total: 309.8 }, { year: 2019, total: 0 }, { year: 2020, total: 486.25 }, { year: 2021, total: 0 },
      { year: 2022, total: 976.46 }, { year: 2023, total: 0 }, { year: 2024, total: 96.2 }, { year: 2025, total: 412.5 },
      { year: 2026, total: 0 },
    ],
    byServiceType: [
      { serviceType: 'Tires', total: 1610 },           // 760.00 + 850.00
      { serviceType: 'Brake Service', total: 995.55 },  // 219.95 + 377.40 + 398.20
      { serviceType: 'Oil Change', total: 353.8 },      // 57.45 + 61.85 + 79.65 + 66.10 + 88.75
      { serviceType: 'Other', total: 35.7 },
      { serviceType: 'Tire Rotation', total: 22.45 },
      { serviceType: 'Wiper Blades', total: 16.95 },
    ],
  });
});

test('costs, Wrangler, X7, Telluride: visits before purchase and the purchase row are left out', () => {
  // Jeep: the $0.00 selling-dealer visit on 2016-06-28 is before purchase. 168.20 + 26.49 + 395.60 + 488.10
  // + 142.30 + 642.75 = 1,863.44; per mile 1,863.44 ÷ (82,700 − 3,150) = 0.0234.
  const jp = plain(gas.buildCosts_(vehicle(V.wrangler), D, TODAY));
  assert.deepEqual([jp.sincePurchase, jp.thisYear, jp.last12Months, jp.costPerMile, jp.visitsWithoutTotal],
    [1863.44, 0, 0, 0.0234, 3]);
  assert.deepEqual(jp.byYear.map(y => y.year), [2016, 2017, 2018, 2019, 2020, 2021, 2022, 2023, 2024, 2025, 2026]);
  assert.equal(jp.byYear.filter(y => y.year === 2024)[0].total, 785.05);
  assert.deepEqual(jp.byServiceType.map(t => [t.serviceType, t.total]), [
    ['Other', 896.4], ['Brake Service', 452.8], ['Battery Replacement', 164.8], ['Oil Change', 84.5],
    ['Engine Air Filter', 63.4], ['Tire Rotation', 50],
  ]);
  // X7: CarFax visits before 2024-11-30 don't count; 412.18 ÷ (39,020 − 20,480) = 0.0222.
  assert.deepEqual(plain(gas.buildCosts_(vehicle(V.x7), D, TODAY)), {
    thisYear: 412.18, last12Months: 412.18, sincePurchase: 412.18, costPerMile: 0.0222, visitsWithoutTotal: 0,
    byYear: [{ year: 2024, total: 0 }, { year: 2025, total: 0 }, { year: 2026, total: 412.18 }],
    byServiceType: [{ serviceType: 'Coolant', total: 292.4 }, { serviceType: 'Tire Rotation', total: 51.95 }],
  });
  // Telluride: 104.80 + 151.20 + 27.40 = 283.40; ÷ (10,180 − 12) = 0.0279.
  const tl = plain(gas.buildCosts_(vehicle(V.telluride), D, TODAY));
  assert.deepEqual([tl.sincePurchase, tl.costPerMile, tl.byYear, tl.byServiceType.map(t => t.total)],
    [283.4, 0.0279, [{ year: 2025, total: 0 }, { year: 2026, total: 283.4 }], [185.9, 36.95, 22.95]]);
});

test('costs edge cases: missing purchase data, 12-month boundary, undated visits, blank service types', () => {
  const visits = [
    { visitId: 'a', vehicle: 'Test Car', date: '2025-09-22', source: 'Receipt', invoiceTotal: 100 }, // today − 365: out
    { visitId: 'b', vehicle: 'Test Car', date: '2025-09-23', source: 'Receipt', invoiceTotal: 10 },  // in
    { visitId: 'c', vehicle: 'Test Car', date: TODAY, source: 'Receipt', invoiceTotal: 1.1 },        // in
    { visitId: 'd', vehicle: 'Test Car', date: '2026-10-01', source: 'Receipt', invoiceTotal: 1000 },// future: out of 12 mo
    { visitId: 'e', vehicle: 'Test Car', date: null, source: 'Receipt', invoiceTotal: 5 },           // undated: ignored
    { visitId: 'f', vehicle: 'Test Car', date: '2023-05-05', source: 'purchase', invoiceTotal: 50000 },
    { visitId: 'g', vehicle: 'Test Car', date: '2023-06-01', source: 'CarFax', invoiceTotal: null },
  ];
  const services = [
    { vehicle: 'Test Car', visitId: 'b', serviceType: null, lineCost: 4 },
    { vehicle: 'Test Car', visitId: 'b', serviceType: 'Other', lineCost: 1 },
    { vehicle: 'Test Car', visitId: 'c', serviceType: 'Wash', lineCost: 5 },
    { vehicle: 'Test Car', visitId: 'c', serviceType: 'Zero', lineCost: 0 },
    { vehicle: 'Test Car', visitId: 'f', serviceType: 'Purchase fees', lineCost: 900 },
    { vehicle: 'Test Car', visitId: 'e', serviceType: 'Undated', lineCost: 7 },
  ];
  // No Purchase Date: every dated visit except the Purchase row; chart from the first visit's year.
  const c = plain(gas.buildCosts_(car({ lastKnownMileage: 20000 }), data({ visits, visitServices: services }), TODAY));
  assert.deepEqual(c, {
    thisYear: 1001.1, last12Months: 11.1, sincePurchase: 1111.1, costPerMile: null, visitsWithoutTotal: 1,
    byYear: [{ year: 2023, total: 0 }, { year: 2024, total: 0 }, { year: 2025, total: 110 }, { year: 2026, total: 1001.1 }],
    byServiceType: [{ serviceType: 'Other', total: 5 }, { serviceType: 'Wash', total: 5 }],
  });
  // Latest Odometer blank (before setup): falls back to Last Known Mileage.
  const withPurchase = car({ purchaseDate: '2025-01-01', purchaseMileage: 10000, lastKnownMileage: 20000 });
  assert.equal(plain(gas.buildCosts_(withPurchase, data({ visits }), TODAY)).costPerMile, 0.1111); // 1,111.10 ÷ (20,000 − 10,000)
  assert.equal(plain(gas.buildCosts_(car({ purchaseMileage: 20000, latestOdometer: 20000 }), data({ visits }), TODAY))
    .costPerMile, null);
  // No visits at all: one zero bar for this year.
  assert.deepEqual(plain(gas.buildCosts_(car(), data(), TODAY)).byYear, [{ year: 2026, total: 0 }]);
});

// ---------------------------------------------------------------- wear

test('wear, Highlander tread: lowest wheel per visit; the run restarts after new tires; projection', () => {
  // Run after the last increase (8 → 9): 9 @ 101,300, 6 @ 124,700, 5 @ 133,000. Least squares:
  // mean x 119,666.7, mean y 6.667, slope −68,433.3 ÷ 540,446,667 = −0.00012662/mi,
  // 4/32 reached at 119,666.7 + 2.667 ÷ 0.00012662 = 140,726 mi. Date: (140,726 − 143,469) ÷ 31.8 = −86.3
  // → 86 days before today = 2026-06-28 (already past).
  assert.deepEqual(plain(gas.buildWear_(vehicle(V.highlander), D, TODAY).tread), {
    label: 'Tire tread', unit: '/32 in', replacementPoint: 4,
    latest: { value: 5, date: '2025-09-13', mileage: 133000, rating: 'Caution', visitId: 'hl-20250913-T2005' },
    readings: [
      { value: 5, date: '2016-10-26', mileage: 32140, visitId: 'hl-20161026-R1003' },
      { value: 11, date: '2017-07-11', mileage: 41250, visitId: 'hl-20170711-R1004' },
      { value: 8, date: '2018-04-06', mileage: 50900, visitId: 'hl-20180406-R1005' },
      { value: 9, date: '2023-03-28', mileage: 101300, visitId: 'hl-20230328-T2003' },
      { value: 6, date: '2024-10-27', mileage: 124700, visitId: 'hl-20241027-T2004' },
      { value: 5, date: '2025-09-13', mileage: 133000, visitId: 'hl-20250913-T2005' },
    ],
    projection: { mileage: 140726, date: '2026-06-28' },
    note: null,
  });
});

test('wear, Highlander brakes: axle-only items ("Brake Pad — Front") work; a new rear pad resets the run', () => {
  const w = plain(gas.buildWear_(vehicle(V.highlander), D, TODAY));
  // Front 7 @ 50,900, 6 @ 123,400, 5 @ 134,120: 3 mm at 250,568 mi; (250,568 − 143,469) ÷ 31.8 = 3,367.9 → 3,368 days.
  assert.deepEqual(w.brakeFront.readings.map(r => [r.value, r.mileage]), [[7, 50900], [6, 123400], [5, 134120]]);
  assert.deepEqual(w.brakeFront.projection, { mileage: 250568, date: '2035-12-12' });
  assert.equal(w.brakeFront.note, null);
  assert.deepEqual([w.brakeFront.label, w.brakeFront.unit, w.brakeFront.replacementPoint], ['Front brake pads', 'mm', 3]);
  // Rear 8, 3, then 10 after the brake job: the run is just the 10.
  assert.deepEqual(w.brakeRear.readings.map(r => r.value), [8, 3, 10]);
  assert.deepEqual([w.brakeRear.projection, w.brakeRear.note], [null, 'One reading so far']);
  assert.deepEqual(w.brakeRear.latest, { value: 10, date: '2025-12-02', mileage: 134120, rating: 'Good',
    visitId: 'hl-20251202-R1008' });
});

test('wear, Wrangler: "(outside edge)" readings count; straight-line projections from two readings', () => {
  const w = plain(gas.buildWear_(vehicle(V.wrangler), D, TODAY));
  // Tread lows: 4 (2020, right front outside edge), 11 (new tires), 9 (left front outside edge).
  // Run 11 @ 54,800 → 9 @ 68,300: −2/13,500 per mile; 4 reached after 7 × 6,750 = 47,250 more → 102,050.
  // Date: (102,050 − 83,199) ÷ 21.7 = 868.7 → 869 days → 2029-02-07.
  assert.deepEqual(w.tread.readings.map(r => r.value), [4, 11, 9]);
  assert.deepEqual(w.tread.latest, { value: 9, date: '2024-11-27', mileage: 68300, rating: 'Caution',
    visitId: 'jp-20241127-P8001' });
  assert.deepEqual(w.tread.projection, { mileage: 102050, date: '2029-02-07' });
  // Front 6 → 5: 3 mm at 54,800 + 3 × 13,500 = 95,300; (95,300 − 83,199) ÷ 21.7 = 557.6 → 558 days → 2028-04-02.
  assert.deepEqual(w.brakeFront.projection, { mileage: 95300, date: '2028-04-02' });
  // Rear 10 → 9: 3 mm at 54,800 + 7 × 13,500 = 149,300.
  assert.deepEqual(w.brakeRear.projection, { mileage: 149300, date: '2035-01-24' });
});

test('wear notes: one reading, flat readings, none at all', () => {
  const r4 = plain(gas.buildWear_(vehicle(V.fourRunner), D, TODAY));
  assert.deepEqual([r4.tread.latest.value, r4.tread.note, r4.tread.projection], [6, 'One reading so far', null]);
  assert.deepEqual([r4.brakeFront.latest.value, r4.brakeRear.latest.value], [6, 5]);
  const tl = plain(gas.buildWear_(vehicle(V.telluride), D, TODAY));
  assert.deepEqual([tl.tread.note, tl.brakeFront.note, tl.brakeRear.note],
    ['Not wearing measurably yet', 'Not wearing measurably yet', 'Not wearing measurably yet']);
  assert.deepEqual(plain(gas.buildWear_(vehicle(V.x7), D, TODAY)), { tread: null, brakeFront: null, brakeRear: null });
});

test('wear edge cases: rising line, same mileage, unplaceable items, projected date without an estimate', () => {
  const r = (visitId, date, mileage, item, value) => ({ vehicle: 'Test Car', visitId, date, mileage, item, value, rating: null });
  // Mileage going backwards makes a falling series fit a rising line.
  const rising = data({ readings: [r('a', '2026-01-01', 20000, 'Tread — Left Front', 8), r('b', '2026-02-01', 10000, 'Tread — Left Front', 7)] });
  assert.equal(plain(gas.buildWear_(car({ estMileage: 30000, avgMilesPerDay: 30 }), rising, TODAY)).tread.note,
    'Not wearing measurably yet');
  // Two readings at the same mileage are one point.
  const same = data({ readings: [r('a', '2026-01-01', 1000, 'Tread — Left Front', 8), r('b', '2026-01-02', 1000, 'Tread — Right Rear', 7)] });
  assert.equal(plain(gas.buildWear_(car(), same, TODAY)).tread.note, 'One reading so far');
  // A brake item without Front/Rear, tire pressure, battery and blank values are ignored.
  const ignored = data({ readings: [
    r('a', '2026-01-01', 1000, 'Brake Pad', 5), r('a', '2026-01-01', 1000, 'Tire Pressure — Left Front', 35),
    r('a', '2026-01-01', 1000, 'Battery — Cold Cranking Amps (actual; factory spec 600)', 610),
    r('a', '2026-01-01', 1000, 'Tread — Left Front', null),
  ] });
  assert.deepEqual(plain(gas.buildWear_(car(), ignored, TODAY)), { tread: null, brakeFront: null, brakeRear: null });
  // No estimate: the date runs from the latest reading (10 → 8 over 10,000 mi; 4 at 40,000 mi,
  // 20,000 mi after the latest reading ÷ 40 mi/day = 500 days after 2026-06-01).
  const falling = data({ readings: [r('a', '2025-06-01', 10000, 'Tread — Left Front', 10), r('b', '2026-06-01', 20000, 'Tread — Left Front', 8)] });
  assert.deepEqual(plain(gas.buildWear_(car({ avgMilesPerDay: 40 }), falling, TODAY)).tread.projection,
    { mileage: 40000, date: '2027-10-14' });
  assert.deepEqual(plain(gas.buildWear_(car(), falling, TODAY)).tread.projection, { mileage: 40000, date: null });
  assert.deepEqual(plain(gas.wearItemOf_('Brake Pads — Left Rear')), { kind: 'brake', axle: 'rear' });
  assert.equal(gas.wearItemOf_('Treadwear warranty'), null);
});

// ---------------------------------------------------------------- recalls

test('buildRecalls_: all of the vehicle\'s recalls, newest Report Date first', () => {
  assert.deepEqual(plain(gas.buildRecalls_(vehicle(V.telluride), D)).map(r => [r.campaignNumber, r.status, r.parkOutside]),
    [['26V904000', 'New', true], ['26V905000', 'Not applicable', false]]);
  assert.deepEqual(plain(gas.buildRecalls_(vehicle(V.wrangler), D))[0], {
    campaignNumber: '26V901000', reportDate: '2026-08-20', component: 'AIR BAGS:FRONTAL',
    summary: 'Sample recall summary.', consequence: 'Sample consequence.', remedy: 'Dealers will replace the part.',
    status: 'New', firstSeen: '2026-08-21', notes: null, parkIt: true, parkOutside: false,
  });
  assert.deepEqual(plain(gas.buildRecalls_(vehicle(V.fourRunner), D)), []);
  const undated = data({ recalls: [
    { vehicle: 'Test Car', campaignNumber: 'B', reportDate: null, firstSeen: null },
    { vehicle: 'Test Car', campaignNumber: 'A', reportDate: '2020-01-01', firstSeen: null },
  ] });
  assert.deepEqual(plain(gas.buildRecalls_(car(), undated)).map(r => r.campaignNumber), ['A', 'B']);
});

// ---------------------------------------------------------------- vehicle view

test('buildVehicleView_: the vehicle-wide Vehicle, per-user fields left for the overlay', () => {
  const v = plain(gas.buildVehicleView_(vehicle(V.x7), D, TODAY));
  assert.deepEqual(Object.keys(v), ['name', 'shortName', 'year', 'make', 'model', 'vin', 'plate', 'primaryDriver',
    'isMine', 'photoFileId', 'originalInServiceDate', 'purchaseDate', 'purchaseMileage', 'estMileage',
    'avgMilesPerDay', 'latestOdometer', 'latestOdometerDate', 'lastMileageEvidenceDate', 'basics', 'registration',
    'oemApp', 'upcoming', 'noHistory', 'coverage', 'visits', 'costs', 'wear', 'recalls', 'attention']);
  assert.deepEqual([v.isMine, v.attention, v.shortName, v.estMileage, v.avgMilesPerDay], [false, [], 'X7', 48388, 42.2]);
  assert.deepEqual([v.latestOdometer, v.latestOdometerDate, v.lastMileageEvidenceDate], [39020, '2026-02-12', '2026-02-12']);
  assert.deepEqual(v.oemApp, { name: 'My BMW', link: 'mybmw://', storeLink: 'https://apps.apple.com/app/id0000000003' });
  assert.deepEqual(v.registration, { expires: null, fileId: null, daysLeft: null });
  assert.deepEqual(v.basics, { oilSpec: '0W-20', oilCapacity: null, oilFilter: null, engineAirFilter: null,
    cabinAirFilter: null, tireSize: '275/45R21 front, 315/40R21 rear', tirePressure: null, wiperFrontDriver: null,
    wiperFrontPassenger: null, wiperRear: null, batteryGroup: null });

  const jp = plain(gas.buildVehicleView_(vehicle(V.wrangler), D, TODAY));
  assert.deepEqual(jp.registration, { expires: '2026-10-15', fileId: 'fake-reg-jp', daysLeft: 23 });
  assert.equal(jp.plate, null);
  // OEM app needs both a name and a link.
  assert.equal(plain(gas.buildVehicleView_(vehicle(V.telluride), D, TODAY)).oemApp, null);
  assert.deepEqual(plain(gas.buildVehicleView_(vehicle(V.fourRunner), D, TODAY)).oemApp,
    { name: 'Toyota', link: 'toyota://', storeLink: null });
  // Before setup: Latest Odometer falls back to Last Known Mileage / Last Visit Date.
  const pre = gas.dataFromTabs_(fx.preSetupTabs());
  const preR4 = plain(gas.buildVehicleView_(pre.vehicles.filter(x => x.name === V.fourRunner)[0], pre, TODAY));
  assert.deepEqual([preR4.latestOdometer, preR4.latestOdometerDate, preR4.lastMileageEvidenceDate],
    [36690, '2026-09-03', '2026-09-03']);
  assert.equal(preR4.registration.daysLeft, null);
});

// ---------------------------------------------------------------- scans

test('scanView_: label and detail for every status', () => {
  const view = id => plain(gas.scanView_(D.appScans.filter(s => s.scanId === id)[0], D, 'Robert'));
  assert.deepEqual(view('scan-0002'), {
    scanId: 'scan-0002', kind: 'Receipt', vehicleHint: V.fourRunner, fileId: 'fake-doc-4r-0903-inv',
    fileName: 'App scan - 2023 Toyota 4Runner - 2026-09-04 0810 - Leo.pdf', pages: 3,
    uploadedAt: '2026-09-04T08:10:00-05:00', status: 'Filed', statusLabel: 'Filed on the 4Runner',
    statusDetail: "It's in the 4Runner's service journal.", visitId: '4r-20260903-L1102',
    filedVehicle: V.fourRunner, lastChecked: '2026-09-04T12:00:00-05:00',
  });
  const pick = id => { const s = view(id); return [s.status, s.statusLabel, s.statusDetail]; };
  assert.deepEqual(pick('scan-0001'), ['Waiting', 'Waiting to be filed',
    "It's in the pile. Receipts are usually filed within a few hours."]);
  assert.deepEqual(pick('scan-0003'), ['Needs attention', 'Needs attention',
    "Robert's been notified. You may be asked to rescan."]);
  assert.deepEqual(pick('scan-0004'), ['Adding to journal', 'Filed, adding to journal',
    "It's been filed and will show in the journal soon."]);
  assert.deepEqual(pick('scan-0005'), ['Check with owner', 'Check with Robert', 'The file is no longer in Drive.']);
  assert.deepEqual(pick('scan-0009'), ['Check with owner', 'Check with Robert',
    "We couldn't tell where this scan went. Robert can look into it."]);
  assert.equal(view('scan-0004').kind, 'Owner entry');
  assert.equal(view('scan-0003').kind, 'Upload');
});

test('scanView_: filed vehicle from the visit or the Documents file ID; fallbacks', () => {
  const row = o => Object.assign({ scanId: 's', kind: 'Receipt', vehicleHint: V.x7, fileId: null, fileName: null,
    pages: null, uploadedBy: 'x', uploadedAt: null, status: 'Filed', statusDetail: null, visitId: null, lastChecked: null }, o);
  const s1 = plain(gas.scanView_(row({ fileId: 'fake-doc-hl-1202-inv' }), D, 'Robert'));
  assert.deepEqual([s1.filedVehicle, s1.statusLabel], [V.highlander, 'Filed on the Highlander']);
  const s2 = plain(gas.scanView_(row({ status: 'Adding to journal', visitId: 'x7-20250710-B9001' }), D, 'Robert'));
  assert.deepEqual([s2.filedVehicle, s2.statusDetail], [V.x7, "It's in the X7's folder and will show in the journal soon."]);
  const s3 = plain(gas.scanView_(row({}), D, null));
  assert.deepEqual([s3.filedVehicle, s3.statusLabel, s3.statusDetail], [null, 'Filed', "It's in the service journal."]);
  const s4 = plain(gas.scanView_(row({ status: 'needs ATTENTION', kind: 'Mystery' }), D, null));
  assert.deepEqual([s4.status, s4.kind, s4.statusDetail], ['Needs attention', 'Receipt',
    "The owner's been notified. You may be asked to rescan."]);
  const s5 = plain(gas.scanView_(row({ status: 'Check with owner' }), D));
  assert.equal(s5.statusLabel, 'Check with the owner');
  assert.equal(plain(gas.scanView_(row({ status: '' }), D, 'Robert')).status, 'Waiting');
});

// ---------------------------------------------------------------- attention

test('buildAttention_: rescans, new recalls, registration, then the nudge (primary driver only)', () => {
  const views = {};
  D.vehicles.forEach(v => { views[v.name] = plain(gas.buildVehicleView_(v, D, TODAY)); });
  const bob = { email: 'robert@example.com', name: 'Robert', driverName: 'Bob' };
  const maya = { email: 'maya@example.com', name: 'Maya', driverName: 'Maya' };
  const scans = D.appScans.map(s => plain(gas.scanView_(s, D, 'Robert')));
  const mine = email => scans.filter((s, i) => D.appScans[i].uploadedBy === email);
  const att = (v, user, email) => plain(gas.buildAttention_(views[v], user, mine(email), TODAY));

  assert.deepEqual(att(V.wrangler, bob, bob.email), [
    { kind: 'rescan', text: 'A receipt you scanned on Sep 19 needs another look', href: '#/scans/scan-0006' },
    { kind: 'recall', text: 'New recall may apply to the Wrangler', href: '#/v/2016%20Jeep%20Wrangler/recalls' },
    { kind: 'registration', text: 'Registration expires Oct 15', href: '#/v/2016%20Jeep%20Wrangler/registration' },
  ]);
  assert.deepEqual(att(V.x7, bob, bob.email), [
    { kind: 'odometer', text: "What's the odometer on the X7?", href: '#/v/2023%20BMW%20X7/odometer' },
  ]);
  // Maya's Highlander. Every Needs-attention scan passed in counts (overlayUser_ applies the 30-day window).
  assert.deepEqual(att(V.highlander, maya, 'maya@example.com').map(a => a.text), [
    'A receipt you scanned on Sep 18 needs another look',
    'A receipt you scanned on Aug 1 needs another look',
    'Registration expired Sep 1',
    "What's the odometer on the Highlander?",
  ]);
  // Bob sees the Highlander's registration but no nudge: he isn't its primary driver.
  assert.deepEqual(att(V.highlander, bob, bob.email).map(a => a.kind), ['registration']);
  // The 4Runner's last reading was 7 days ago: no nudge for Leo.
  assert.deepEqual(att(V.fourRunner, { name: 'Leo', driverName: 'Leo' }, 'leo@example.com'), []);
});

test('buildAttention_: recall count, registration wording and window, scan matching by filed vehicle', () => {
  const base = plain(gas.buildVehicleView_(vehicle(V.telluride), D, TODAY));
  const user = { name: 'Someone', driverName: 'Someone' };
  const v = o => Object.assign({}, base, o);
  const texts = (view, scans) => plain(gas.buildAttention_(view, user, scans || [], TODAY)).map(a => a.text);
  const twoNew = v({ recalls: [{ status: 'New' }, { status: 'new' }, { status: 'Reviewed' }] });
  assert.deepEqual(texts(twoNew), ['2 new recalls may apply to the Telluride']);
  const reg = (expires, daysLeft) => texts(v({ recalls: [], registration: { expires, fileId: null, daysLeft } }));
  assert.deepEqual(reg('2026-11-21', 60), ['Registration expires Nov 21']);
  assert.deepEqual(reg('2026-11-22', 61), []);
  assert.deepEqual(reg(TODAY, 0), ['Registration expires today']);
  assert.deepEqual(reg('2026-09-01', -21), ['Registration expired Sep 1']);
  const filedHere = { scanId: 'z', status: 'Needs attention', vehicleHint: V.x7, filedVehicle: V.telluride, uploadedAt: null };
  const other = { scanId: 'y', status: 'Needs attention', vehicleHint: V.x7, filedVehicle: null, uploadedAt: null };
  const waiting = { scanId: 'w', status: 'Waiting', vehicleHint: V.telluride, filedVehicle: null, uploadedAt: null };
  assert.deepEqual(texts(v({ recalls: [] }), [filedHere, other, waiting]), ['A receipt you scanned needs another look']);
});

test('regression: OEM app links that would run script on the phone are dropped', () => {
  const ok = ['mybmw://', 'toyota://open', 'https://apps.apple.com/app/id0000000003', 'myhyundai:home'];
  ok.forEach(l => assert.equal(gas.safeAppLink_(l, false), l, l));
  const bad = ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', 'file:///etc/passwd',
    'blob:https://x/y', 'about:blank', 'no-scheme', '', null, 'mybmw:// with space'];
  bad.forEach(l => assert.equal(gas.safeAppLink_(l, false), null, String(l)));
  assert.equal(gas.safeAppLink_('https://apps.apple.com/app/id1', true), 'https://apps.apple.com/app/id1');
  assert.equal(gas.safeAppLink_('itms-apps://apps.apple.com/app/id1', true), null, 'store link: https only');

  const x7 = Object.assign({}, vehicle(V.x7), { oemAppLink: 'javascript:alert(document.cookie)' });
  assert.equal(plain(gas.buildVehicleView_(x7, D, TODAY)).oemApp, null, 'no button for a bad link');
  const x7b = Object.assign({}, vehicle(V.x7), { oemAppStoreLink: 'javascript:alert(1)' });
  assert.deepEqual(plain(gas.buildVehicleView_(x7b, D, TODAY)).oemApp, { name: 'My BMW', link: 'mybmw://', storeLink: null });
});
