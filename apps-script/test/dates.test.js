'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');

const gas = load({ files: ['Config.js', 'Dates.js'] });

test('ymd day arithmetic round-trips', () => {
  assert.equal(gas.dayToYmd_(gas.ymdToDay_('2026-09-22')), '2026-09-22');
  assert.equal(gas.daysBetween_('2026-09-22', '2026-12-25'), 94);
  assert.equal(gas.addDays_('2026-12-31', 1), '2027-01-01');
  assert.equal(gas.ymdToDay_(''), null);
  assert.equal(gas.ymdToDay_('9/22/2026'), null);
});

test('addMonths_ behaves like EDATE, clamping month ends', () => {
  assert.equal(gas.addMonths_('2026-08-24', 12), '2027-08-24');
  assert.equal(gas.addMonths_('2026-01-31', 1), '2026-02-28');
  assert.equal(gas.addMonths_('2024-01-31', 1), '2024-02-29');
  assert.equal(gas.addMonths_('2026-11-15', 3), '2027-02-15');
});

test('compareYmd_ sorts nulls last', () => {
  const list = [null, '2027-01-18', '2026-09-13', null, '2026-12-29'];
  assert.deepEqual(list.sort(gas.compareYmd_), ['2026-09-13', '2026-12-29', '2027-01-18', null, null]);
});

test('Chicago formatting handles CST and CDT', () => {
  // 2026-12-25 05:30 UTC is Dec 24, 11:30 PM in Chicago (CST, UTC-6)
  assert.equal(gas.ymdFromDate_(new Date('2026-12-25T05:30:00Z')), '2026-12-24');
  // 2026-07-04 04:30 UTC is Jul 3, 11:30 PM (CDT, UTC-5)
  const p = gas.nowParts_(new Date('2026-07-04T04:30:00Z'));
  assert.equal(p.ymd, '2026-07-03');
  assert.equal(p.hour, 23);
  assert.equal(p.hhmm, '2330');
  assert.equal(p.iso, '2026-07-03T23:30:00-05:00');
  assert.equal(gas.isoFromDate_(new Date('2026-01-10T18:00:00Z')), '2026-01-10T12:00:00-06:00');
});
