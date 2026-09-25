'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

/**
 * Recalls.js (NHTSA lookup, silent first import) and the Jobs.js wiring.
 * NHTSA responses below are made-up campaigns in NHTSA's real shape.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const { load } = require('./harness');
const { makeFakes } = require('./fakes');
const { makeUrlFetchApp, workerHandler } = require('./fakes-jobs');
const { loadApi } = require('./fakes-services');
const fx = require('./fixtures/sheet');

const FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js', 'Api.js', 'Auth.js',
  'Scans.js', 'Notify.js', 'Recalls.js', 'Jobs.js'];
const V = fx.vehicleNames;
const U = fx.users;
const plain = x => JSON.parse(JSON.stringify(x));
const NOW = new Date('2026-09-22T12:30:00-05:00');   // 12:30 PM Central: not quiet hours

const pure = load({ files: FILES });

/** One NHTSA result object (fictional campaign). */
function nhtsa(campaign, overrides) {
  return Object.assign({
    Manufacturer: 'Sample Motors', NHTSACampaignNumber: campaign, parkIt: false, parkOutSide: false,
    overTheAirUpdate: false, ReportReceivedDate: '12/10/2023', Component: 'ELECTRICAL SYSTEM',
    Summary: 'Sample summary for ' + campaign + '.', Consequence: 'Sample consequence.',
    Remedy: 'Dealers will fix it, free of charge.', Notes: 'Owners may contact NHTSA.', ModelYear: '2023',
    Make: 'SAMPLE', Model: 'SAMPLE',
  }, overrides || {});
}

// ---------------------------------------------------------------- parsing (pure)

test('parseNhtsaDate_ reads DD/MM/YYYY explicitly', () => {
  assert.equal(pure.parseNhtsaDate_('12/10/2023'), '2023-10-12');
  assert.equal(pure.parseNhtsaDate_('30/10/2025'), '2025-10-30');
  assert.equal(pure.parseNhtsaDate_('1/2/2024'), '2024-02-01');
  assert.equal(pure.parseNhtsaDate_('29/02/2024'), '2024-02-29');
  assert.equal(pure.parseNhtsaDate_(' 05/01/2026 '), '2026-01-05');
  // US order would be a month 30: rejected, never guessed.
  assert.equal(pure.parseNhtsaDate_('10/30/2025'), null);
  assert.equal(pure.parseNhtsaDate_('31/02/2024'), null);
  assert.equal(pure.parseNhtsaDate_('29/02/2025'), null);
  assert.equal(pure.parseNhtsaDate_('00/01/2024'), null);
  // ISO (in case NHTSA ever switches) is accepted as is.
  assert.equal(pure.parseNhtsaDate_('2024-03-05'), '2024-03-05');
  assert.equal(pure.parseNhtsaDate_('2024-03-05T00:00:00Z'), '2024-03-05');
  assert.equal(pure.parseNhtsaDate_(''), null);
  assert.equal(pure.parseNhtsaDate_(null), null);
  assert.equal(pure.parseNhtsaDate_('Oct 12, 2023'), null);
});

test('nhtsaCampaign_ maps NHTSA fields (exact casing, optional flags)', () => {
  assert.deepEqual(plain(pure.nhtsaCampaign_(nhtsa('23V700000', { parkIt: true, parkOutSide: true, Notes: null }))), {
    campaignNumber: '23V700000', reportDate: '2023-10-12', component: 'ELECTRICAL SYSTEM',
    summary: 'Sample summary for 23V700000.', consequence: 'Sample consequence.',
    remedy: 'Dealers will fix it, free of charge.', notes: null, parkIt: true, parkOutside: true, modelYear: '2023',
  });
  const bare = plain(pure.nhtsaCampaign_({ NHTSACampaignNumber: ' 24V100000 ', ReportReceivedDate: '30/10/2025' }));
  assert.equal(bare.campaignNumber, '24V100000');
  assert.equal(bare.reportDate, '2025-10-30');
  assert.equal(bare.parkIt, false);
  assert.equal(bare.parkOutside, false);
  assert.equal(bare.summary, '');
  assert.equal(pure.nhtsaCampaign_({ Component: 'NO CAMPAIGN' }), null);
});

