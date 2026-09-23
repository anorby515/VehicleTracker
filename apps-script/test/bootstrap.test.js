'use strict';
process.env.TZ = 'America/Chicago'; // the fixture's dates are local noon in Chicago

/**
 * Bootstrap.js: the shared part, the per-user overlay, the CacheService
 * layer, and a contract check of every user's Bootstrap against
 * web/src/api/types.ts.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { load } = require('./harness');
const { makeFakes, CACHE_MAX_VALUE_BYTES } = require('./fakes');
const fx = require('./fixtures/sheet');
const { buildMocks } = require('./make-fixture');

const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js'];
const plain = x => JSON.parse(JSON.stringify(x));
const TODAY = fx.TODAY;
const V = fx.vehicleNames;
const U = fx.users;
const NOW = new Date(TODAY + 'T09:30:00-05:00');
const NOW_ISO = '2026-09-22T09:30:00-05:00';

const gas = load({ files: FILES });
const D = gas.dataFromTabs_(fx.tabs);
const shared = gas.buildSharedBootstrap_(D, TODAY, NOW_ISO);
const appUser = email => gas.findAppUser_(D.appUsers, email);
const overlay = (email, opts) => plain(gas.overlayUser_(shared, D, appUser(email),
  Object.assign({ today: TODAY, ownerEmail: U.owner }, opts || {})));

/** A fresh API with fakes over a copy of the fixture. */
function api(opts) {
  opts = opts || {};
  const fakes = makeFakes({
    tabs: opts.tabs || fx.cloneTabs(),
    props: Object.assign({ OWNER_EMAIL: U.owner }, opts.props || {}),
    effectiveUser: opts.effectiveUser,
    now: NOW.getTime(),
  });
  return { fakes, gas: load({ files: FILES, globals: fakes.globals }) };
}

// ---------------------------------------------------------------- contract check against types.ts

