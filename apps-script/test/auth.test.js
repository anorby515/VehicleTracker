'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fx = require('./fixtures/sheet');
const { loadApi, installTokeninfo, TEST_PROPS } = require('./fakes-services');

const plain = x => JSON.parse(JSON.stringify(x));
const NOW = Date.UTC(2026, 8, 22, 17, 0, 0);  // 2026-09-22 12:00 Chicago
const NOW_SEC = Math.floor(NOW / 1000);
const DAY = 86400;
const CLIENT_ID = TEST_PROPS.OAUTH_CLIENT_ID;
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function setup(opts = {}) {
  // No SESSION_SECRET yet: the first session creates it.
  const env = loadApi({ tabs: fx.cloneTabs(), now: NOW, props: Object.assign({ SESSION_SECRET: null }, opts.props) });
  env.nowSec = () => Math.floor(env.fakes.clock.now() / 1000);
  return env;
}

/** Runs fn and returns the ApiError-like object it throws. */
function apiErr(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e.apiError, 'expected an apiError_, got ' + (e && e.stack));
    // detail comes from the vm realm: compare it as plain JSON.
    return { status: e.status, error: e.error, message: e.message,
      detail: e.detail === undefined ? undefined : JSON.parse(JSON.stringify(e.detail)) };
  }
  assert.fail('expected an error');
}

const b64url = s => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function claims(overrides) {
  return Object.assign({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    azp: CLIENT_ID,
    sub: '100000000000000000001',
    email: 'Robert@Example.com',
    email_verified: 'true',
    name: 'Robert Sample',
    nonce: 'nonce-1',
    iat: String(NOW_SEC - 60),
    exp: String(NOW_SEC + 3540),
    alg: 'RS256',
    kid: 'fake-kid',
    typ: 'JWT',
  }, overrides);
}

// ---------------------------------------------------------------- session tokens

test('issueSession_ / verifySession_ round-trip with the documented token shape', () => {
  const { gas, fakes } = setup();
  assert.equal(fakes.scriptProperties.getProperty('SESSION_SECRET'), null);
  const s = gas.issueSession_('Robert@Example.com', NOW_SEC);
  // SESSION_SECRET is created on first use: two UUIDs joined.
  assert.match(fakes.scriptProperties.getProperty('SESSION_SECRET'), /^[0-9a-f-]{72}$/);

  const parts = s.token.split('.');
  assert.equal(parts.length, 3);
  assert.equal(parts[0], 'v1');
  assert.ok(!s.token.includes('='), 'base64url without padding');
  const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  assert.deepEqual(Object.keys(payload), ['e', 'i', 'x', 'n']);
  assert.equal(payload.e, 'robert@example.com');
  assert.equal(payload.i, NOW_SEC);
  assert.equal(payload.x, NOW_SEC + 60 * DAY);
  // The signature is HMAC-SHA256(secret, "v1.<payload>").
  const secret = fakes.scriptProperties.getProperty('SESSION_SECRET');
  const sig = crypto.createHmac('sha256', secret).update(parts[0] + '.' + parts[1]).digest('base64url');
  assert.equal(parts[2], sig);
  assert.equal(s.expiresAt, '2026-11-21T11:00:00-06:00');

  assert.deepEqual(plain(gas.verifySession_(s.token, NOW_SEC + 10)), {
    email: 'robert@example.com', issuedAt: NOW_SEC, expiresAt: NOW_SEC + 60 * DAY, nonce: payload.n,
  });
  // Two sessions for the same person differ (random nonce).
  assert.notEqual(gas.issueSession_('robert@example.com', NOW_SEC).token, s.token);
});