// ---------------------------------------------------------------- fetchRecalls_

function withFetch(handler) {
  const http = makeUrlFetchApp(handler);
  const gas = load({ files: FILES, globals: { UrlFetchApp: http } });
  return { gas, http };
}

test('fetchRecalls_: HTTP 200 with results', () => {
  const { gas, http } = withFetch(() => ({ code: 200, body: {
    Count: 3, Message: 'Results returned successfully',
    results: [nhtsa('23V700000'), nhtsa('24V100000', { ReportReceivedDate: '30/10/2025' }), nhtsa('23V700000')],
  } }));
  const list = plain(gas.fetchRecalls_('TOYOTA', '4RUNNER', 2023));
  assert.deepEqual(list.map(c => [c.campaignNumber, c.reportDate]), [['23V700000', '2023-10-12'], ['24V100000', '2025-10-30']]);
  assert.equal(http.requests.length, 1);
  assert.equal(http.requests[0].url, 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=TOYOTA&model=4RUNNER&modelYear=2023');
  assert.equal(http.requests[0].opts.muteHttpExceptions, true);
  // Names are URL-encoded.
  withFetch(url => {
    assert.equal(url, 'https://api.nhtsa.gov/recalls/recallsByVehicle?make=LAND%20ROVER&model=RANGE%20ROVER%20%26%20CO&modelYear=2020');
    return { code: 200, body: { Count: 0, results: [] } };
  }).gas.fetchRecalls_('LAND ROVER', 'RANGE ROVER & CO', 2020);
});

test('fetchRecalls_: HTTP 400 with NHTSA\'s empty body means no recalls', () => {
  const { gas } = withFetch(() => ({ code: 400, body: { Count: 0, Message: 'Results returned successfully', results: [] } }));
  assert.deepEqual(plain(gas.fetchRecalls_('BMW', 'X7', 2023)), []);
});

test('fetchRecalls_: anything else throws', () => {
  assert.throws(() => withFetch(() => ({ code: 500, body: 'Internal error' })).gas.fetchRecalls_('KIA', 'TELLURIDE', 2025),
    /HTTP 500/);
  assert.throws(() => withFetch(() => ({ code: 400, body: '' })).gas.fetchRecalls_('KIA', 'TELLURIDE', 2025), /HTTP 400/);
  assert.throws(() => withFetch(() => ({ code: 400, body: '<html>Bad request</html>' })).gas.fetchRecalls_('KIA', 'TELLURIDE', 2025),
    /HTTP 400/);
  assert.throws(() => withFetch(() => ({ code: 200, body: 'not json' })).gas.fetchRecalls_('KIA', 'TELLURIDE', 2025), /HTTP 200/);
  assert.throws(() => withFetch(() => ({ code: 429, body: { Count: 0, results: [] } })).gas.fetchRecalls_('KIA', 'TELLURIDE', 2025),
    /HTTP 429/);
});

// ---------------------------------------------------------------- runRecalls_ (writes) and notifications

/** NHTSA answers by model; WRANGLER is down. */
function nhtsaByModel(byModel) {
  return url => {
    const model = decodeURIComponent(/model=([^&]+)/.exec(url)[1]);
    const r = byModel[model];
    if (r === 'down') return { code: 503, body: 'Service Unavailable' };
    if (!r || !r.length) return { code: 400, body: { Count: 0, Message: 'Results returned successfully', results: [] } };
    return { code: 200, body: { Count: r.length, Message: 'Results returned successfully', results: r } };
  };
}

function setup(byModel, opts = {}) {
  const tabs = fx.cloneTabs();
  // Start from the fixture's recall history, but with nothing New, so only this test's recalls notify.
  const rh = tabs['Recalls'][0];
  tabs['Recalls'].slice(1).forEach(r => { r[rh.indexOf('Status')] = 'Reviewed'; });
  // Leo gets a working phone (the fixture's is inactive).
  tabs['Push Subscriptions'].push(['leo@example.com', 'https://web.push.apple.com/leo-new', '{"p256dh":"BLeoKey","auth":"leoAuth"}',
    'iPhone', fx.dt('2026-09-10', '10:00'), '', 'Yes']);
  if (opts.tabs) opts.tabs(tabs);
  const state = { byModel: byModel };
  const http = makeUrlFetchApp(workerHandler(null, (url, o, json) => nhtsaByModel(state.byModel)(url)));
  const fakes = makeFakes({
    tabs,
    props: { OWNER_EMAIL: U.owner, PUSH_WORKER_URL: 'https://push-worker.example.workers.dev', PUSH_WORKER_SECRET: 'test-secret' },
    now: NOW.getTime(),
    extraGlobals: { UrlFetchApp: http },
  });
  const gas = load({ files: FILES, globals: fakes.globals });
  const rows = name => plain(gas.readTab_(name).rows);
  return { gas, fakes, http, state, rows };
}

test('runRecalls_: first import per vehicle is silent; failures don\'t stop other vehicles', () => {
  const t = setup({
    HIGHLANDER: [nhtsa('26V100000', { parkIt: true }), nhtsa('26V100001')],    // no Recalls rows yet: first import
    '4RUNNER': [nhtsa('26V200000', { parkOutSide: true })],                    // first import
    X7: [nhtsa('25V903000'), nhtsa('26V300000', { ReportReceivedDate: '05/09/2026' })], // has history: 26V300000 is new
    WRANGLER: 'down',
    TELLURIDE: [],
  });
  const cacheKey = t.gas.bootstrapCacheKey_();
  t.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);

  const summary = plain(t.gas.runRecalls_(NOW));
  assert.equal(summary.added, 4);
  assert.equal(summary.errors, 1);
  assert.equal(summary.silent, 6); // Highlander 2 × (Maya, Robert) + 4Runner 1 × (Leo, Robert)
  assert.deepEqual(summary.vehicles.map(v => [v.vehicle, v.added === undefined ? v.error : v.added, !!v.firstImport]), [
    [V.highlander, 2, true],
    [V.wrangler, 'NHTSA recall lookup failed for JEEP WRANGLER 2016: HTTP 503', false],
    [V.x7, 1, false],
    [V.fourRunner, 1, true],
    [V.telluride, 0, false], // has recall history on the tab
  ]);

  const recalls = t.rows('Recalls').filter(r => /^26V[123]/.test(r['Campaign Number']));
  assert.deepEqual(recalls.map(r => [r['Vehicle'], r['Campaign Number'], r['Status'], r['Park It'], r['Park Outside'], r['Notes']]), [
    [V.highlander, '26V100000', 'New', 'Yes', 'No', ''],
    [V.highlander, '26V100001', 'New', 'No', 'No', ''],
    [V.x7, '26V300000', 'New', 'No', 'No', ''],
    [V.fourRunner, '26V200000', 'New', 'No', 'Yes', ''],
  ]);
  const x7 = t.gas.normRecalls_(t.gas.readTab_('Recalls')).filter(r => r.campaignNumber === '26V300000')[0];
  assert.equal(x7.reportDate, '2026-09-05');  // 05/09/2026 is 5 September
  assert.equal(x7.firstSeen, '2026-09-22');
  assert.equal(x7.component, 'ELECTRICAL SYSTEM');
  assert.equal(x7.remedy, 'Dealers will fix it, free of charge.');

  const silent = t.rows('Notification Log').filter(r => r['Result'] === 'Silent (first import)');
  assert.deepEqual(silent.map(r => [r['Key'], r['Email'], r['Title']]), [
    ['recall:' + V.highlander + ':26V100000', 'maya@example.com', 'Highlander: New recall may apply to the Highlander. Do not drive until repaired.'],
    ['recall:' + V.highlander + ':26V100000', U.owner, 'Highlander: New recall may apply to the Highlander. Do not drive until repaired.'],
    ['recall:' + V.highlander + ':26V100001', 'maya@example.com', 'Highlander: New recall may apply to the Highlander'],
    ['recall:' + V.highlander + ':26V100001', U.owner, 'Highlander: New recall may apply to the Highlander'],
    ['recall:' + V.fourRunner + ':26V200000', 'leo@example.com', '4Runner: New recall may apply to the 4Runner. Park outside, away from buildings.'],
    ['recall:' + V.fourRunner + ':26V200000', U.owner, '4Runner: New recall may apply to the 4Runner. Park outside, away from buildings.'],
  ]);
  // The successful lookups are remembered (the Jeep's failed, so it is still a first import next time).
  assert.deepEqual(JSON.parse(t.fakes.scriptProperties.getProperty('RECALLS_CHECKED_VEHICLES')),
    [V.highlander, V.x7, V.fourRunner, V.telluride].sort());
  assert.equal(t.fakes.scriptCache.get(cacheKey), null);

  // The daily notifications: the silent ones are never sent; X7's new one goes to Robert (driver and owner) once.
  const n = plain(t.gas.runNotifications_({ now: NOW, events: ['newRecall'] }));
  assert.equal(n.sent, 1);
  const sends = t.http.requests.filter(r => /\/send$/.test(r.url));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].json.messages.map(m => m.id.replace(/^n\d+-r\d+$/, 'id') && m.payload), [{
    title: 'X7', body: 'New recall may apply to the X7',
    url: 'https://anorby515.github.io/VehicleTracker/#/v/2023%20BMW%20X7/recalls', tag: 'recall:' + V.x7 + ':26V300000',
  }]);
  const sent = t.rows('Notification Log').filter(r => r['Result'] === 'Sent' && /:26V[123]/.test(r['Key']));
  assert.deepEqual(sent.map(r => [r['Key'], r['Email']]), [['recall:' + V.x7 + ':26V300000', U.owner]]);
});

