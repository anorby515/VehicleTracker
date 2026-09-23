import test from 'node:test';
import assert from 'node:assert/strict';
import { createPublicKey, verify } from 'node:crypto';
import worker from '../src/index.js';
import { b64u, decodeJwt, fromB64u, makeSubscription, makeVapidKeys } from './helpers.mjs';

const BASE = 'https://vehicles-push.example.workers.dev';
const SECRET = 'test-secret-not-real';
const VAPID = makeVapidKeys();
const ENV = {
  PUSH_SECRET: SECRET,
  VAPID_PUBLIC_KEY: VAPID.publicKey,
  VAPID_PRIVATE_KEY: VAPID.privateKey,
  VAPID_SUBJECT: 'https://example.github.io/VehicleTracker/',
};
const APPLE = 'https://web.push.apple.com/QFakeToken1';
const APP_URL = 'https://example.github.io/VehicleTracker/';
const PAYLOAD = { title: '4Runner', body: 'Tire rotation due in 2 weeks', url: APP_URL + '#/v/2023%20Toyota%204Runner', tag: 'due:4runner' };

/**
 * Replaces the global fetch the Worker uses for push services. `respond`
 * gets (url, init) and returns a Response (or throws, to simulate a network error).
 */
function stubFetch(t, respond = () => new Response(null, { status: 201 })) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return respond(String(url), init); };
  t.after(() => { globalThis.fetch = original; });
  return calls;
}

