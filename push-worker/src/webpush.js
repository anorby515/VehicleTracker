/**
 * Web Push helpers for the Push Worker:
 *   - VAPID authorization (RFC 8292): an ES256-signed JWT per push service;
 *   - message encryption (RFC 8291) in the "aes128gcm" content coding
 *     (RFC 8188), always as one record;
 *   - building the notification payload (Declarative Web Push JSON) under
 *     the size limit.
 *
 * WebCrypto only, so the same code runs in Cloudflare Workers and in Node 22
 * (the tests). Nothing here touches the network; index.js does the fetch.
 *
 * Keys are passed around as base64url strings, the form the browser's
 * PushSubscription.toJSON() and `web-push generate-vapid-keys` both use.
 */

/** Payload JSON limit. Leaves room under the 3,993-byte RFC 8291 ceiling. */
export const MAX_PAYLOAD_BYTES = 3000;

/** VAPID JWT lifetime. Push services reject tokens that live more than 24 hours. */
export const VAPID_TTL_SEC = 12 * 3600;

const RECORD_SIZE = 4096;       // rs in the aes128gcm header
const POINT_BYTES = 65;         // uncompressed P-256 point: 0x04 || x || y
const AUTH_SECRET_BYTES = 16;
const SALT_BYTES = 16;
const TAG_BYTES = 16;           // AES-GCM authentication tag
const HEADER_BYTES = SALT_BYTES + 4 + 1 + POINT_BYTES;              // 86
const MAX_PLAINTEXT_BYTES = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1; // 3993
const LAST_RECORD_DELIMITER = 0x02;
const ELLIPSIS = '\u2026';   // …
const DECLARATIVE_WEB_PUSH = 8030;       // the "web_push" marker iOS looks for (Declarative Web Push)

const utf8_ = new TextEncoder();
const P256_ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const P256_ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };

// ---------------------------------------------------------------- base64url