test('runRecalls_: a later new campaign is added once and sent to the primary driver and the owner once', () => {
  const t = setup({ '4RUNNER': [nhtsa('26V200000')], HIGHLANDER: [], X7: [], WRANGLER: [], TELLURIDE: [] });
  t.gas.runRecalls_(NOW); // first import: silent
  assert.equal(t.rows('Notification Log').filter(r => r['Result'] === 'Silent (first import)').length, 2);

  // Next day NHTSA lists a second campaign.
  t.state.byModel['4RUNNER'] = [nhtsa('26V200000'), nhtsa('26V200001', { parkIt: true })];
  const next = new Date('2026-09-23T07:30:00-05:00');
  const s = plain(t.gas.runRecalls_(next));
  assert.equal(s.added, 1);
  assert.equal(s.silent, 0);
  // Running again adds nothing.
  assert.equal(t.gas.runRecalls_(next).added, 0);
  assert.equal(t.rows('Recalls').filter(r => r['Campaign Number'] === '26V200001').length, 1);

  const n1 = plain(t.gas.runNotifications_({ now: next, events: ['newRecall'] }));
  assert.equal(n1.sent, 2);
  const msgs = t.http.requests.filter(r => /\/send$/.test(r.url)).flatMap(r => r.json.messages);
  assert.deepEqual(msgs.map(m => [m.subscription.endpoint, m.payload.body, m.urgency]).sort(), [
    ['https://push.example.com/send/robert-phone', 'New recall may apply to the 4Runner. Do not drive until repaired.', 'high'],
    ['https://web.push.apple.com/leo-new', 'New recall may apply to the 4Runner. Do not drive until repaired.', 'high'],
  ]);
  const key = 'recall:' + V.fourRunner + ':26V200001';
  assert.deepEqual(t.rows('Notification Log').filter(r => r['Key'] === key).map(r => [r['Email'], r['Result']]).sort(),
    [['leo@example.com', 'Sent'], [U.owner, 'Sent']]);

  // Idempotent: the next run sends nothing more.
  const before = t.http.requests.length;
  // (4 candidates: both campaigns × Leo and Robert, all already on the log.)
  assert.equal(t.gas.runNotifications_({ now: new Date('2026-09-23T13:00:00-05:00'), events: ['newRecall'] }).planned, 4);
  assert.equal(t.http.requests.length, before);
  assert.equal(t.rows('Notification Log').filter(r => r['Key'] === key).length, 2);
});

