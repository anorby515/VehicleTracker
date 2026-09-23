import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, createPublicKey, verify } from 'node:crypto';
import { createVapidJwt, importVapidKey, vapidAuthorization, VAPID_TTL_SEC } from '../src/webpush.js';
import { b64u, decodeJwt, fromB64u, makeVapidKeys } from './helpers.mjs';

/** node:crypto public key from a base64url uncompressed point. */
function nodePublicKey(publicB64) {
  const pt = fromB64u(publicB64);
  return createPublicKey({
    key: { kty: 'EC', crv: 'P-256', x: b64u(pt.subarray(1, 33)), y: b64u(pt.subarray(33, 65)) },
    format: 'jwk',
  });
}

test('VAPID JWT is ES256, verifies with the public key, and carries aud/exp/sub', async () => {
  const keys = makeVapidKeys();
  const key = await importVapidKey(keys.publicKey, keys.privateKey);
  const now = Date.UTC(2026, 8, 23, 12, 0, 0);
  const jwt = await createVapidJwt(key, { audience: 'https://web.push.apple.com', subject: 'mailto:owner@example.com', now });

  const { header, claims, signature, signingInput } = decodeJwt(jwt);
  assert.deepEqual(header, { typ: 'JWT', alg: 'ES256' });
  assert.deepEqual(claims, { aud: 'https://web.push.apple.com', exp: now / 1000 + 12 * 3600, sub: 'mailto:owner@example.com' });
  assert.equal(VAPID_TTL_SEC, 43200);
  assert.equal(signature.length, 64, 'JWS ES256 signature is raw r || s');
  assert.ok(verify('sha256', Buffer.from(signingInput), { key: nodePublicKey(keys.publicKey), dsaEncoding: 'ieee-p1363' }, signature));

  // A different key must not verify it.
  const other = makeVapidKeys();
  assert.equal(verify('sha256', Buffer.from(signingInput), { key: nodePublicKey(other.publicKey), dsaEncoding: 'ieee-p1363' }, signature), false);
});

test('exp defaults to 12 hours from the real clock', async () => {
  const keys = makeVapidKeys();
  const key = await importVapidKey(keys.publicKey, keys.privateKey);
  const before = Math.floor(Date.now() / 1000);
  const { claims } = decodeJwt(await createVapidJwt(key, { audience: 'https://fcm.googleapis.com', subject: 'https://example.com/' }));
  assert.ok(claims.exp >= before + 43200 && claims.exp <= before + 43202);
});

test('Authorization header is "vapid t=<jwt>, k=<public key>", with k normalised to base64url', async () => {
  const keys = makeVapidKeys();
  const padded = Buffer.from(fromB64u(keys.publicKey)).toString('base64');   // standard base64 with "="
  assert.equal(vapidAuthorization('a.b.c', padded), 'vapid t=a.b.c, k=' + keys.publicKey);
});

test('importVapidKey rejects malformed or mismatched keys', async () => {
  const a = makeVapidKeys(), b = makeVapidKeys();
  await assert.rejects(importVapidKey('REPLACE_WITH_VAPID_PUBLIC_KEY', a.privateKey));
  await assert.rejects(importVapidKey(a.publicKey, b64u(Buffer.alloc(33, 1))), /32-byte/);
  await assert.rejects(importVapidKey(a.publicKey, ''), /32-byte/);
  await assert.rejects(importVapidKey(a.publicKey, b.privateKey));   // Node checks d against x/y
});

test('a private key with its leading zero byte dropped (31 bytes) still imports and signs', async () => {
  // About 1 key in 256 has a leading zero; some generators print it as 31 bytes.
  let ecdh, d;
  const hasOneLeadingZero = (k) => k.length === 31 || (k.length === 32 && k[0] === 0 && k[1] !== 0);
  do { ecdh = createECDH('prime256v1'); ecdh.generateKeys(); d = ecdh.getPrivateKey(); } while (!hasOneLeadingZero(d));
  const short = d.length === 32 ? d.subarray(1) : d;
  assert.equal(short.length, 31);
  const publicKey = b64u(ecdh.getPublicKey());
  const key = await importVapidKey(publicKey, b64u(short));
  const { signature, signingInput } = decodeJwt(await createVapidJwt(key, { audience: 'https://web.push.apple.com', subject: 'mailto:owner@example.com' }));
  assert.ok(verify('sha256', Buffer.from(signingInput), { key: nodePublicKey(publicKey), dsaEncoding: 'ieee-p1363' }, signature));
});
