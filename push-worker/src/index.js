/**
 * Vehicles Push Worker (Cloudflare Workers, ES module syntax).
 *
 * The App API (Apps Script) decides what to send but can't do ES256 signing,
 * so it POSTs each batch here. For every message the Worker signs a VAPID
 * JWT, encrypts the payload (RFC 8291) and POSTs it to the phone's push
 * service. It is server-to-server only: no CORS, and browser requests (any
 * request with an Origin header) are refused.
 *
 *   GET  /      → {"ok":true,"service":"vehicles-push"}
 *   POST /send  → Authorization: Bearer <PUSH_SECRET>
 *                 {"messages":[...]} → {"results":[...]}
 *
 * Full contract: push-worker/README.md.
 *
 * env: VAPID_PUBLIC_KEY, VAPID_SUBJECT (plain vars, wrangler.toml);
 *      PUSH_SECRET, VAPID_PRIVATE_KEY (secrets, never in the repo).
 */
import {
  createVapidJwt, encryptPayload, fitPayload, importVapidKey, isAbsoluteHttpsUrl, parsePushReason, vapidAuthorization,
} from './webpush.js';

const SERVICE_NAME = 'vehicles-push';
const MAX_MESSAGES = 50;                 // also the free plan's subrequest limit
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_ENDPOINT_LENGTH = 2048;
const DEFAULT_TTL_SEC = 86400;
const MIN_TTL_SEC = 1;                   // Apple rejects TTL 0 (BadTtl: "isn't a positive number")
const MAX_TTL_SEC = 28 * 86400;          // push services cap TTL at about 4 weeks
const URGENCIES = ['very-low', 'low', 'normal', 'high'];
const PUSH_TIMEOUT_MS = 10000;
const MAX_ERROR_TEXT = 200;

/**
 * Push services the Worker will deliver to. Anything else is refused, so a
 * leaked secret can't turn the Worker into an open relay for arbitrary URLs.
 */
const PUSH_HOSTS = ['web.push.apple.com', 'fcm.googleapis.com', 'updates.push.services.mozilla.com'];
const PUSH_HOST_SUFFIXES = ['.push.apple.com', '.notify.windows.com'];

const encoder_ = new TextEncoder();

export default {
  async fetch(request, env) {
    try {
      return await route_(request, env || {});
    } catch (err) {
      console.error('push worker error', err && err.stack || err);
      return json_({ error: 'internal' }, 500);
    }
  },
};

async function route_(request, env) {
  // Browsers always send Origin on cross-site POSTs; Apps Script never does.
  if (request.headers.has('Origin')) return json_({ error: 'forbidden' }, 403);

  const path = new URL(request.url).pathname;
  if (path === '/' && request.method === 'GET') return json_({ ok: true, service: SERVICE_NAME });
  if (path === '/send' && request.method === 'POST') return handleSend_(request, env);
  return json_({ error: 'not_found' }, 404);
}

// ---------------------------------------------------------------- POST /send

async function handleSend_(request, env) {
  // Fail closed: with no secret set, nothing is sent.
  const secret = String(env.PUSH_SECRET || '').trim();
  if (!secret) return json_({ error: 'not_configured', detail: 'PUSH_SECRET is not set' }, 500);
  if (!(await isAuthorized_(request, secret))) return json_({ error: 'unauthorized' }, 401);

  const vapid = await loadVapid_(env);
  if (vapid.error) return json_({ error: 'not_configured', detail: vapid.error }, 500);

  if (Number(request.headers.get('Content-Length') || 0) > MAX_REQUEST_BYTES) {
    return json_({ error: 'too_large' }, 413);
  }
  const text = await request.text();
  if (encoder_.encode(text).length > MAX_REQUEST_BYTES) return json_({ error: 'too_large' }, 413);

  let body;
  try { body = JSON.parse(text); } catch (e) { return json_({ error: 'bad_json' }, 400); }
  const messages = body && body.messages;
  if (!Array.isArray(messages)) return json_({ error: 'bad_request', detail: 'messages must be an array' }, 400);
  if (messages.length > MAX_MESSAGES) {
    return json_({ error: 'too_many_messages', detail: 'at most ' + MAX_MESSAGES + ' messages per request' }, 400);
  }

  // In parallel; results come back in the same order as the messages.
  const results = await Promise.all(messages.map((m) => sendOne_(m, vapid)));
  return json_({ results });
}

/** Checks "Authorization: Bearer <secret>" without leaking the secret through timing. */
async function isAuthorized_(request, secret) {
  const m = /^Bearer\s+(.+?)\s*$/i.exec(request.headers.get('Authorization') || '');
  if (!m) return false;
  return timingSafeEqual_(m[1], secret);
}

/**
 * Constant-time string comparison. Comparing SHA-256 digests means neither
 * the secret's content nor its length affects how long the check takes.
 */
async function timingSafeEqual_(a, b) {
  const [da, db] = await Promise.all([a, b].map((s) => crypto.subtle.digest('SHA-256', encoder_.encode(s))));
  const x = new Uint8Array(da), y = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i];
  return diff === 0;
}