/** Interfaces and type aliases from types.ts: {interfaces: {Name: {field: {optional, type}}}, aliases: {Name: body}}. */
function parseTypes() {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'web', 'src', 'api', 'types.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
  const aliases = {};
  src.replace(/export type (\w+)\s*=\s*([^;]+);/g, (_, name, body) => { aliases[name] = body.replace(/\s+/g, ' ').trim(); });
  const interfaces = {};
  const re = /export interface (\w+)[^{\n]*\{\n([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(src))) {
    const fields = {};
    m[2].split('\n').forEach(line => {
      const f = /^ {2}(\w+)(\?)?:\s*(.+?);?\s*$/.exec(line);
      if (f) fields[f[1]] = { optional: !!f[2], type: f[3].trim() };
    });
    interfaces[m[1]] = fields;
  }
  return { interfaces, aliases };
}

/** Splits on `sep` outside braces, brackets and angle brackets. */
function splitTop(s, sep) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of s) {
    if ('{[<('.includes(ch)) depth++;
    if ('}]>)'.includes(ch)) depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function checkFields(where, obj, fields, types) {
  assert.ok(obj && typeof obj === 'object' && !Array.isArray(obj), where + ' should be an object');
  Object.keys(obj).forEach(k => assert.ok(k in fields, where + ' has a field the contract lacks: ' + k));
  Object.keys(fields).forEach(k => {
    if (!(k in obj)) {
      assert.ok(fields[k].optional, where + ' is missing ' + k);
      return;
    }
    checkValue(where + '.' + k, obj[k], fields[k].type, types);
  });
}

function checkValue(where, value, type, types) {
  assert.notEqual(value, undefined, where + ' is undefined');
  const alts = splitTop(type, '|');
  if (value === null) {
    assert.ok(alts.includes('null') || alts.some(a => types.aliases[a] && /\bnull\b/.test(types.aliases[a])),
      where + ' is null but the type is ' + type);
    return;
  }
  const errors = [];
  for (const alt of alts.filter(a => a !== 'null')) {
    try { checkAlt(where, value, alt, types); return; } catch (e) { errors.push(e.message); }
  }
  assert.fail(where + ' = ' + JSON.stringify(value).slice(0, 80) + ' does not match ' + type + ': ' + errors.join(' / '));
}

function checkAlt(where, value, alt, types) {
  if (alt.endsWith('[]')) {
    assert.ok(Array.isArray(value), where + ' should be an array');
    value.forEach((v, i) => checkValue(where + '[' + i + ']', v, alt.slice(0, -2), types));
    return;
  }
  if (/^'.*'$/.test(alt)) return assert.equal(value, alt.slice(1, -1), where);
  if (/^\d+$/.test(alt) || alt === 'true' || alt === 'false') return assert.equal(String(value), alt, where);
  if (alt === 'string') return assert.ok(typeof value === 'string' && value !== '', where + ' should be a non-empty string');
  if (alt === 'number') return assert.ok(typeof value === 'number' && isFinite(value), where + ' should be a number');
  if (alt === 'boolean') return assert.equal(typeof value, 'boolean', where);
  if (alt === 'YMD') return assert.match(value, /^\d{4}-\d{2}-\d{2}$/, where);
  if (alt === 'ISODateTime') return assert.match(value, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/, where);
  if (alt.startsWith('{')) {
    const fields = {};
    splitTop(alt.slice(1, -1), ';').forEach(f => {
      const m = /^(\w+)(\?)?:\s*(.+)$/.exec(f);
      fields[m[1]] = { optional: !!m[2], type: m[3].trim() };
    });
    return checkFields(where, value, fields, types);
  }
  if (alt === 'Partial<Record<NotificationEvent, boolean>>') {
    const events = splitTop(types.aliases.NotificationEvent, '|').map(s => s.slice(1, -1));
    Object.keys(value).forEach(k => {
      assert.ok(events.includes(k), where + ' has an unknown event ' + k);
      assert.equal(typeof value[k], 'boolean', where + '.' + k);
    });
    return;
  }
  if (types.interfaces[alt]) return checkFields(where, value, types.interfaces[alt], types);
  if (types.aliases[alt]) return checkValue(where, value, types.aliases[alt], types);
  throw new Error('unknown type ' + alt);
}

test('every user\'s Bootstrap matches web/src/api/types.ts exactly', () => {
  const types = parseTypes();
  // Sanity: the parser found the interfaces this check leans on.
  ['Bootstrap', 'User', 'Vehicle', 'UpcomingItem', 'ScheduleDetail', 'CoveragePlan', 'Visit', 'DocumentRef', 'Costs',
    'WearItem', 'Recall', 'AttentionItem', 'Scan'].forEach(n => assert.ok(types.interfaces[n], n));
  assert.ok(Object.keys(types.interfaces.Vehicle).length >= 29);
  const { gas: g } = api();
  fx.tabs['App Users'].slice(1).forEach(row => {
    const b = plain(g.getBootstrap_(row[0], NOW));
    checkFields('Bootstrap(' + row[1] + ')', b, types.interfaces.Bootstrap, types);
  });
});

test('the contract checker catches wrong shapes', () => {
  const types = parseTypes();
  const good = overlay(U.fourRunnerDriver);
  const broken = [
    b => { b.vehicles[0].upcoming[0].status = 'Soon'; },
    b => { b.vehicles[0].visits[0].date = '9/22/2026'; },
    b => { b.vehicles[0].extra = 1; },
    b => { delete b.vehicles[0].costs.byYear; },
    b => { b.myScans[0].uploadedAt = '2026-09-21 18:05'; },
    b => { b.user.prefs = { serviceDue: 'yes' }; },
    b => { b.vehicles[0].plate = ''; },
  ];
  broken.forEach((breakIt, i) => {
    const b = JSON.parse(JSON.stringify(good));
    breakIt(b);
    assert.throws(() => checkFields('Bootstrap', b, types.interfaces.Bootstrap, types), undefined, 'case ' + i);
  });
});

// ---------------------------------------------------------------- shared part

test('buildSharedBootstrap_: active vehicles in tab order, service types in tab order, no per-user fields', () => {
  const s = plain(shared);
  assert.deepEqual(Object.keys(s), ['schemaVersion', 'generatedAt', 'today', 'vehicles', 'serviceTypes']);
  assert.deepEqual([s.schemaVersion, s.generatedAt, s.today], [1, NOW_ISO, TODAY]);
  assert.deepEqual(s.vehicles.map(v => v.name), [V.highlander, V.wrangler, V.x7, V.fourRunner, V.telluride]);
  assert.equal(s.serviceTypes.length, 21);
  assert.deepEqual(s.serviceTypes.slice(0, 3), ['Oil Change', 'Tire Rotation', 'Cabin Air Filter']);
  assert.ok(s.serviceTypes.includes('Other') && s.serviceTypes.includes('Unknown'));
  s.vehicles.forEach(v => assert.deepEqual([v.isMine, v.attention], [false, []]));

  const tabs = fx.cloneTabs();
  tabs['Vehicles'][2][tabs['Vehicles'][0].indexOf('Active')] = 'No'; // the Jeep
  const d2 = gas.dataFromTabs_(tabs);
  assert.deepEqual(plain(gas.buildSharedBootstrap_(d2, TODAY, NOW_ISO).vehicles.map(v => v.name)),
    [V.highlander, V.x7, V.fourRunner, V.telluride]);
});

// ---------------------------------------------------------------- overlay

test('overlayUser_: the owner (Driver Name "Bob")', () => {
  const b = overlay(U.owner);
  assert.deepEqual(Object.keys(b), ['schemaVersion', 'generatedAt', 'today', 'user', 'vehicles', 'serviceTypes',
    'myScans', 'ownerName']);
  assert.deepEqual(b.user, { email: 'robert@example.com', name: 'Robert', driverName: 'Bob', defaultVehicle: V.x7,
    prefs: { scanFiled: false, odometerNudge: true }, isOwner: true });
  assert.equal(b.ownerName, 'Robert');
  assert.deepEqual(b.vehicles.map(v => [v.shortName, v.isMine]),
    [['Highlander', false], ['Wrangler', true], ['X7', true], ['4Runner', false], ['Telluride', false]]);
  assert.deepEqual(b.vehicles.map(v => v.attention.map(a => a.kind)), [
    ['registration'],                        // Highlander registration expired (everyone sees it)
    ['rescan', 'recall', 'registration'],    // his Jeep scan, a new recall, registration in 23 days
    ['odometer'],                            // X7: no mileage since 2026-02-12, and he drives it
    [],
    ['recall'],
  ]);
  assert.deepEqual(b.myScans.map(s => [s.scanId, s.statusLabel]),
    [['scan-0006', 'Needs attention'], ['scan-0005', 'Check with Robert']]);
});

test('overlayUser_: other drivers, isMine via Name when Driver Name is blank, 30-day My scans', () => {
  const leo = overlay(U.fourRunnerDriver);
  assert.deepEqual(leo.user, { email: 'leo@example.com', name: 'Leo', driverName: 'Leo', defaultVehicle: V.fourRunner,
    prefs: {}, isOwner: false });
  assert.deepEqual(leo.vehicles.filter(v => v.isMine).map(v => v.name), [V.fourRunner]);
  // Newest first; scan-0009 is exactly 30 days old and still listed.
  assert.deepEqual(leo.myScans.map(s => [s.scanId, s.status, s.statusLabel]), [
    ['scan-0001', 'Waiting', 'Waiting to be filed'],
    ['scan-0002', 'Filed', 'Filed on the 4Runner'],
    ['scan-0009', 'Check with owner', 'Check with Robert'],
  ]);
  assert.deepEqual(leo.vehicles.map(v => v.attention.length), [1, 2, 0, 0, 1]);

  const maya = overlay('MAYA@example.com');
  assert.equal(maya.user.email, 'maya@example.com');
  // scan-0007 (33 days) and scan-0008 (52 days) are too old for My scans and the banner.
  assert.deepEqual(maya.myScans.map(s => s.scanId), ['scan-0003']);
  assert.deepEqual(maya.vehicles[0].attention, [
    { kind: 'rescan', text: 'A receipt you scanned on Sep 18 needs another look', href: '#/scans/scan-0003' },
    { kind: 'registration', text: 'Registration expired Sep 1', href: '#/v/2014%20Toyota%20Highlander/registration' },
    { kind: 'odometer', text: "What's the odometer on the Highlander?", href: '#/v/2014%20Toyota%20Highlander/odometer' },
  ]);

  const nina = overlay(U.tellurideDriver);
  assert.deepEqual([nina.user.prefs, nina.vehicles[4].isMine], [{ newRecall: true }, true]);
  assert.deepEqual(nina.myScans.map(s => [s.scanId, s.statusLabel, s.statusDetail]), [
    ['scan-0004', 'Filed, adding to journal', "It's been filed and will show in the journal soon."],
  ]);
  // Her last mileage evidence is 48 days old: no nudge.
  assert.deepEqual(nina.vehicles[4].attention.map(a => a.kind), ['recall']);
});

test('overlayUser_ never changes the shared part, so it can serve every user', () => {
  const before = JSON.stringify(shared);
  overlay(U.owner);
  overlay(U.highlanderDriver);
  assert.equal(JSON.stringify(shared), before);
});

test('overlayUser_: owner name falls back to "the owner" when the owner has no App Users row', () => {
  const b = overlay(U.fourRunnerDriver, { ownerEmail: 'nobody@example.com' });
  assert.equal(b.ownerName, 'the owner');
  assert.equal(b.myScans[2].statusLabel, 'Check with the owner');
  assert.equal(b.user.isOwner, false);
});

test('myScans_: Uploaded By may hold the Name; a blank Uploaded At is kept, last', () => {
  const d2 = Object.assign(gas.dataFromTabs_({}), {
    appScans: [
      { _row: 2, scanId: 'a', uploadedBy: 'leo', uploadedAt: '2026-09-20T10:00:00-05:00', status: 'Waiting' },
      { _row: 3, scanId: 'b', uploadedBy: 'leo@example.com', uploadedAt: null, status: 'Waiting' },
      { _row: 4, scanId: 'c', uploadedBy: 'leo@example.com', uploadedAt: '2026-09-21T01:00:00-05:00', status: 'Waiting' },
      { _row: 5, scanId: 'd', uploadedBy: 'someone@example.com', uploadedAt: '2026-09-21T01:00:00-05:00', status: 'Waiting' },
      { _row: 6, scanId: 'e', uploadedBy: null, uploadedAt: '2026-09-21T01:00:00-05:00', status: 'Waiting' },
    ],
  });
  const user = { email: 'leo@example.com', name: 'Leo' };
  assert.deepEqual(plain(gas.myScans_(d2, user, TODAY, 'Robert').map(s => s.scanId)), ['c', 'a', 'b']);
});

// ---------------------------------------------------------------- users

test('findAppUser_ is case-insensitive and needs Active = Yes; findAppUserAny_ ignores Active', () => {
  const users = gas.normAppUsers_(gas.tabFromValues_('App Users', [
    ['Email', 'Name', 'Active'],
    ['Pat@Example.com', 'Pat', 'Yes'],
    ['gone@example.com', 'Gone', 'No'],
    ['twice@example.com', 'Old row', 'No'],
    ['twice@example.com', 'New row', 'Yes'],
  ]));
  assert.equal(gas.findAppUser_(users, 'PAT@example.COM').name, 'Pat');
  assert.equal(gas.findAppUser_(users, 'gone@example.com'), null);
  assert.equal(gas.findAppUserAny_(users, 'gone@example.com').name, 'Gone');
  assert.equal(gas.findAppUser_(users, 'twice@example.com').name, 'New row');
  assert.equal(gas.findAppUserAny_(users, 'twice@example.com').name, 'New row');
  assert.equal(gas.findAppUser_(users, 'stranger@example.com'), null);
  assert.equal(gas.findAppUser_(users, ''), null);
  assert.equal(gas.findAppUser_(null, 'pat@example.com'), null);
});

test('userView_: Driver Name falls back to Name, Name to the email; isOwner ignores case', () => {
  assert.deepEqual(plain(gas.userView_({ email: 'sam@example.com', name: null, driverName: null, defaultVehicle: null,
    prefs: {} }, 'SAM@example.com')), { email: 'sam@example.com', name: 'sam', driverName: 'sam', defaultVehicle: null,
    prefs: {}, isOwner: true });
  assert.equal(gas.userView_(appUser(U.owner), null).isOwner, false);
});

test('ownerEmail_: Script Property OWNER_EMAIL, else the account the script runs as (lower-cased)', () => {
  assert.equal(api({ props: { OWNER_EMAIL: 'Robert@Example.com' } }).gas.ownerEmail_(), 'robert@example.com');
  const noProp = api({ props: { OWNER_EMAIL: '' }, effectiveUser: 'Deployer@Example.com' });
  assert.equal(noProp.gas.ownerEmail_(), 'deployer@example.com');
  assert.equal(noProp.gas.ownerName_(D), 'the owner');
  assert.equal(api().gas.ownerName_(D), 'Robert');
  assert.equal(gas.ownerName_(D, 'leo@example.com'), 'Leo');
});

// ---------------------------------------------------------------- getBootstrap_ and the cache

test('getBootstrap_: builds from the Sheet, caches the shared part, and matches the pure pieces', () => {
  const { fakes, gas: g } = api();
  const b = plain(g.getBootstrap_('Leo@Example.com', NOW));
  assert.deepEqual(b, overlay(U.fourRunnerDriver));
  const meta = JSON.parse(fakes.scriptCache.get('bootstrap:v1:' + g.APP_VERSION));
  assert.ok(meta.n >= 1 && typeof meta.id === 'string');
  assert.equal(g.bootstrapCacheKey_(), 'bootstrap:v1:' + g.APP_VERSION);
  assert.equal(g.getBootstrap_('stranger@example.com', NOW), null);
  assert.ok(JSON.stringify(b).length < 1024 * 1024, 'well under 1 MB');
});

test('getBootstrap_: a warm cache reads only App Users and App Scans; per-user parts stay fresh', () => {
  const { fakes, gas: g } = api();
  g.getBootstrap_(U.owner, NOW); // warm the cache
  const reads = [];
  const orig = fakes.spreadsheet.getSheetByName.bind(fakes.spreadsheet);
  fakes.spreadsheet.getSheetByName = name => { reads.push(name); return orig(name); };

  // A journal change doesn't show until the cache is invalidated or expires...
  const vehicles = fakes.spreadsheet.getSheetByName('Vehicles');
  vehicles.getRange(5, fx.tabs['Vehicles'][0].indexOf('Est. Current Mileage') + 1).setValue(38000);
  // ...but a new scan and a deactivated user do.
  fakes.spreadsheet.getSheetByName('App Scans').appendRow(['scan-0010', 'Receipt', V.x7, 'fake-doc-4r-0824-inv',
    'App scan.pdf', 1, 'leo@example.com', fx.dt('2026-09-22', '08:00'), 'Filed', '', '', '']);
  reads.length = 0;
  const b = plain(g.getBootstrap_(U.fourRunnerDriver, NOW));
  assert.deepEqual(reads.sort(), ['App Scans', 'App Users']);
  assert.equal(b.vehicles[3].estMileage, 37704);
  // The new scan's vehicle is found from the cached visits' documents (file ID), not the hint.
  assert.deepEqual([b.myScans[0].scanId, b.myScans[0].statusLabel, b.myScans[0].filedVehicle],
    ['scan-0010', 'Filed on the 4Runner', V.fourRunner]);
  assert.equal(b.ownerName, 'Robert');

  const users = fakes.spreadsheet.getSheetByName('App Users');
  users.getRange(3, 4).setValue('No'); // Leo
  assert.equal(g.getBootstrap_(U.fourRunnerDriver, NOW), null);
  users.getRange(3, 4).setValue('Yes');

  g.invalidateBootstrapCache_();
  assert.equal(plain(g.getBootstrap_(U.fourRunnerDriver, NOW)).vehicles[3].estMileage, 38000);
});

test('getBootstrap_: the cache expires after BOOTSTRAP_CACHE_SEC and is rebuilt on a new day', () => {
  const { fakes, gas: g } = api();
  const est = () => plain(g.getBootstrap_(U.owner, NOW)).vehicles[3].estMileage;
  assert.equal(est(), 37704);
  fakes.spreadsheet.getSheetByName('Vehicles').getRange(5, fx.tabs['Vehicles'][0].indexOf('Est. Current Mileage') + 1)
    .setValue(38000);
  fakes.clock.advance(g.RULES.BOOTSTRAP_CACHE_SEC - 1);
  assert.equal(est(), 37704);
  fakes.clock.advance(2);
  assert.equal(est(), 38000);

  // A cached part from yesterday is never served today (dates like daysLeft would be stale).
  const t = api();
  const yesterday = new Date('2026-09-21T23:58:00-05:00');
  assert.equal(plain(t.gas.getBootstrap_(U.owner, yesterday)).today, '2026-09-21');
  const b = plain(t.gas.getBootstrap_(U.owner, new Date('2026-09-22T00:01:00-05:00')));
  assert.deepEqual([b.today, b.generatedAt], ['2026-09-22', '2026-09-22T00:01:00-05:00']);
  assert.equal(b.vehicles[1].registration.daysLeft, 23);
});

test('getBootstrap_: a missing, corrupt or foreign cache entry just means a rebuild', () => {
  const { fakes, gas: g } = api();
  const expected = overlay(U.owner);
  const key = g.bootstrapCacheKey_();
  const chunkKeys = () => Array.from(fakes.scriptCache.entries.keys()).filter(k => k !== key);
  const damage = [
    () => fakes.scriptCache.remove(chunkKeys()[0]),                                   // chunk evicted
    () => fakes.scriptCache.put(chunkKeys()[0], 'not base64 gzip!', 300),              // corrupt chunk
    () => fakes.scriptCache.put(key, '{broken json', 300),                             // corrupt index
    () => fakes.scriptCache.put(key, JSON.stringify({ id: 'x', n: 1000 }), 300),       // absurd index
    () => fakes.scriptCache.put(key, JSON.stringify({ id: 'x', n: 1 }), 300),          // chunks of another write
  ];
  damage.forEach((hurt, i) => {
    g.getBootstrap_(U.owner, NOW);
    hurt();
    assert.equal(g.readBootstrapCache_(), null, 'case ' + i);
    assert.deepEqual(plain(g.getBootstrap_(U.owner, NOW)), expected, 'case ' + i);
    assert.ok(g.readBootstrapCache_(), 'rewritten, case ' + i);
  });
  // A payload with the wrong schema version is ignored too.
  g.writeBootstrapCache_({ schemaVersion: 99, vehicles: [] });
  assert.equal(g.readBootstrapCache_(), null);
});

test('cache round trip of a payload far over 100 KB, split into chunks under the limit', () => {
  const { fakes, gas: g } = api();
  // Random hex barely compresses: ~420 KB of JSON → ~250 KB gzipped → ~330 KB of base64.
  const big = { schemaVersion: 1, today: TODAY, vehicles: [], serviceTypes: [] };
  for (let i = 0; i < 70; i++) big.vehicles.push({ name: 'car ' + i, blob: crypto.randomBytes(3000).toString('hex') });
  assert.equal(g.writeBootstrapCache_(big), true);
  const values = Array.from(fakes.scriptCache.entries.values()).map(e => e.value);
  assert.ok(values.length >= 4, 'several chunks, got ' + values.length);
  values.forEach(v => assert.ok(Buffer.byteLength(v) <= CACHE_MAX_VALUE_BYTES));
  assert.deepEqual(plain(g.readBootstrapCache_()), big);
  // The fake enforces the real limit, so chunking is what makes this work.
  assert.throws(() => fakes.scriptCache.put('one-key', 'x'.repeat(CACHE_MAX_VALUE_BYTES + 1)), /too large/);
  // Unicode survives the gzip/base64 trip.
  const accents = { schemaVersion: 1, vehicles: [{ name: 'Café — “quoted” · 40,000 mi' }] };
  g.writeBootstrapCache_(accents);
  assert.deepEqual(plain(g.readBootstrapCache_()), accents);
});

test('getBootstrap_ still answers when the cache refuses writes', () => {
  const { fakes, gas: g } = api();
  fakes.scriptCache.putAll = () => { throw new Error('Service invoked too many times'); };
  const warn = console.warn;
  console.warn = () => {};
  try {
    assert.deepEqual(plain(g.getBootstrap_(U.owner, NOW)), overlay(U.owner));
  } finally {
    console.warn = warn;
  }
  assert.equal(g.readBootstrapCache_(), null);
});

// ---------------------------------------------------------------- mock data for the front end

test('make-fixture builds one Bootstrap per fictional user, named by first name', () => {
  const { index, files } = buildMocks();
  assert.deepEqual(index, { users: [
    { email: 'robert@example.com', name: 'Robert', file: 'bootstrap.robert.json' },
    { email: 'leo@example.com', name: 'Leo', file: 'bootstrap.leo.json' },
    { email: 'maya@example.com', name: 'Maya', file: 'bootstrap.maya.json' },
    { email: 'nina@example.com', name: 'Nina', file: 'bootstrap.nina.json' },
  ] });
  assert.deepEqual(files['bootstrap.leo.json'], overlay(U.fourRunnerDriver));
  assert.equal(files['bootstrap.robert.json'].generatedAt, NOW_ISO);
  // Nothing from the real journal: every email is example.com and every VIN a test VIN.
  const all = JSON.stringify(files);
  (all.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) || []).forEach(e => assert.match(e, /@example\.com$/));
  (all.match(/"vin":"[^"]*"/g) || []).forEach(v => assert.match(v, /TESTVIN/));
});

// ---------------------------------------------------------------- fakes

test('fakes behave like the real services where it matters', () => {
  const { fakes } = api({ tabs: { 'Log': [['Timestamp', 'Source'], ['a', 'b'], ['', ''], ['', '']] } });
  const sh = fakes.spreadsheet.getSheetByName('Log');
  assert.equal(sh.getLastRow(), 2);           // trailing blank rows don't count
  assert.equal(sh.getLastColumn(), 2);
  sh.appendRow(['c', 'd']);
  assert.deepEqual(sh.getRange(3, 1, 1, 2).getValues(), [['c', 'd']]);
  assert.throws(() => sh.getRange(1, 1, 2, 2).setValues([['x', 'y']]), /number of rows/);
  assert.throws(() => sh.getRange(1, 1, 1, 2).setValues([['x']]), /number of columns/);
  sh.getRange('D1').setValue('New header');
  assert.equal(sh.getLastColumn(), 4);
  assert.deepEqual(sh.getRange('A1:B1').getValues(), [['Timestamp', 'Source']]);
  sh.getRange('E2').setFormula('=A2');
  assert.equal(sh.getRange(2, 5).getFormula(), '=A2');
  sh.getRange('E2').setValue(5);
  assert.equal(sh.getRange(2, 5).getFormula(), '');
  sh.getRange(3, 1).setNumberFormat('yyyy-mm-dd');
  assert.equal(sh.getRange(3, 1).getNumberFormat(), 'yyyy-mm-dd');
  assert.throws(() => fakes.spreadsheet.insertSheet('Log'), /already exists/);
  assert.equal(fakes.spreadsheet.insertSheet('New').getLastRow(), 0);
  assert.throws(() => fakes.globals.SpreadsheetApp.openById('some-other-id'), /Unexpected spreadsheet/);

  const withFormulas = makeFakes({ tabs: fx.preSetupTabs(), formulas: fx.liveFormulas() });
  const veh = withFormulas.spreadsheet.getSheetByName('Vehicles');
  assert.match(veh.formulaAt('P5'), /^=IFERROR\(IF\(OR\(L5="",M5="",N5="",O5=""\),"",ROUND\(\(O5-M5\)\/\(N5-L5\),1\)\),""\)$/);
  assert.equal(veh.getRange('Q2').getFormula(), '=IFERROR(IF(OR(O2="",P2=""),O2,ROUND(O2+P2*(TODAY()-N2),0)),"")');
  assert.equal(withFormulas.spreadsheet.getSheetByName('Warranties').formulaAt('F2'), '=E2+12000');

  const cache = fakes.scriptCache;
  cache.put('k', 'v', 10);
  assert.deepEqual(cache.getAll(['k', 'missing']), { k: 'v' });
  fakes.clock.advance(10);
  assert.equal(cache.get('k'), null);
  assert.throws(() => cache.put('x'.repeat(251), 'v'), /key/);
});