test('verifySession_ rejects expired, tampered, wrong-version and garbage tokens', () => {
  const { gas, fakes } = setup();
  const s = gas.issueSession_('leo@example.com', NOW_SEC);
  const [v, p, sig] = s.token.split('.');

  assert.ok(gas.verifySession_(s.token, NOW_SEC + 60 * DAY - 1));
  assert.equal(gas.verifySession_(s.token, NOW_SEC + 60 * DAY), null, 'expired');

  const forged = b64url(JSON.stringify({ e: 'robert@example.com', i: NOW_SEC, x: NOW_SEC + 60 * DAY, n: 'x' }));
  assert.equal(gas.verifySession_(v + '.' + forged + '.' + sig, NOW_SEC), null, 'payload swapped');
  const flipped = sig.slice(0, -2) + (sig.slice(-2) === 'AA' ? 'AB' : 'AA');
  assert.equal(gas.verifySession_(v + '.' + p + '.' + flipped, NOW_SEC), null, 'signature changed');
  assert.equal(gas.verifySession_(v + '.' + p, NOW_SEC), null, 'no signature');
  assert.equal(gas.verifySession_('v2.' + p + '.' + sig, NOW_SEC), null, 'version changed');

  // A correctly signed token with another version is still refused.
  const secret = fakes.scriptProperties.getProperty('SESSION_SECRET');
  const v2sig = crypto.createHmac('sha256', secret).update('v2.' + p).digest('base64url');
  assert.equal(gas.verifySession_('v2.' + p + '.' + v2sig, NOW_SEC), null, 'v2 token');

  // A correctly signed payload that isn't valid session JSON.
  const junk = b64url('{"e":"","i":"soon"}');
  const junkSig = crypto.createHmac('sha256', secret).update('v1.' + junk).digest('base64url');
  assert.equal(gas.verifySession_('v1.' + junk + '.' + junkSig, NOW_SEC), null, 'bad payload');

  // Issued in the future (more than 5 minutes of clock skew).
  assert.equal(gas.verifySession_(s.token, NOW_SEC - 301), null, 'issued in the future');

  for (const bad of [undefined, null, '', 'abc', 42, {}, 'v1..', 'x'.repeat(3000)]) {
    assert.equal(gas.verifySession_(bad, NOW_SEC), null, 'garbage: ' + String(bad).slice(0, 20));
  }
});

test('deleting SESSION_SECRET signs every device out', () => {
  const { gas, fakes } = setup();
  const s = gas.issueSession_('robert@example.com', NOW_SEC);
  assert.ok(gas.verifySession_(s.token, NOW_SEC));
  fakes.scriptProperties.deleteProperty('SESSION_SECRET');
  assert.equal(gas.verifySession_(s.token, NOW_SEC), null);
  // A new secret was generated, and new sessions work.
  assert.ok(fakes.scriptProperties.getProperty('SESSION_SECRET'));
  assert.ok(gas.verifySession_(gas.issueSession_('robert@example.com', NOW_SEC).token, NOW_SEC));
});

test('requireUser_: 401 for a bad session, 403 not_family once Active is No, else the App Users row', () => {
  const { gas, fakes } = setup();
  const s = gas.issueSession_('maya@example.com', NOW_SEC);
  const ctx = gas.requireUser_(s.token, NOW_SEC);
  assert.equal(ctx.email, 'maya@example.com');
  assert.equal(ctx.appUser.name, 'Maya');
  assert.equal(ctx.issuedAt, NOW_SEC);
  assert.equal(ctx.appUsers.length, 4);

  assert.deepEqual(apiErr(() => gas.requireUser_('nope', NOW_SEC)),
    { status: 401, error: 'not_signed_in', message: 'Please sign in again.', detail: undefined });
  assert.equal(apiErr(() => gas.requireUser_(undefined, NOW_SEC)).status, 401);

  // Andrew sets Active = No: the very next request is refused.
  const users = fakes.spreadsheet.getSheetByName('App Users');
  const activeCol = users.toValues()[0].indexOf('Active') + 1;
  users.getRange(4, activeCol).setValue('No');  // Maya's row
  assert.deepEqual(apiErr(() => gas.requireUser_(s.token, NOW_SEC)),
    { status: 403, error: 'not_family', message: 'This app is for the Norby family.', detail: undefined });

  // Someone never on the list, with a validly signed session.
  const stranger = gas.issueSession_('stranger@example.com', NOW_SEC);
  assert.equal(apiErr(() => gas.requireUser_(stranger.token, NOW_SEC)).error, 'not_family');
});