/**
 * Reads and checks the VAPID settings once per request.
 * @return {Promise<{error?: string, key?: CryptoKey, publicKey?: string, subject?: string, authByOrigin?: Map}>}
 */
async function loadVapid_(env) {
  const missing = ['VAPID_PUBLIC_KEY', 'VAPID_PRIVATE_KEY', 'VAPID_SUBJECT'].filter((k) => !env[k]);
  if (missing.length) return { error: missing.join(', ') + ' not set' };
  const subject = String(env.VAPID_SUBJECT).trim();
  if (!/^(mailto:|https:)/.test(subject)) return { error: 'VAPID_SUBJECT must start with mailto: or https:' };
  try {
    const key = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    // One JWT per push service origin per request: most messages go to
    // web.push.apple.com, and signing is the costly step on the free plan.
    return { key, publicKey: env.VAPID_PUBLIC_KEY, subject, authByOrigin: new Map() };
  } catch (e) {
    return { error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not a valid P-256 key pair (base64url)' };
  }
}

function vapidHeader_(vapid, audience) {
  if (!vapid.authByOrigin.has(audience)) {
    vapid.authByOrigin.set(audience, createVapidJwt(vapid.key, { audience, subject: vapid.subject })
      .then((jwt) => vapidAuthorization(jwt, vapid.publicKey)));
  }
  return vapid.authByOrigin.get(audience);
}

/**
 * Encrypts and delivers one message. Never throws.
 * @return {Promise<{id, status: number, ok: boolean, gone: boolean, error?: string, reason?: string|null}>}
 *   status is the push service's HTTP status, or 0 when nothing was sent.
 *   error and reason are only on failures; reason is the push service's
 *   JSON "reason" (Apple: BadJwtToken, VapidPkHashMismatch, ...) or null.
 */
async function sendOne_(msg, vapid) {
  const id = msg && msg.id !== undefined ? msg.id : null;
  const notSent = (error) => ({ id, status: 0, ok: false, gone: false, error, reason: null });
  if (!msg || typeof msg !== 'object') return notSent('bad_message');

  const sub = msg.subscription || {};
  const endpoint = allowedEndpoint_(sub.endpoint);
  if (!endpoint) return notSent('endpoint_not_allowed');
  const payload = fitPayload(msg.payload);
  if (!payload) return notSent('bad_payload');
  // Declarative Web Push needs an absolute navigate URL; never send anything else.
  if (!isAbsoluteHttpsUrl(msg.payload.url)) return notSent('bad_url');

  let body, authorization;
  try {
    body = await encryptPayload(payload, sub.keys || {});
  } catch (e) {
    return notSent('bad_subscription');   // p256dh/auth missing or not valid keys
  }
  try {
    authorization = await vapidHeader_(vapid, endpoint.origin);
  } catch (e) {
    return notSent('vapid_failed');
  }

  let res;
  try {
    res = await fetch(endpoint.href, {
      method: 'POST',
      headers: {
        'TTL': String(ttl_(msg.ttl)),
        'Urgency': URGENCIES.includes(msg.urgency) ? msg.urgency : 'normal',
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'Authorization': authorization,
      },
      body,
      // Never follow a redirect: it could lead off the allowlist. A 3xx is
      // reported back like any other failure.
      redirect: 'manual',
      signal: timeoutSignal_(),
    });
  } catch (e) {
    return notSent(e && e.name === 'TimeoutError' ? 'timeout' : 'network');
  }

  const status = res.status;
  const result = { id, status, ok: status >= 200 && status < 300, gone: status === 404 || status === 410 };
  if (result.ok) {
    await discardBody_(res);
  } else {
    // Keep the push service's text (Apple sends e.g. {"reason":"BadJwtToken"}) for Andrew's log,
    // and its reason on its own so the API can tell a config error from a dead subscription.
    const text = await readText_(res);
    result.error = text.replace(/\s+/g, ' ').slice(0, MAX_ERROR_TEXT) || 'http_' + status;
    result.reason = parsePushReason(text);
  }
  return result;
}

/** Returns the endpoint as a URL if it's https on a known push service, else null. */
function allowedEndpoint_(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT_LENGTH) return null;
  let url;
  try { url = new URL(endpoint); } catch (e) { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname;   // already lower-cased by URL
  const known = PUSH_HOSTS.includes(host) || PUSH_HOST_SUFFIXES.some((s) => host.endsWith(s));
  return known ? url : null;
}

/** TTL in whole seconds, 1 second to 28 days (Apple rejects 0); defaults to one day. */
function ttl_(value) {
  const n = Number(value);
  if (value === undefined || value === null || value === '' || !isFinite(n)) return DEFAULT_TTL_SEC;
  return Math.min(MAX_TTL_SEC, Math.max(MIN_TTL_SEC, Math.floor(n)));
}

function timeoutSignal_() {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(PUSH_TIMEOUT_MS) : undefined;
}

async function readText_(res) {
  try { return (await res.text()).trim(); } catch (e) { return ''; }
}

async function discardBody_(res) {
  try { if (res.body) await res.body.cancel(); } catch (e) { /* nothing to free */ }
}

function json_(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
