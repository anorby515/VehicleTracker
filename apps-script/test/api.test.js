'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/sheet');
const { loadApi, installTokeninfo, TEST_PROPS } = require('./fakes-services');

const DAY = 86400;
const nowSec = () => Math.floor(Date.now() / 1000);

/**
 * Loads the API with stand-ins for the Notify.js / Scans.js handlers, which
 * another file implements; each records its calls.
 */
function setup(opts = {}) {
  const calls = [];
  const record = (name, result) => function (ctx, params) {
    calls.push({ name, email: ctx && ctx.email ? ctx.email : ctx, params: params ? JSON.parse(JSON.stringify(params)) : params });
    if (result instanceof Error) throw result;
    return result;
  };
  const errors = [];
  const quietConsole = Object.assign(Object.create(console), {
    error: (...a) => errors.push(a.join(' ')),
    warn: () => {},
    log: () => {},
  });
  const env = loadApi({
    tabs: fx.cloneTabs(),
    globals: Object.assign({
      console: quietConsole,
      subscribePush_: record('subscribePush_', { done: true }),
      unsubscribePush_: record('unsubscribePush_', { done: true }),
      savePrefs_: record('savePrefs_', { prefs: { odometerNudge: false } }),
      testPush_: record('testPush_', { sent: 1, failed: 0 }),
      signOutDevice_: record('signOutDevice_', { done: true }),
      checkUserScans_: record('checkUserScans_', undefined),
    }, opts.globals || {}),
  });
  env.calls = calls;
  env.errors = errors;
  /** POSTs a body (object → JSON; string sent as is) and returns the parsed response. */
  env.post = (body) => {
    const out = env.gas.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body), type: 'text/plain' } });
    assert.equal(out.mimeType, 'JSON');
    return JSON.parse(out.getContent());
  };
  env.session = (email, issuedAt) => env.gas.issueSession_(email, issuedAt === undefined ? nowSec() : issuedAt).token;
  return env;
}

test('doGet answers ?health=1 only', () => {
  const { gas } = setup();
  const health = gas.doGet({ parameter: { health: '1' } });
  assert.equal(health.mimeType, 'JSON');
  assert.deepEqual(JSON.parse(health.getContent()), { ok: true, version: '1.0.0' });
  for (const e of [undefined, {}, { parameter: {} }, { parameter: { health: '0' } }, { parameter: { action: 'bootstrap' } }]) {
    const res = JSON.parse(gas.doGet(e).getContent());
    assert.equal(res.ok, false);
    assert.equal(res.status, 404);
  }
});

test('doPost: empty, non-JSON and non-object bodies are 400 bad_request (never an HTML page)', () => {
  const { gas, post } = setup();
  for (const e of [undefined, {}, { postData: undefined }, { postData: { contents: '' } }]) {
    const res = JSON.parse(gas.doPost(e).getContent());
    assert.deepEqual([res.ok, res.status, res.error], [false, 400, 'bad_request']);
  }
  assert.deepEqual(post('{"action": "bootstrap"'), {
    ok: false, status: 400, error: 'bad_request', message: "The request wasn't valid JSON.",
  });
  assert.equal(post('[1,2]').status, 400);
  assert.equal(post('"bootstrap"').status, 400);
  assert.equal(post('null').status, 400);
});

test('doPost: unknown or missing action → 400; missing or bad session → 401', () => {
  const { post, session } = setup();
  assert.deepEqual(post({ action: 'dropTables', session: session('robert@example.com') }),
    { ok: false, status: 400, error: 'bad_request', message: 'Unknown action.' });
  assert.equal(post({ session: 'x' }).status, 400);
  assert.equal(post({ action: 'toString' }).status, 400, 'no prototype lookups');
  assert.equal(post({ action: '__proto__' }).status, 400);

  for (const action of ['bootstrap', 'pairCreate', 'getFile', 'addOdometer', 'uploadStart', 'uploadChunk',
    'subscribePush', 'unsubscribePush', 'savePrefs', 'testPush', 'signOut']) {
    assert.deepEqual(post({ action }), {
      ok: false, status: 401, error: 'not_signed_in', message: 'Please sign in again.',
    }, action);
    assert.equal(post({ action, session: 'v1.bogus.token' }).status, 401, action);
  }
});