test('renewSessionIfOld_ rolls the session forward only after 7 days', () => {
  const { gas } = setup();
  const s = gas.issueSession_('leo@example.com', NOW_SEC - 8 * DAY);
  const ctx = gas.requireUser_(s.token, NOW_SEC);
  const fresh = gas.renewSessionIfOld_(ctx, NOW_SEC);
  assert.ok(fresh);
  assert.equal(gas.verifySession_(fresh.token, NOW_SEC).issuedAt, NOW_SEC);
  assert.equal(fresh.expiresAtSec, NOW_SEC + 60 * DAY);
  assert.equal(gas.renewSessionIfOld_({ email: 'leo@example.com', issuedAt: NOW_SEC - 6 * DAY }, NOW_SEC), null);
  assert.equal(gas.renewSessionIfOld_({ email: 'leo@example.com', issuedAt: NOW_SEC - 7 * DAY }, NOW_SEC), null);
});

// ---------------------------------------------------------------- Google ID token

test('signIn_: a good Google ID token gives a session and the user; it is cached until it expires', () => {
  const { gas, services } = setup();
  installTokeninfo(services.urlFetch, { 'good-token': claims() });
  const res = plain(gas.signIn_({ idToken: 'good-token', nonce: 'nonce-1' }, NOW_SEC));
  assert.deepEqual(Object.keys(res), ['session', 'sessionExpiresAt', 'user']);
  assert.deepEqual(res.user, {
    email: 'robert@example.com', name: 'Robert', driverName: 'Bob', defaultVehicle: '2023 BMW X7',
    prefs: { odometerNudge: true, scanFiled: false }, isOwner: true,
  });
  assert.equal(gas.verifySession_(res.session, NOW_SEC).email, 'robert@example.com');
  assert.equal(services.urlFetch.calls.length, 1);
  assert.match(services.urlFetch.calls[0].url, /^https:\/\/oauth2\.googleapis\.com\/tokeninfo\?id_token=good-token$/);

  // Same token again: no second call to Google.
  gas.signIn_({ idToken: 'good-token', nonce: 'nonce-1' }, NOW_SEC + 30);
  assert.equal(services.urlFetch.calls.length, 1);
  // The cache keeps claims, not a verdict: another nonce still fails.
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'good-token', nonce: 'other' }, NOW_SEC + 30)).status, 401);
  // After the token's exp, the cached claims are refused too.
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'good-token', nonce: 'nonce-1' }, NOW_SEC + 3600)).status, 401);
});

test('signIn_: each failed tokeninfo claim is a 401 and nothing is cached', () => {
  const { gas, services, fakes } = setup();
  installTokeninfo(services.urlFetch, {
    'wrong-aud': claims({ aud: 'someone-else.apps.googleusercontent.com' }),
    'wrong-iss': claims({ iss: 'https://evil.example.com' }),
    'expired': claims({ exp: String(NOW_SEC - 1) }),
    'unverified': claims({ email_verified: 'false' }),
    'no-email': claims({ email: '' }),
    'bare-iss': claims({ iss: 'accounts.google.com', email: 'leo@example.com', nonce: undefined }),
  });
  const cases = {
    'wrong-aud': 'nonce-1', 'wrong-iss': 'nonce-1', 'expired': 'nonce-1', 'unverified': 'nonce-1',
    'no-email': 'nonce-1', 'unknown-token': 'nonce-1',
  };
  for (const tok of Object.keys(cases)) {
    const e = apiErr(() => gas.signIn_({ idToken: tok, nonce: cases[tok] }, NOW_SEC));
    assert.deepEqual([e.status, e.error], [401, 'not_signed_in'], tok);
    assert.equal(e.message, "Google sign-in didn't go through. Please try again.");
  }
  // Nonce mismatch, and a nonce asked for but missing from the token.
  installTokeninfo(services.urlFetch, { 'good': claims(), 'bare-iss': claims({ iss: 'accounts.google.com', nonce: undefined }) });
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'good', nonce: 'nonce-2' }, NOW_SEC)).status, 401);
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'bare-iss', nonce: 'nonce-1' }, NOW_SEC)).status, 401);
  // Regression: the nonce is required. A request without one (or an empty one) is refused, even for a
  // token that has no nonce either: the app always asks Google for one.
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'bare-iss' }, NOW_SEC)).status, 401);
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'bare-iss', nonce: '' }, NOW_SEC)).status, 401);
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'good' }, NOW_SEC)).status, 401);
  // The bare issuer is fine.
  installTokeninfo(services.urlFetch, { 'bare-iss-2': claims({ iss: 'accounts.google.com', email: 'leo@example.com' }) });
  assert.ok(gas.signIn_({ idToken: 'bare-iss-2', nonce: 'nonce-1' }, NOW_SEC).session);
  // Only the one accepted token was cached.
  const cached = Array.from(fakes.scriptCache.entries.keys()).filter(k => k.startsWith('idtok:'));
  assert.equal(cached.length, 1);
  assert.ok(!cached[0].includes('bare-iss'), 'the cache key is a hash, not the token');
});