test('runRecalls_: a vehicle with no recalls at first still gets a push for its first real one', () => {
  const t = setup({ TELLURIDE: [], HIGHLANDER: [], X7: [], WRANGLER: [], '4RUNNER': [] }, {
    tabs: tabs => { tabs['Recalls'] = [tabs['Recalls'][0]]; }, // no history at all
  });
  t.gas.runRecalls_(NOW);
  t.state.byModel.TELLURIDE = [nhtsa('26V400000')];
  const s = plain(t.gas.runRecalls_(new Date('2026-09-23T07:30:00-05:00')));
  assert.equal(s.added, 1);
  assert.equal(s.silent, 0);
});

test('runRecalls_: vehicles without NHTSA Make/Model are skipped, inactive ones ignored', () => {
  const t = setup({ HIGHLANDER: [nhtsa('26V100000')], X7: [], WRANGLER: [], TELLURIDE: [] }, {
    tabs: tabs => {
      const h = tabs['Vehicles'][0];
      const r4 = tabs['Vehicles'].findIndex(r => r[0] === V.fourRunner);
      tabs['Vehicles'][r4][h.indexOf('NHTSA Model')] = '';
      const jp = tabs['Vehicles'].findIndex(r => r[0] === V.wrangler);
      tabs['Vehicles'][jp][h.indexOf('Active')] = 'No';
    },
  });
  const s = plain(t.gas.runRecalls_(NOW));
  assert.deepEqual(s.vehicles.filter(v => v.skipped).map(v => v.vehicle), [V.fourRunner]);
  assert.ok(!s.vehicles.some(v => v.vehicle === V.wrangler));
  assert.ok(!t.http.requests.some(r => /WRANGLER|4RUNNER/.test(r.url)));
});

