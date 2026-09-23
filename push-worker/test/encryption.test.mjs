import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH } from 'node:crypto';
import {
  b64urlDecode, b64urlEncode, encryptPayload, fitPayload, importSenderKeys, MAX_PAYLOAD_BYTES,
} from '../src/webpush.js';
import { b64u, decrypt, fromB64u, makeSubscription } from './helpers.mjs';

/**
 * RFC 8291 section 5 ("Push Message Encryption Example") and Appendix A.
 * Line-wrapped values from the RFC are joined here.
 */
const RFC = {
  plaintext: 'When I grow up, I want to be a watermelon',
  authSecret: 'BTBZMqHH6r4Tts7J_aSIgg',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  receiverPrivate: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  receiverPublic: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  senderPrivate: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  senderPublic: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  body:
    'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml' +
    'mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPT' +
    'pK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

test('RFC 8291 example: fixed salt and sender keys reproduce the published message body', async () => {
  const senderKeys = await importSenderKeys(RFC.senderPublic, RFC.senderPrivate);
  const body = await encryptPayload(RFC.plaintext, { p256dh: RFC.receiverPublic, auth: RFC.authSecret }, {
    salt: b64urlDecode(RFC.salt),
    senderKeys,
  });
  assert.equal(b64urlEncode(body), RFC.body);
  // 86 header + 41 plaintext + 1 delimiter + 16 tag. (The example's
  // "Content-Length: 145" header is one more than the body it shows.)
  assert.equal(body.length, 144);
});

test('RFC 8291 example: the test decryptor recovers the plaintext (checks the checker)', () => {
  const out = decrypt(fromB64u(RFC.body), {
    privateKey: fromB64u(RFC.receiverPrivate),
    publicKey: fromB64u(RFC.receiverPublic),
    auth: fromB64u(RFC.authSecret),
  });
  assert.equal(out.plaintext.toString('utf8'), RFC.plaintext);
  assert.equal(out.rs, 4096);
});

test('round trip: random salt and a fresh sender key per message, decrypted with node:crypto', async () => {
  const { subscription, decrypt: open } = makeSubscription('https://web.push.apple.com/QExample');
  const text = JSON.stringify({ title: '4Runner', body: 'Tire rotation due in 2 weeks — or at 40,000 mi 🚗', url: '#/v/1', tag: 't' });

  const a = await encryptPayload(text, subscription.keys);
  const b = await encryptPayload(text, subscription.keys);
  for (const body of [a, b]) {
    const out = open(body);
    assert.equal(out.plaintext.toString('utf8'), text);
    assert.equal(out.rs, 4096);
    assert.equal(out.keyid.length, 65);
    assert.equal(out.keyid[0], 0x04);
    // header 86 + plaintext + delimiter 1 + tag 16
    assert.equal(body.length, 86 + Buffer.byteLength(text) + 1 + 16);
  }
  assert.notDeepEqual(a.subarray(0, 16), b.subarray(0, 16), 'salt must differ per message');
  assert.notDeepEqual(a.subarray(21, 86), b.subarray(21, 86), 'sender key must differ per message');
});

test('encryptPayload rejects bad subscription keys and oversized plaintext', async () => {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const p256dh = b64u(ua.getPublicKey());
  const auth = b64u(Buffer.alloc(16, 7));
  await assert.rejects(encryptPayload('x', { p256dh, auth: b64u(Buffer.alloc(12)) }), /auth secret/);
  await assert.rejects(encryptPayload('x', { p256dh: b64u(Buffer.alloc(65, 4)), auth }));       // not on the curve
  await assert.rejects(encryptPayload('x', { p256dh: 'not base64!', auth }), /base64url/);
  await assert.rejects(encryptPayload('x', { auth }));
  await assert.rejects(encryptPayload('x'.repeat(3994), { p256dh, auth }), /too large/);
  assert.ok(await encryptPayload('x'.repeat(3993), { p256dh, auth }));
});

test('base64url helpers accept base64url and padded standard base64', () => {
  const bytes = Uint8Array.from([251, 255, 191, 0, 1, 2]);
  assert.equal(b64urlEncode(bytes), '-_-_AAEC');
  assert.deepEqual(b64urlDecode('-_-_AAEC'), bytes);
  assert.deepEqual(b64urlDecode('+/+/AAEC'), bytes);
  assert.deepEqual(b64urlDecode('AAE=\n'), Uint8Array.from([0, 1]));
  assert.throws(() => b64urlDecode('A'), /Invalid/);
});

/** The Declarative Web Push message fitPayload should produce for {title, body, url, tag}. */
const declarative = ({ title, body, url, tag }) => ({ web_push: 8030, notification: { title, body, navigate: url, tag, data: { url } } });

test('fitPayload wraps {title, body, url, tag} as Declarative Web Push and drops other fields', () => {
  const url = 'https://example.github.io/VehicleTracker/#/v/2023%20Toyota%204Runner';
  // Exact text: key order matters to nobody, but this pins the whole shape (docs/API.md › Push).
  assert.equal(
    fitPayload({ title: 'Highlander', body: 'Oil change is overdue', url, tag: 'x', extra: 'dropped' }),
    '{"web_push":8030,"notification":{"title":"Highlander","body":"Oil change is overdue",' +
      '"navigate":"' + url + '","tag":"x","data":{"url":"' + url + '"}}}',
  );
  assert.deepEqual(JSON.parse(fitPayload({ title: 'Hi' })), declarative({ title: 'Hi', body: '', url: '', tag: '' }));
});

test('fitPayload shortens body, then title, so the wrapped JSON stays within 3000 bytes', () => {
  // Multi-byte characters: never split a code point, always fit.
  const url = 'https://example.github.io/VehicleTracker/#/v/X7';
  const long = '🚗 Wiper blades ' + 'é'.repeat(4000);
  const json = fitPayload({ title: 'X7', body: long, url, tag: 't' });
  const out = JSON.parse(json).notification;
  assert.ok(Buffer.byteLength(json) <= MAX_PAYLOAD_BYTES);
  assert.ok(Buffer.byteLength(json) > MAX_PAYLOAD_BYTES - 4, 'uses nearly all the room');
  assert.ok(out.body.endsWith('…'));
  assert.ok(long.startsWith(out.body.slice(0, -1)));
  assert.equal(out.title, 'X7');
  assert.equal(out.navigate, url);
  assert.equal(out.data.url, url);

  // The URL is in the message twice (navigate and data.url), and both count.
  const longUrl = 'https://example.github.io/VehicleTracker/#/v/' + 'u'.repeat(1200);
  const twice = fitPayload({ title: 'X7', body: 'b'.repeat(2000), url: longUrl, tag: 't' });
  assert.ok(Buffer.byteLength(twice) <= MAX_PAYLOAD_BYTES);
  assert.equal(JSON.parse(twice).notification.navigate, longUrl);
  assert.ok(JSON.parse(twice).notification.body.endsWith('…'));

  // A huge title is shortened once the body is gone.
  const t = JSON.parse(fitPayload({ title: 'T'.repeat(5000), body: 'b'.repeat(5000), url: '#/', tag: '' })).notification;
  assert.equal(t.body, '');
  assert.ok(t.title.endsWith('…'));

  assert.equal(fitPayload({ body: 'no title' }), null);
  assert.equal(fitPayload(null), null);
  assert.equal(fitPayload({ title: 'x', url: 'u'.repeat(1600) }), null);   // 3,200 bytes of URL alone
});