test('signIn_: a verified Google account that is not an Active App Users row gets 403 not_family', () => {
  const { gas, services, fakes } = setup();
  installTokeninfo(services.urlFetch, {
    stranger: claims({ email: 'stranger@example.com' }),
    leo: claims({ email: 'leo@example.com' }),
  });
  assert.deepEqual(apiErr(() => gas.signIn_({ idToken: 'stranger', nonce: 'nonce-1' }, NOW_SEC)),
    { status: 403, error: 'not_family', message: 'This app is for the Norby family.', detail: undefined });
  const users = fakes.spreadsheet.getSheetByName('App Users');
  users.getRange(3, users.toValues()[0].indexOf('Active') + 1).setValue('No');  // Leo
  assert.equal(apiErr(() => gas.signIn_({ idToken: 'leo', nonce: 'nonce-1' }, NOW_SEC)).error, 'not_family');
});

// ---------------------------------------------------------------- sign in with a code

test('pair codes: 8 unambiguous characters, single use, case and dashes ignored', () => {
  const { gas, nowSec } = setup();
  const ctx = gas.requireUser_(gas.issueSession_('nina@example.com', nowSec()).token, nowSec());
  const created = plain(gas.pairCreate_(ctx, nowSec()));
  assert.match(created.code, new RegExp('^[' + ALPHABET + ']{8}$'));
  assert.equal(created.expiresAt, '2026-09-22T12:10:00-05:00');

  const typed = created.code.slice(0, 4).toLowerCase() + '-' + created.code.slice(4);
  const res = plain(gas.pairRedeem_({ code: typed }, nowSec()));
  assert.equal(res.user.email, 'nina@example.com');
  assert.equal(gas.verifySession_(res.session, nowSec()).email, 'nina@example.com');

  const again = apiErr(() => gas.pairRedeem_({ code: created.code }, nowSec()));
  assert.deepEqual([again.status, again.error], [401, 'not_signed_in']);
  assert.equal(again.message, "That code didn't work. Codes last 10 minutes and work once.");
});

test('pair codes expire after 10 minutes, and are burned after 5 wrong attempts', () => {
  const { gas, fakes, nowSec } = setup();
  const ctx = gas.requireUser_(gas.issueSession_('leo@example.com', nowSec()).token, nowSec());
  const first = gas.pairCreate_(ctx, nowSec()).code;
  fakes.clock.advance(601);
  assert.equal(apiErr(() => gas.pairRedeem_({ code: first }, nowSec())).status, 401);

  const second = gas.pairCreate_(ctx, nowSec()).code;
  for (let i = 0; i < 4; i++) assert.equal(apiErr(() => gas.pairRedeem_({ code: 'WRONG' + i }, nowSec())).status, 401);
  assert.equal(gas.pairRedeem_({ code: second }, nowSec()).user.email, 'leo@example.com', '4 wrong tries: still valid');

  const third = gas.pairCreate_(ctx, nowSec()).code;
  for (let i = 0; i < 5; i++) apiErr(() => gas.pairRedeem_({ code: 'NOPE' + i }, nowSec()));
  assert.equal(apiErr(() => gas.pairRedeem_({ code: third }, nowSec())).status, 401, '5 wrong tries: burned');
});