test('recallRowValues_ keeps outside text from being read as a formula', () => {
  const row = plain(pure.recallRowValues_(V.x7, pure.nhtsaCampaign_(nhtsa('26V1', { Summary: '=HYPERLINK("x")', Remedy: '-' })), '2026-09-22'));
  assert.equal(row['Summary'], '\'=HYPERLINK("x")');
  assert.equal(row['Remedy'], "'-");
  assert.equal(row['Status'], 'New');
});

// ---------------------------------------------------------------- Jobs.js

function jobsWith(lockFree) {
  const fakes = makeFakes({ tabs: fx.cloneTabs(), props: { OWNER_EMAIL: U.owner } });
  const lock = { tried: 0, released: 0, tryLock() { this.tried++; return lockFree; }, releaseLock() { this.released++; } };
  fakes.globals.LockService = { getScriptLock: () => lock };
  const gas = load({ files: FILES, globals: fakes.globals });
  const calls = [];
  gas.runRecalls_ = () => { calls.push('recalls'); throw new Error('NHTSA is down'); };
  gas.runNotifications_ = opts => { calls.push('notify:' + (opts.events ? opts.events.join(',') : 'all')); return { sent: 0 }; };
  gas.runScanStatus_ = () => { calls.push('scans'); return { checked: 3, changed: [{ scanId: 's1', previousStatus: 'Waiting', status: 'Filed' }] }; };
  return { gas, lock, calls };
}

test('jobDaily: a failed recall lookup doesn\'t stop the notifications; the lock is released', () => {
  const t = jobsWith(true);
  const out = plain(t.gas.jobDaily());
  assert.deepEqual(t.calls, ['recalls', 'notify:all']);
  assert.equal(out.skipped, false);
  assert.deepEqual(out.steps.map(s => [s.step, s.ok]), [['recall lookup', false], ['notifications', true]]);
  assert.match(out.steps[0].error, /NHTSA is down/);
  assert.equal(t.lock.released, 1);
});