/** Bytes → base64url without padding. */
export function b64urlEncode(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u8.length; i += 0x8000) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** base64url (or plain base64, padded or not, with stray whitespace) → bytes. Throws if malformed. */
export function b64urlDecode(str) {
  const s = String(str).replace(/\s+/g, '').replace(/=+$/, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*$/.test(s) || s.length % 4 === 1) throw new Error('Invalid base64url string');
  const bin = atob(s + '='.repeat((4 - s.length % 4) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat_(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// ---------------------------------------------------------------- keys

/** Decodes a base64url uncompressed P-256 public key and checks its shape. */
export function decodePublicKey(b64) {
  const bytes = b64urlDecode(b64);
  if (bytes.length !== POINT_BYTES || bytes[0] !== 0x04) {
    throw new Error('Expected a 65-byte uncompressed P-256 public key');
  }
  return bytes;
}

/**
 * WebCrypto can't import a bare private scalar, so this builds a JWK from
 * d plus the x/y coordinates of the matching public key.
 */
function privateJwk_(publicB64, privateB64) {
  const pub = decodePublicKey(publicB64);
  const raw = b64urlDecode(privateB64);
  if (raw.length < 1 || raw.length > 32) throw new Error('Expected a 32-byte P-256 private key');
  // Some generators drop leading zero bytes (about 1 key in 256); restore them.
  const d = new Uint8Array(32);
  d.set(raw, 32 - raw.length);
  return {
    kty: 'EC', crv: 'P-256', ext: false,
    x: b64urlEncode(pub.subarray(1, 33)),
    y: b64urlEncode(pub.subarray(33, 65)),
    d: b64urlEncode(d),
  };
}

/** Imports the VAPID key pair (env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY) as an ES256 signing key. */
export async function importVapidKey(publicB64, privateB64) {
  return crypto.subtle.importKey('jwk', privateJwk_(publicB64, privateB64), P256_ECDSA, false, ['sign']);
}

/**
 * Imports a fixed ECDH key pair to use as the sender key in encryptPayload.
 * Only the tests need this (to reproduce the RFC 8291 example); real sends
 * generate a fresh pair per message.
 * @return {Promise<{publicKey: Uint8Array, privateKey: CryptoKey}>}
 */
export async function importSenderKeys(publicB64, privateB64) {
  const privateKey = await crypto.subtle.importKey('jwk', privateJwk_(publicB64, privateB64), P256_ECDH, false, ['deriveBits']);
  return { publicKey: decodePublicKey(publicB64), privateKey };
}

async function generateSenderKeys_() {
  const pair = await crypto.subtle.generateKey(P256_ECDH, true, ['deriveBits']);
  const publicKey = new Uint8Array(await crypto.subtle.exportKey('raw', pair.publicKey));
  return { publicKey, privateKey: pair.privateKey };
}

// ---------------------------------------------------------------- VAPID (RFC 8292)

/**
 * Builds a VAPID JWT for one push service.
 * @param {CryptoKey} signingKey  from importVapidKey
 * @param {{audience: string, subject: string, now?: number, ttlSec?: number}} claims
 *   audience = the push endpoint's origin; subject = "mailto:..." or "https://..."
 * @return {Promise<string>} header.claims.signature
 */
export async function createVapidJwt(signingKey, { audience, subject, now = Date.now(), ttlSec = VAPID_TTL_SEC }) {
  const header = { typ: 'JWT', alg: 'ES256' };
  const claims = { aud: audience, exp: Math.floor(now / 1000) + ttlSec, sub: subject };
  const signingInput = b64urlEncode(utf8_.encode(JSON.stringify(header))) + '.' +
    b64urlEncode(utf8_.encode(JSON.stringify(claims)));
  // WebCrypto's ECDSA output is already the 64-byte r || s form JWS wants.
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, signingKey, utf8_.encode(signingInput));
  return signingInput + '.' + b64urlEncode(new Uint8Array(sig));
}

/** The Authorization header value: "vapid t=<jwt>, k=<public key>". */
export function vapidAuthorization(jwt, publicB64) {
  return 'vapid t=' + jwt + ', k=' + b64urlEncode(decodePublicKey(publicB64));
}

// ---------------------------------------------------------------- encryption (RFC 8291 / RFC 8188)

/** HKDF-SHA-256 (extract + expand) via WebCrypto. */
async function hkdf_(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

/**
 * Encrypts one push message for a subscription, as a single aes128gcm record.
 *
 * @param {string|Uint8Array} plaintext  at most 3,993 bytes
 * @param {{p256dh: string, auth: string}} keys  the subscription's keys (base64url)
 * @param {{salt?: Uint8Array, senderKeys?: {publicKey: Uint8Array, privateKey: CryptoKey}}} [opts]
 *   Tests inject a fixed salt and sender key pair; normally both are new for every message.
 * @return {Promise<Uint8Array>} the request body: header (salt, rs, keyid) || ciphertext
 */
export async function encryptPayload(plaintext, keys, opts = {}) {
  const data = typeof plaintext === 'string' ? utf8_.encode(plaintext) : plaintext;
  if (data.length > MAX_PLAINTEXT_BYTES) throw new Error('Push payload too large');

  const uaPublic = decodePublicKey(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (authSecret.length !== AUTH_SECRET_BYTES) throw new Error('Expected a 16-byte auth secret');

  const salt = opts.salt || crypto.getRandomValues(new Uint8Array(SALT_BYTES));
  if (salt.length !== SALT_BYTES) throw new Error('Expected a 16-byte salt');
  const sender = opts.senderKeys || await generateSenderKeys_();

  // ecdh_secret = ECDH(as_private, ua_public)
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, P256_ECDH, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, sender.privateKey, 256));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat_(utf8_.encode('WebPush: info\0'), uaPublic, sender.publicKey);
  const ikm = await hkdf_(authSecret, ecdhSecret, keyInfo, 32);

  // CEK and NONCE come from the salt and IKM (RFC 8188 section 2.2 / 2.3).
  const cek = await hkdf_(salt, ikm, utf8_.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf_(salt, ikm, utf8_.encode('Content-Encoding: nonce\0'), 12);

  // One record: plaintext, then the 0x02 "last record" delimiter, no extra padding.
  const record = concat_(data, new Uint8Array([LAST_RECORD_DELIMITER]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, tagLength: 128 }, aesKey, record));

  // Header: salt (16) || rs (uint32 big-endian) || idlen (1) || keyid (sender public key, 65).
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(SALT_BYTES, RECORD_SIZE);
  header[SALT_BYTES + 4] = POINT_BYTES;
  header.set(sender.publicKey, SALT_BYTES + 5);
  return concat_(header, ciphertext);
}

// ---------------------------------------------------------------- payload

/**
 * Builds the push message from the API's payload ({title, body, url, tag},
 * PushPayload in web/src/api/types.ts), wrapped as a Declarative Web Push
 * message (docs/API.md › Push):
 *
 *   {"web_push":8030,"notification":{"title","body","navigate":url,"tag","data":{"url":url}}}
 *
 * iOS 18.4+ shows it without running the service worker; older iOS hands the
 * same JSON to the service worker. Other payload fields are dropped. The JSON
 * is at most maxBytes (UTF-8): when it's too long, the body is shortened with
 * an ellipsis; if the body alone can't make it fit, the title is shortened too.
 *
 * @return {string|null} the JSON, or null when the payload is invalid (no
 *   title) or can't fit even with an empty body and title
 */
export function fitPayload(payload, maxBytes = MAX_PAYLOAD_BYTES) {
  if (!payload || typeof payload !== 'object') return null;
  const str = (v) => (v === undefined || v === null ? '' : String(v));
  const p = { title: str(payload.title), body: str(payload.body), url: str(payload.url), tag: str(payload.tag) };
  if (!p.title.trim()) return null;

  const fits = (obj) => utf8_.encode(declarativeJson_(obj)).length <= maxBytes;
  if (fits(p)) return declarativeJson_(p);

  const shorterBody = shorten_(p, 'body', fits);
  if (shorterBody) return declarativeJson_(shorterBody);
  const shorterTitle = shorten_(Object.assign({}, p, { body: '' }), 'title', fits);
  return shorterTitle && shorterTitle.title ? declarativeJson_(shorterTitle) : null;
}

/**
 * True for an absolute https URL without credentials, the only kind the
 * Worker sends as `navigate`. WebKit parses Declarative Web Push's navigate
 * with no base URL, so a relative one (e.g. "#/v/X7") would be dropped, and
 * http or javascript: must never reach a phone.
 */
export function isAbsoluteHttpsUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 2048 || /\s/.test(value)) return false;
  let url;
  try { url = new URL(value); } catch (e) { return false; }
  return url.protocol === 'https:' && !!url.hostname && !url.username && !url.password;
}

/**
 * The reason string from a push service's JSON error body, e.g. Apple's
 * {"reason":"BadJwtToken"} → "BadJwtToken"; null when there isn't one.
 */
export function parsePushReason(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const body = JSON.parse(text);
    const reason = body && typeof body === 'object' ? body.reason : null;
    return typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 100) : null;
  } catch (e) {
    return null;
  }
}

/** {title, body, url, tag} → the Declarative Web Push JSON text. */
function declarativeJson_(p) {
  return JSON.stringify({
    web_push: DECLARATIVE_WEB_PUSH,
    notification: { title: p.title, body: p.body, navigate: p.url, tag: p.tag, data: { url: p.url } },
  });
}

/**
 * Keeps the longest prefix of obj[field] (whole code points, plus an
 * ellipsis) for which fits() holds. Binary search, since the Worker has a
 * small CPU budget. Returns null if even an empty field doesn't fit.
 */
function shorten_(obj, field, fits) {
  const chars = Array.from(obj[field]);
  const withPrefix = (k) => Object.assign({}, obj, { [field]: k > 0 ? chars.slice(0, k).join('').trimEnd() + ELLIPSIS : '' });
  if (!fits(withPrefix(0))) return null;
  let lo = 0, hi = chars.length - 1;      // the full field is already known not to fit
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(withPrefix(mid))) lo = mid; else hi = mid - 1;
  }
  return withPrefix(lo);
}