test('doPost: a session for someone no longer Active gets 403 not_family and no data', () => {
  const { post, session, fakes } = setup();
  const token = session('leo@example.com');
  const users = fakes.spreadsheet.getSheetByName('App Users');
  users.getRange(3, users.toValues()[0].indexOf('Active') + 1).setValue('No');
  assert.deepEqual(post({ action: 'bootstrap', session: token }), {
    ok: false, status: 403, error: 'not_family', message: 'This app is for the Norby family.',
  });
});

test('doPost: an unexpected error is a 500 server_error JSON with a friendly message, logged', () => {
  const env = setup({ globals: { testPush_: () => { throw new Error('Push Worker exploded'); } } });
  const res = env.post({ action: 'testPush', session: env.session('robert@example.com') });
  assert.deepEqual(res, {
    ok: false, status: 500, error: 'server_error',
    message: 'Something went wrong on our side. Please try again in a minute.',
  });
  assert.equal(env.errors.length, 1);
  assert.match(env.errors[0], /API error in testPush: Error: Push Worker exploded/);
});

test('doPost: handlers from Notify.js get (ctx, validated params) and their result is wrapped with ok', () => {
  const { post, session, calls } = setup();
  const token = session('Robert@Example.com');
  const sub = { endpoint: 'https://push.example.com/send/abc', keys: { p256dh: 'k', auth: 'a' } };
  assert.deepEqual(post({ action: 'subscribePush', session: token, subscription: sub, deviceLabel: 'iPhone', extra: 1 }),
    { ok: true, done: true });
  assert.deepEqual(post({ action: 'unsubscribePush', session: token, endpoint: sub.endpoint }), { ok: true, done: true });
  assert.deepEqual(post({ action: 'savePrefs', session: token, prefs: { odometerNudge: false } }),
    { ok: true, prefs: { odometerNudge: false } });
  assert.deepEqual(post({ action: 'testPush', session: token }), { ok: true, sent: 1, failed: 0 });
  assert.deepEqual(post({ action: 'signOut', session: token, endpoint: sub.endpoint }), { ok: true, done: true });
  assert.deepEqual(post({ action: 'signOut', session: token }), { ok: true, done: true });
  assert.deepEqual(calls.map(c => [c.name, c.email]), [
    ['subscribePush_', 'robert@example.com'], ['unsubscribePush_', 'robert@example.com'],
    ['savePrefs_', 'robert@example.com'], ['testPush_', 'robert@example.com'],
    ['signOutDevice_', 'robert@example.com'], ['signOutDevice_', 'robert@example.com'],
  ]);
  // Only declared params are passed on.
  assert.deepEqual(calls[0].params, { subscription: sub, deviceLabel: 'iPhone' });
  assert.deepEqual(calls[4].params, { endpoint: sub.endpoint });
  assert.deepEqual(calls[5].params, {});
});

