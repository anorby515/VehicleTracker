/**
 * Test helpers. The decryptor and key generators use node:crypto rather than
 * WebCrypto, so they check src/webpush.js against an independent
 * implementation instead of against itself.
 */
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync } from 'node:crypto';

export const b64u = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64u = (s) => Buffer.from(String(s).replace(/\s+/g, ''), 'base64url');

/**
 * A fake browser subscription with real receiver keys (like the ones the
 * phone creates), plus a decrypt() for bodies sent to it.
 */
export function makeSubscription(endpoint) {
  const ua = createECDH('prime256v1');
  ua.generateKeys();
  const auth = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + 11) & 0xff));
  return {
    subscription: { endpoint, keys: { p256dh: b64u(ua.getPublicKey()), auth: b64u(auth) } },
    decrypt: (body) => decrypt(body, { privateKey: ua.getPrivateKey(), publicKey: ua.getPublicKey(), auth }),
  };
}

/**
 * Decrypts an RFC 8291 push message body (single aes128gcm record).
 * @return {{plaintext: Buffer, salt: Buffer, rs: number, keyid: Buffer}}
 */
export function decrypt(body, { privateKey, publicKey, auth }) {
  const buf = Buffer.from(body);
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  const keyid = buf.subarray(21, 21 + idlen);
  const ciphertext = buf.subarray(21 + idlen);

  const ecdh = createECDH('prime256v1');
  ecdh.setPrivateKey(privateKey);
  const ecdhSecret = ecdh.computeSecret(keyid);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), publicKey, keyid]);
  const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, auth, keyInfo, 32));
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
  const record = Buffer.concat([decipher.update(ciphertext.subarray(0, ciphertext.length - 16)), decipher.final()]);

  // Strip padding: zeros, then the 0x02 last-record delimiter.
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  assert.equal(record[end], 0x02, 'padding delimiter must be 0x02');
  return { plaintext: record.subarray(0, end), salt, rs, keyid };
}

/**
 * A VAPID key pair in the same form `web-push generate-vapid-keys` prints
 * (it uses createECDH too): base64url 65-byte public point, 32-byte private.
 */
export function makeVapidKeys() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64u(ecdh.getPublicKey()), privateKey: b64u(ecdh.getPrivateKey()) };
}

/** Decodes a JWT without verifying it. */
export function decodeJwt(jwt) {
  const [h, c, s] = jwt.split('.');
  return { header: JSON.parse(fromB64u(h)), claims: JSON.parse(fromB64u(c)), signature: fromB64u(s), signingInput: h + '.' + c };
}