function sendRequest(body, { auth = 'Bearer ' + SECRET, headers = {} } = {}) {
  return new Request(BASE + '/send', {
    method: 'POST',
    headers: Object.assign(auth ? { Authorization: auth } : {}, headers),
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function call(request, env = ENV) {
  const res = await worker.fetch(request, env);
  return { status: res.status, headers: res.headers, json: await res.json() };
}

function message(id, sub, extra = {}) {
  return Object.assign({ id, subscription: sub, payload: PAYLOAD, ttl: 86400, urgency: 'normal' }, extra);
}

// ---------------------------------------------------------------- routing

test('GET / is a health check; other routes 404; no CORS headers', async (t) => {
  const calls = stubFetch(t);
  const health = await call(new Request(BASE + '/'));
  assert.equal(health.status, 200);
  assert.deepEqual(health.json, { ok: true, service: 'vehicles-push' });
  assert.equal(health.headers.get('Access-Control-Allow-Origin'), null);

  assert.equal((await call(new Request(BASE + '/nope'))).status, 404);
  assert.equal((await call(new Request(BASE + '/send'))).status, 404);   // GET /send
  assert.equal((await call(new Request(BASE + '/', { method: 'POST', body: '{}' }))).status, 404);
  assert.equal(calls.length, 0);
});

test('requests with an Origin header are refused with 403, even with the right secret', async (t) => {
  const calls = stubFetch(t);
  const { subscription } = makeSubscription(APPLE);
  const res = await call(sendRequest({ messages: [message('m1', subscription)] }, { headers: { Origin: 'https://evil.example' } }));
  assert.equal(res.status, 403);
  assert.equal((await call(new Request(BASE + '/', { headers: { Origin: 'https://anyone.example' } }))).status, 403);
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- auth and config

test('auth: missing, malformed or wrong secrets get 401; an unset secret refuses everything', async (t) => {
  const calls = stubFetch(t);
  const { subscription } = makeSubscription(APPLE);
  const body = { messages: [message('m1', subscription)] };

  for (const auth of [null, SECRET, 'Basic ' + SECRET, 'Bearer ', 'Bearer wrong', 'Bearer ' + SECRET + 'x', 'Bearer ' + SECRET.slice(0, -1)]) {
    const res = await call(sendRequest(body, { auth }));
    assert.equal(res.status, 401, 'auth ' + JSON.stringify(auth));
    assert.deepEqual(res.json, { error: 'unauthorized' });
  }
  for (const env of [Object.assign({}, ENV, { PUSH_SECRET: undefined }), Object.assign({}, ENV, { PUSH_SECRET: '  ' })]) {
    const res = await call(sendRequest(body, { auth: 'Bearer ' }), env);
    assert.equal(res.status, 500);
    assert.equal(res.json.error, 'not_configured');
    assert.equal((await call(sendRequest(body, { auth: 'Bearer undefined' }), env)).status, 500);
  }
  assert.equal(calls.length, 0);
});

test('config: missing or invalid VAPID settings give 500 not_configured (after auth)', async (t) => {
  stubFetch(t);
  const { subscription } = makeSubscription(APPLE);
  const body = { messages: [message('m1', subscription)] };
  const cases = [
    { VAPID_PRIVATE_KEY: undefined },
    { VAPID_PUBLIC_KEY: 'REPLACE_WITH_VAPID_PUBLIC_KEY' },
    { VAPID_PRIVATE_KEY: makeVapidKeys().privateKey },     // not the matching private key
    { VAPID_SUBJECT: 'owner@example.com' },                // needs mailto: or https:
    { VAPID_SUBJECT: 'http://example.com' },
  ];
  for (const patch of cases) {
    const res = await call(sendRequest(body), Object.assign({}, ENV, patch));
    assert.equal(res.status, 500, JSON.stringify(patch));
    assert.equal(res.json.error, 'not_configured');
  }
  // Unauthenticated callers learn nothing about the VAPID config.
  assert.equal((await call(sendRequest(body, { auth: 'Bearer wrong' }), Object.assign({}, ENV, { VAPID_SUBJECT: 'x' }))).status, 401);
});

test('request validation: bad JSON, missing messages, more than 50 messages, oversized body', async (t) => {
  const calls = stubFetch(t);
  const { subscription } = makeSubscription(APPLE);
  assert.equal((await call(sendRequest('{nope'))).json.error, 'bad_json');
  assert.equal((await call(sendRequest({}))).json.error, 'bad_request');
  assert.equal((await call(sendRequest({ messages: {} }))).status, 400);
  const many = Array.from({ length: 51 }, (_, i) => message('m' + i, subscription));
  const tooMany = await call(sendRequest({ messages: many }));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.json.error, 'too_many_messages');
  assert.equal((await call(sendRequest({ messages: [], pad: 'x'.repeat(300 * 1024) }))).status, 413);
  assert.deepEqual((await call(sendRequest({ messages: [] }))).json, { results: [] });
  assert.equal(calls.length, 0);
});

// ---------------------------------------------------------------- delivery

test('delivers an encrypted message with the Web Push headers and a valid VAPID JWT', async (t) => {
  const calls = stubFetch(t);
  const sub = makeSubscription(APPLE);
  const res = await call(sendRequest({ messages: [message('m1', sub.subscription, { ttl: 3600, urgency: 'high' })] }));

  assert.equal(res.status, 200);
  assert.deepEqual(res.json, { results: [{ id: 'm1', status: 201, ok: true, gone: false }] });
  assert.equal(calls.length, 1);
  const { url, init } = calls[0];
  assert.equal(url, APPLE);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['TTL'], '3600');
  assert.equal(init.headers['Urgency'], 'high');
  assert.equal(init.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(init.headers['Content-Type'], 'application/octet-stream');
  assert.equal(init.redirect, 'manual', 'a redirect must not lead off the allowlist');

  const m = /^vapid t=([\w-]+\.[\w-]+\.[\w-]+), k=([\w-]+)$/.exec(init.headers['Authorization']);
  assert.ok(m, init.headers['Authorization']);
  assert.equal(m[2], VAPID.publicKey);
  const jwt = decodeJwt(m[1]);
  assert.equal(jwt.claims.aud, 'https://web.push.apple.com');
  assert.equal(jwt.claims.sub, ENV.VAPID_SUBJECT);
  const pt = fromB64u(VAPID.publicKey);
  const pub = createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64u(pt.subarray(1, 33)), y: b64u(pt.subarray(33)) }, format: 'jwk' });
  assert.ok(verify('sha256', Buffer.from(jwt.signingInput), { key: pub, dsaEncoding: 'ieee-p1363' }, jwt.signature));

  // The payload arrives wrapped as Declarative Web Push (docs/API.md › Push).
  const { plaintext } = sub.decrypt(init.body);
  assert.deepEqual(JSON.parse(plaintext.toString('utf8')), {
    web_push: 8030,
    notification: { title: PAYLOAD.title, body: PAYLOAD.body, navigate: PAYLOAD.url, tag: PAYLOAD.tag, data: { url: PAYLOAD.url } },
  });
});

test('TTL and Urgency default and clamp; one JWT per push service per request', async (t) => {
  const calls = stubFetch(t);
  const a = makeSubscription(APPLE), b = makeSubscription('https://web.push.apple.com/QFakeToken2');
  const f = makeSubscription('https://fcm.googleapis.com/fcm/send/fake-token');
  await call(sendRequest({ messages: [
    { id: 1, subscription: a.subscription, payload: PAYLOAD },
    { id: 2, subscription: b.subscription, payload: PAYLOAD, ttl: 999999999, urgency: 'urgent!' },
    { id: 3, subscription: f.subscription, payload: PAYLOAD, ttl: -5 },
    { id: 4, subscription: makeSubscription('https://web.push.apple.com/QFakeToken3').subscription, payload: PAYLOAD, ttl: 0 },
  ] }));
  assert.equal(calls.length, 4);
  const byUrl = Object.fromEntries(calls.map((c) => [c.url, c.init.headers]));
  assert.equal(byUrl[APPLE]['TTL'], '86400');
  assert.equal(byUrl[APPLE]['Urgency'], 'normal');
  assert.equal(byUrl['https://web.push.apple.com/QFakeToken2']['TTL'], String(28 * 86400));
  assert.equal(byUrl['https://web.push.apple.com/QFakeToken2']['Urgency'], 'normal');
  // Apple rejects TTL 0 ("BadTtl: isn't a positive number"), so the floor is 1 second.
  assert.equal(byUrl['https://fcm.googleapis.com/fcm/send/fake-token']['TTL'], '1');
  assert.equal(byUrl['https://web.push.apple.com/QFakeToken3']['TTL'], '1');
  assert.equal(byUrl[APPLE]['Authorization'], byUrl['https://web.push.apple.com/QFakeToken2']['Authorization']);
  const fcmJwt = decodeJwt(/t=([^,]+)/.exec(byUrl['https://fcm.googleapis.com/fcm/send/fake-token']['Authorization'])[1]);
  assert.equal(fcmJwt.claims.aud, 'https://fcm.googleapis.com');
});

test('endpoint allowlist: only https on known push services is contacted', async (t) => {
  const calls = stubFetch(t);
  const allowed = [
    'https://web.push.apple.com/QFake',
    'https://api.push.apple.com/3/device/fake',
    'https://fcm.googleapis.com/fcm/send/fake',
    'https://updates.push.services.mozilla.com/wpush/v2/fake',
    'https://wns2-by3p.notify.windows.com/w/?token=fake',
    'https://WEB.PUSH.APPLE.COM/QUpperCase',
  ];
  const refused = [
    'http://web.push.apple.com/QFake',                   // not https
    'https://evil.example/web.push.apple.com',
    'https://web.push.apple.com.evil.example/QFake',
    'https://evilpush.apple.com/QFake',                 // suffix must include the dot
    'https://push.apple.com/QFake',                     // bare domain isn't a push host
    'https://notify.windows.com.evil.example/x',
    'https://fcm.googleapis.com:8443/fcm/send/fake',     // non-default port
    'https://user:pw@fcm.googleapis.com/fcm/send/fake',
    'https://googleapis.com/fcm/send/fake',
    'not a url',
    '',
    'https://fcm.googleapis.com/' + 'x'.repeat(3000),
  ];
  const subs = [...allowed, ...refused].map((e) => makeSubscription(e).subscription);
  subs.push({ keys: subs[0].keys });   // no endpoint at all
  const res = await call(sendRequest({ messages: subs.map((s, i) => message('m' + i, s)) }));

  assert.equal(res.status, 200);
  const results = res.json.results;
  assert.equal(results.length, subs.length);
  results.forEach((r, i) => assert.equal(r.id, 'm' + i, 'results keep message order'));
  for (let i = 0; i < allowed.length; i++) assert.equal(results[i].ok, true, allowed[i]);
  for (let i = allowed.length; i < results.length; i++) {
    assert.deepEqual(results[i], { id: 'm' + i, status: 0, ok: false, gone: false, error: 'endpoint_not_allowed', reason: null }, String(subs[i].endpoint));
  }
  assert.deepEqual(calls.map((c) => new URL(c.url).hostname).sort(), allowed.map((u) => new URL(u).hostname.toLowerCase()).sort());
});

test('push service responses: 404/410 are gone, other failures are not, and network errors are status 0', async (t) => {
  const statusFor = { '/s201': 201, '/s404': 404, '/s410': 410, '/s403': 403, '/s429': 429, '/s500': 500, '/s307': 307 };
  const calls = stubFetch(t, (url) => {
    const path = new URL(url).pathname;
    if (path === '/boom') throw new TypeError('fetch failed');
    const status = statusFor[path];
    const body = status === 403 ? '{"reason":"BadJwtToken"}' : status === 410 ? '{"reason": "Unregistered"}'
      : status === 500 ? 'Internal error, not JSON' : status >= 400 ? '' : null;
    const headers = status === 307 ? { Location: 'https://evil.example/' } : {};
    return new Response(body, { status, headers });
  });
  const paths = [...Object.keys(statusFor), '/boom'];
  const res = await call(sendRequest({ messages: paths.map((p) => message(p.slice(1), makeSubscription('https://web.push.apple.com' + p).subscription)) }));
  const byId = Object.fromEntries(res.json.results.map((r) => [r.id, r]));

  assert.deepEqual(byId.s201, { id: 's201', status: 201, ok: true, gone: false });
  assert.deepEqual(byId.s404, { id: 's404', status: 404, ok: false, gone: true, error: 'http_404', reason: null });
  assert.deepEqual(byId.s410, { id: 's410', status: 410, ok: false, gone: true, error: '{"reason": "Unregistered"}', reason: 'Unregistered' });
  // The raw text AND the parsed reason, so the API can tell a VAPID config error from a dead subscription.
  assert.deepEqual(byId.s403, { id: 's403', status: 403, ok: false, gone: false, error: '{"reason":"BadJwtToken"}', reason: 'BadJwtToken' });
  assert.equal(byId.s429.gone, false);
  assert.deepEqual(byId.s500, { id: 's500', status: 500, ok: false, gone: false, error: 'Internal error, not JSON', reason: null });
  assert.deepEqual(byId.s307, { id: 's307', status: 307, ok: false, gone: false, error: 'http_307', reason: null });   // not followed
  assert.deepEqual(byId.boom, { id: 'boom', status: 0, ok: false, gone: false, error: 'network', reason: null });
  assert.equal(calls.length, paths.length);
});

test('bad subscriptions and payloads are reported per message without failing the batch', async (t) => {
  const calls = stubFetch(t);
  const good = makeSubscription(APPLE);
  const res = await call(sendRequest({ messages: [
    message('noKeys', { endpoint: APPLE }),
    message('badAuth', { endpoint: APPLE, keys: { p256dh: good.subscription.keys.p256dh, auth: 'AAAA' } }),
    message('noTitle', good.subscription, { payload: { body: 'x' } }),
    'not an object',
    message('good', good.subscription),
  ] }));
  assert.deepEqual(res.json.results.map((r) => [r.id, r.error || 'ok']), [
    ['noKeys', 'bad_subscription'], ['badAuth', 'bad_subscription'], ['noTitle', 'bad_payload'],
    [null, 'bad_message'], ['good', 'ok'],
  ]);
  assert.equal(calls.length, 1);
});

test('long payloads are truncated to fit 3000 bytes before encryption', async (t) => {
  const calls = stubFetch(t);
  const sub = makeSubscription(APPLE);
  const long = 'Declined at last visit: ' + 'front brake pads and rotors, '.repeat(200);
  await call(sendRequest({ messages: [message('m1', sub.subscription, { payload: Object.assign({}, PAYLOAD, { body: long }) })] }));
  const { plaintext } = sub.decrypt(calls[0].init.body);
  assert.ok(plaintext.length <= 3000);
  const out = JSON.parse(plaintext.toString('utf8')).notification;
  assert.ok(out.body.endsWith('…'));
  assert.equal(out.title, PAYLOAD.title);
  assert.equal(out.navigate, PAYLOAD.url);
});

test('payload url must be an absolute https URL; anything else is refused before sending', async (t) => {
  const calls = stubFetch(t);
  const sub = makeSubscription(APPLE);
  const bad = ['#/v/X7', '/VehicleTracker/#/v/X7', 'http://example.github.io/VehicleTracker/', 'javascript:alert(1)',
    'https://user:pw@example.github.io/', 'https://example.github.io/a b', '', undefined, 42];
  const res = await call(sendRequest({ messages: [
    ...bad.map((url, i) => message('bad' + i, sub.subscription, { payload: Object.assign({}, PAYLOAD, { url }) })),
    message('noPayload', sub.subscription, { payload: undefined }),
    message('good', sub.subscription),
  ] }));
  const results = res.json.results;
  bad.forEach((url, i) => assert.deepEqual(results[i],
    { id: 'bad' + i, status: 0, ok: false, gone: false, error: 'bad_url', reason: null }, String(url)));
  assert.equal(results[bad.length].error, 'bad_payload');
  assert.deepEqual(results[bad.length + 1], { id: 'good', status: 201, ok: true, gone: false });
  assert.equal(calls.length, 1);
  const n = JSON.parse(sub.decrypt(calls[0].init.body).plaintext.toString('utf8')).notification;
  assert.equal(n.navigate, PAYLOAD.url);
  assert.equal(n.data.url, PAYLOAD.url);
});