test('doPost: params are type-checked per action → 400 bad_request naming the field', () => {
  const { post, session, calls } = setup();
  const token = session('robert@example.com');
  const bad = [
    [{ action: 'getFile', fileId: 'short' }, 'fileId'],
    [{ action: 'getFile', fileId: '../../etc/passwd-00000' }, 'fileId'],
    [{ action: 'getFile', fileId: 'fake-doc-4r-0903-inv', purpose: 'thumbnail' }, 'purpose'],
    [{ action: 'addOdometer', vehicle: '2023 Toyota 4Runner', mileage: '37500', clientId: 'c1' }, 'mileage'],
    [{ action: 'addOdometer', vehicle: '2023 Toyota 4Runner', mileage: 37500 }, 'clientId'],
    [{ action: 'addOdometer', vehicle: '2023 Toyota 4Runner', mileage: 37500, clientId: 'c1', date: '9/22/2026' }, 'date'],
    [{ action: 'addOdometer', vehicle: '2023 Toyota 4Runner', mileage: 37500, clientId: 'c1', confirmHigh: 'yes' }, 'confirmHigh'],
    [{ action: 'uploadStart', scanId: 's1', kind: 'Photo', vehicleHint: 'x', size: 10, pages: 1, capturedAt: 'now' }, 'kind'],
    [{ action: 'uploadStart', scanId: 's1', kind: 'Receipt', vehicleHint: 'x', size: 10.5, pages: 1, capturedAt: 'now' }, 'size'],
    [{ action: 'uploadStart', scanId: 'has spaces', kind: 'Receipt', vehicleHint: 'x', size: 10, pages: 1, capturedAt: 'now' }, 'scanId'],
    [{ action: 'uploadChunk', uploadId: 'u', offset: -1, data: 'JVBERi0=' }, 'offset'],
    [{ action: 'uploadChunk', uploadId: 'u', offset: 0 }, 'data'],
    [{ action: 'subscribePush', subscription: 'https://push.example.com', deviceLabel: 'iPhone' }, 'subscription'],
    [{ action: 'unsubscribePush' }, 'endpoint'],
    [{ action: 'savePrefs', prefs: [true] }, 'prefs'],
    [{ action: 'signIn' }, 'idToken'],
    [{ action: 'signIn', idToken: 42 }, 'idToken'],
    [{ action: 'pairRedeem', code: 12345678 }, 'code'],
  ];
  for (const [body, field] of bad) {
    const res = post(Object.assign({ session: token }, body));
    assert.deepEqual([res.ok, res.status, res.error, res.detail], [false, 400, 'bad_request', { field }], JSON.stringify(body));
    assert.match(res.message, new RegExp('^The request ' + field + ' '));
  }
  assert.equal(calls.length, 0, 'no handler ran');
});

test('doPost bootstrap: runs the scan check first, returns the Bootstrap, renews week-old sessions', () => {
  const { post, session, calls } = setup();
  const res = post({ action: 'bootstrap', session: session('leo@example.com') });
  assert.equal(res.ok, true);
  assert.deepEqual(calls.map(c => [c.name, c.email]), [['checkUserScans_', 'leo@example.com']]);
  assert.equal(res.bootstrap.user.email, 'leo@example.com');
  assert.equal(res.bootstrap.vehicles.length, 5);
  assert.ok(Array.isArray(res.bootstrap.myScans));
  assert.equal(res.session, undefined, 'a fresh session is not renewed');

  const old = post({ action: 'bootstrap', session: session('leo@example.com', nowSec() - 8 * DAY) });
  assert.equal(old.ok, true);
  assert.match(old.session, /^v1\./);
  assert.match(old.sessionExpiresAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[-+]\d{2}:\d{2}$/);
  // The renewed session works.
  assert.equal(post({ action: 'bootstrap', session: old.session }).ok, true);
});

test('doPost bootstrap: a failing scan-status check never breaks bootstrap', () => {
  const { post, session } = setup({ globals: { checkUserScans_: () => { throw new Error('Drive hiccup'); } } });
  const res = post({ action: 'bootstrap', session: session('nina@example.com') });
  assert.equal(res.ok, true);
  assert.equal(res.bootstrap.user.name, 'Nina');
});