test('jobScanStatus: scan check, then scan notifications only; skipped while another run holds the lock', () => {
  const t = jobsWith(true);
  const out = plain(t.gas.jobScanStatus());
  assert.deepEqual(t.calls, ['scans', 'notify:scanFiled,scanNeedsAttention']);
  assert.deepEqual(out.steps[0].result, { checked: 3, changed: ['s1: Waiting → Filed'] });

  const busy = jobsWith(false);
  assert.deepEqual(plain(busy.gas.jobScanStatus()), { job: 'jobScanStatus', skipped: true });
  assert.deepEqual(plain(busy.gas.jobDaily()), { job: 'jobDaily', skipped: true });
  assert.deepEqual(busy.calls, []);
  assert.equal(busy.lock.released, 0);
});

// ---------------------------------------------------------------- setRecallStatus

function statusEnv() {
  const env = loadApi({ tabs: fx.cloneTabs(), files: 'all' });
  const { gas } = env;
  env.today = gas.nowParts_().ymd;
  env.ctx = gas.requireUser_(gas.issueSession_('nina@example.com', Math.floor(Date.now() / 1000)).token);
  env.set = (params) => JSON.parse(JSON.stringify(gas.setRecallStatus_(env.ctx, params)));
  env.row = (campaign) => {
    const [h, ...rows] = env.fakes.spreadsheet.getSheetByName('Recalls').toValues();
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]]))).find(r => r['Campaign Number'] === campaign);
  };
  return env;
}

test('setRecallStatus_ marks a recall Done, notes who and when, and refreshes the bootstrap cache', () => {
  const env = statusEnv();
  const cacheKey = env.gas.bootstrapCacheKey_();
  env.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);

  const res = env.set({ vehicle: fx.vehicleNames.telluride, campaignNumber: '26V904000', status: 'Done' });
  assert.equal(res.recall.campaignNumber, '26V904000');
  assert.equal(res.recall.status, 'Done');
  assert.equal(res.recall.notes, 'Marked Done by Nina on ' + env.today);
  assert.equal(res.recall.parkOutside, true);
  assert.equal(env.row('26V904000')['Status'], 'Done');
  assert.equal(env.row('26V904000')['Notes'], 'Marked Done by Nina on ' + env.today);
  assert.equal(env.fakes.scriptCache.get(cacheKey), null, 'bootstrap cache invalidated');

  // Other rows are untouched.
  assert.equal(env.row('26V905000')['Status'], 'Not applicable');
  assert.equal(env.row('26V901000')['Status'], 'New');
});

test('setRecallStatus_ keeps existing notes, can undo, and does nothing when the status is already set', () => {
  const env = statusEnv();
  const JP = fx.vehicleNames.wrangler;
  env.set({ vehicle: JP, campaignNumber: '19V902000', status: 'Not applicable' });
  assert.equal(env.row('19V902000')['Notes'], 'Done at the dealer in 2019\nMarked Not applicable by Nina on ' + env.today);

  env.set({ vehicle: JP, campaignNumber: '19V902000', status: 'New' });
  assert.equal(env.row('19V902000')['Status'], 'New');
  assert.equal(env.row('19V902000')['Notes'].split('\n').length, 3);

  // Already New: no change, no extra note.
  const again = env.set({ vehicle: JP, campaignNumber: '19V902000', status: 'New' });
  assert.equal(again.recall.status, 'New');
  assert.equal(env.row('19V902000')['Notes'].split('\n').length, 3);
});

test('setRecallStatus_: an unknown recall is 404, and the route only accepts New, Done or Not applicable', () => {
  const env = statusEnv();
  assert.throws(() => env.set({ vehicle: fx.vehicleNames.telluride, campaignNumber: '99V999000', status: 'Done' }),
    e => e.apiError === true && e.status === 404 && e.error === 'not_found');
  // Right campaign, wrong vehicle.
  assert.throws(() => env.set({ vehicle: fx.vehicleNames.x7, campaignNumber: '26V904000', status: 'Done' }),
    e => e.apiError === true && e.status === 404);

  const spec = env.gas.routes_().setRecallStatus;
  assert.equal(spec.auth, true);
  assert.deepEqual(Array.from(spec.params.status.oneOf), ['New', 'Done', 'Not applicable']);
});