test('pair codes: 30 wrong codes lock redeeming for everyone for 10 minutes', () => {
  const { gas, fakes, nowSec } = setup();
  const ctx = gas.requireUser_(gas.issueSession_('robert@example.com', nowSec()).token, nowSec());
  for (let i = 0; i < 30; i++) {
    fakes.clock.advance(10);  // spread over 5 minutes
    assert.equal(apiErr(() => gas.pairRedeem_({ code: 'GUESS' + i }, nowSec())).status, 401);
  }
  const code = gas.pairCreate_(ctx, nowSec()).code;
  const locked = apiErr(() => gas.pairRedeem_({ code }, nowSec()));
  assert.deepEqual([locked.status, locked.error], [429, 'rate_limited']);
  fakes.clock.advance(599);
  assert.equal(apiErr(() => gas.pairRedeem_({ code }, nowSec())).status, 429);
  fakes.clock.advance(2);
  const fresh = gas.pairCreate_(ctx, nowSec()).code;
  assert.equal(gas.pairRedeem_({ code: fresh }, nowSec()).user.email, 'robert@example.com');
});

test('pair codes: failures older than the 10-minute window do not count', () => {
  const { gas, fakes, nowSec } = setup();
  for (let i = 0; i < 29; i++) apiErr(() => gas.pairRedeem_({ code: 'OLD' + i }, nowSec()));
  fakes.clock.advance(601);
  for (let i = 0; i < 29; i++) {
    assert.equal(apiErr(() => gas.pairRedeem_({ code: 'NEW' + i }, nowSec())).status, 401);
  }
});

test('newPairCode_ draws from the whole alphabet', () => {
  const { gas } = setup();
  const seen = new Set();
  const codes = new Set();
  for (let i = 0; i < 300; i++) {
    const c = gas.newPairCode_();
    assert.match(c, new RegExp('^[' + ALPHABET + ']{8}$'));
    codes.add(c);
    for (const ch of c) seen.add(ch);
  }
  assert.equal(codes.size, 300);
  assert.equal(seen.size, ALPHABET.length);
});

// ---------------------------------------------------------------- regressions (review)

test('regression: tokeninfo claims are compared exactly, never after String() coercion', () => {
  const { gas, services } = setup();
  installTokeninfo(services.urlFetch, {
    'aud-array': claims({ aud: [CLIENT_ID] }),                       // String([x]) === x
    'iss-array': claims({ iss: ['accounts.google.com'] }),
    'verified-array': claims({ email_verified: ['true'] }),
    'verified-True': claims({ email_verified: 'True' }),
    'nonce-array': claims({ nonce: ['nonce-1'] }),
    'exp-array': claims({ exp: [String(NOW_SEC + 3540)] }),
    'email-array': claims({ email: ['robert@example.com'] }),
  });
  for (const tok of ['aud-array', 'iss-array', 'verified-array', 'verified-True', 'nonce-array', 'exp-array', 'email-array']) {
    const e = apiErr(() => gas.signIn_({ idToken: tok, nonce: 'nonce-1' }, NOW_SEC));
    assert.deepEqual([e.status, e.error], [401, 'not_signed_in'], tok);
  }
});

test('regression: pairRedeem never treats "__proto__" or "constructor" as an open code, and counts them as wrong', () => {
  const { gas, fakes, nowSec } = setup();
  const ctx = gas.requireUser_(gas.issueSession_('leo@example.com', nowSec()).token, nowSec());
  const code = gas.pairCreate_(ctx, nowSec()).code;
  for (const guess of ['__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
    const e = apiErr(() => gas.pairRedeem_({ code: guess }, nowSec()));
    assert.deepEqual([e.status, e.error], [401, 'not_signed_in'], guess);
  }
  // They counted toward the global limit (4 so far) and toward the open code's attempts.
  assert.equal(JSON.parse(fakes.scriptCache.get('pair:fails')).n, 4);
  assert.equal(JSON.parse(fakes.scriptCache.get('pair:open'))[code].fails, 4);
  assert.equal(gas.pairRedeem_({ code }, nowSec()).user.email, 'leo@example.com');
});