test('doPost signIn / pairCreate / pairRedeem need no session where documented', () => {
  const { post, services } = setup();
  const exp = String(nowSec() + 3000);
  const base = { iss: 'accounts.google.com', aud: TEST_PROPS.OAUTH_CLIENT_ID, email_verified: 'true', exp, nonce: 'n1' };
  installTokeninfo(services.urlFetch, {
    maya: Object.assign({ email: 'maya@example.com' }, base),
    stranger: Object.assign({ email: 'stranger@example.com' }, base),
  });
  const ok = post({ action: 'signIn', idToken: 'maya', nonce: 'n1' });
  assert.equal(ok.ok, true);
  assert.equal(ok.user.name, 'Maya');
  assert.match(ok.session, /^v1\./);
  assert.deepEqual(post({ action: 'signIn', idToken: 'stranger', nonce: 'n1' }), {
    ok: false, status: 403, error: 'not_family', message: 'This app is for the Norby family.',
  });
  assert.equal(post({ action: 'signIn', idToken: 'forged', nonce: 'n1' }).status, 401);

  const created = post({ action: 'pairCreate', session: ok.session });
  assert.equal(created.ok, true);
  const redeemed = post({ action: 'pairRedeem', code: created.code });
  assert.equal(redeemed.ok, true);
  assert.equal(redeemed.user.email, 'maya@example.com');
  assert.equal(post({ action: 'pairRedeem', code: created.code }).status, 401);
});

test('all apps-script files load together (no clashing globals) and bootstrap runs the real scan check', () => {
  const env = loadApi({ tabs: fx.cloneTabs(), files: 'all',
    globals: { console: Object.assign(Object.create(console), { warn: () => {}, log: () => {} }) } });
  const { gas } = env;
  ['subscribePush_', 'unsubscribePush_', 'savePrefs_', 'testPush_', 'signOutDevice_', 'checkUserScans_']
    .forEach(fn => assert.equal(typeof gas[fn], 'function', fn));
  const token = gas.issueSession_('leo@example.com', nowSec()).token;
  const res = JSON.parse(gas.doPost({ postData: { contents: JSON.stringify({ action: 'bootstrap', session: token }) } })
    .getContent());
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.equal(res.bootstrap.user.email, 'leo@example.com');
});

test('guard: only signIn and pairRedeem skip the session; every other action re-checks App Users (403, handler never runs)', () => {
  const { gas, post, session, fakes, calls } = setup();
  const routes = gas.routes_();
  assert.deepEqual(Object.keys(routes).filter(a => routes[a].auth !== true).sort(), ['pairRedeem', 'signIn']);

  const token = session('leo@example.com');
  const users = fakes.spreadsheet.getSheetByName('App Users');
  users.getRange(3, users.toValues()[0].indexOf('Active') + 1).setValue('No');  // Leo, after his session was issued
  const valid = {
    bootstrap: {}, pairCreate: {}, testPush: {}, signOut: {},
    getFile: { fileId: 'fake-doc-4r-0903-inv' },
    addOdometer: { vehicle: fx.vehicleNames.fourRunner, mileage: 40000, clientId: 'c1' },
    uploadStart: { scanId: 's1', kind: 'Receipt', vehicleHint: fx.vehicleNames.fourRunner, size: 1000, pages: 1,
      capturedAt: '2026-09-22T12:00:00Z' },
    uploadChunk: { uploadId: 'u1', offset: 0, data: 'JVBERi0=' },
    subscribePush: { subscription: { endpoint: 'https://web.push.apple.com/x', keys: { p256dh: 'k', auth: 'a' } } },
    unsubscribePush: { endpoint: 'https://web.push.apple.com/x' },
    savePrefs: { prefs: {} },
  };
  const authed = Object.keys(routes).filter(a => routes[a].auth === true).sort();
  assert.deepEqual(authed, Object.keys(valid).sort(), 'every authed action is covered here');
  const writesBefore = fakes.spreadsheet.getSheets().map(s => s.writes.length);
  for (const action of authed) {
    assert.deepEqual(post(Object.assign({ action, session: token }, valid[action])), {
      ok: false, status: 403, error: 'not_family', message: 'This app is for the Norby family.',
    }, action);
  }
  assert.equal(calls.length, 0, 'no handler ran');
  assert.deepEqual(fakes.spreadsheet.getSheets().map(s => s.writes.length), writesBefore, 'nothing written');
});
