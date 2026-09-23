/**
 * Authentication (docs/API.md "Authentication").
 *
 * 1. signIn: the phone sends a Google ID token. verifyGoogleIdToken_() checks
 *    it with Google's tokeninfo endpoint plus every claim the spec lists, and
 *    the email must be an Active row on App Users.
 * 2. The API then issues its own session token, signed with HMAC-SHA256:
 *      v1.<base64url(JSON {e, i, x, n})>.<base64url(HMAC(SESSION_SECRET, "v1.<payload>"))>
 *    e = email, i = issued at (sec), x = expires at (sec), n = random nonce.
 * 3. requireUser_() runs on every other request: signature, expiry, and a
 *    fresh App Users check, so Active = No locks someone out immediately.
 * 4. Sign in with a code: a signed-in device calls pairCreate and gets an
 *    8-character code; the home-screen app redeems it once with pairRedeem.
 *
 * Errors are thrown as apiError_() objects (Api.js), which doPost turns into
 * {ok: false, status, error, message}. Tokens are never logged.
 *
 * No top-level references to Config.js constants here: Apps Script may load
 * this file before Config.js.
 */

const SESSION_VERSION_ = 'v1';

/** Pair-code alphabet: no 0/O, 1/I or L, so codes can be read aloud and typed. */
const PAIR_ALPHABET_ = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PAIR_CODE_LENGTH_ = 8;
const PAIR_OPEN_KEY_ = 'pair:open';        // cache: JSON {CODE: {email, exp, fails}}
const PAIR_FAILS_KEY_ = 'pair:fails';      // cache: JSON {since, n} for the global limit
const PAIR_LOCKOUT_KEY_ = 'pair:lockout';  // cache: present while redeeming is locked for everyone
const PAIR_MAX_OPEN_CODES_ = 20;

/**
 * Global limit on wrong codes, across ALL codes: per-code attempt limits alone
 * don't stop someone guessing at random. 30 wrong codes within 10 minutes
 * locks pairRedeem for everyone for 10 minutes.
 */
const PAIR_GLOBAL_MAX_FAILS_ = 30;
const PAIR_GLOBAL_WINDOW_SEC_ = 600;
const PAIR_LOCKOUT_SEC_ = 600;

const ID_TOKEN_CACHE_PREFIX_ = 'idtok:';

// ---------------------------------------------------------------- small helpers

function nowSec_() {
  return Math.floor(Date.now() / 1000);
}

/** base64url without '=' padding, from a string (UTF-8) or a byte array. */
function b64url_(data) {
  const s = Array.isArray(data)
    ? Utilities.base64EncodeWebSafe(data)
    : Utilities.base64EncodeWebSafe(String(data), Utilities.Charset.UTF_8);
  return s.replace(/=+$/, '');
}

/** base64url (padding optional) → UTF-8 string. Throws on bad input. */
function b64urlDecodeToString_(s) {
  const str = String(s);
  if (!/^[A-Za-z0-9_-]*$/.test(str)) throw new Error('bad base64url');
  const padded = str + '===='.slice(0, (4 - (str.length % 4)) % 4);
  return Utilities.newBlob(Utilities.base64DecodeWebSafe(padded)).getDataAsString();
}

/** SHA-256 of a string, as base64url (used for cache keys; never the token itself). */
function sha256Key_(s) {
  return b64url_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8));
}

/** Compares two strings in time that depends only on their length. */
function constantTimeEqual_(a, b) {
  a = String(a);
  b = String(b);
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** 32 unpredictable bytes (0..255). Apps Script has no CSPRNG API; UUIDs are random v4. */
function randomBytes_() {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
    Utilities.getUuid() + Utilities.getUuid(), Utilities.Charset.UTF_8);
  return digest.map(b => (b + 256) % 256);
}

function notFamilyMessage_() {
  return 'This app is for the ' + FAMILY_NAME + ' family.';
}

// ---------------------------------------------------------------- Google ID token (signIn)

/**
 * Verifies a Google ID token with tokeninfo and checks every claim. A token
 * that passed is cached (keyed by its SHA-256) until it expires, so a repeat
 * sign-in within the hour doesn't call Google again; the claim checks still
 * run on every call (a cached token can't be replayed with another nonce).
 *
 * @param {string} idToken
 * @param {string} [nonce] the nonce the app put in its OpenID request
 * @param {number} [nowSec]
 * @return {{email: string, name: string|null}}
 * @throws apiError_ 401 not_signed_in when the token isn't acceptable
 */
function verifyGoogleIdToken_(idToken, nonce, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  if (typeof idToken !== 'string' || !idToken) throw idTokenRejected_('missing token');
  const cache = CacheService.getScriptCache();
  const key = ID_TOKEN_CACHE_PREFIX_ + sha256Key_(idToken);

  let claims = null;
  const cached = cache.get(key);
  if (cached) {
    try { claims = JSON.parse(cached); } catch (e) { claims = null; }
  }
  if (!claims) {
    const res = UrlFetchApp.fetch(GOOGLE_TOKENINFO_URL + '?id_token=' + encodeURIComponent(idToken), {
      method: 'get',
      muteHttpExceptions: true,
    });
    const code = res.getResponseCode();
    if (code !== 200) throw idTokenRejected_('tokeninfo HTTP ' + code);
    try { claims = JSON.parse(res.getContentText()); } catch (e) { claims = null; }
    if (!claims || typeof claims !== 'object') throw idTokenRejected_('tokeninfo returned no claims');
    const problem = idTokenProblem_(claims, nonce, now);
    if (problem) throw idTokenRejected_(problem);
    const ttl = Math.min(Number(claims.exp) - now, 21600);
    if (ttl >= 1) {
      try { cache.put(key, JSON.stringify(claims), ttl); } catch (e) { /* best effort */ }
    }
  }
  const problem = idTokenProblem_(claims, nonce, now);
  if (problem) throw idTokenRejected_(problem);
  return { email: lower_(claims.email), name: asStr_(claims.name) };
}

/**
 * The reason a tokeninfo claim set is unacceptable, or null when it's fine.
 * tokeninfo returns every value as a string ("true", "1790000000"), so the
 * checks are exact string comparisons (an array or object never passes):
 * aud = OAUTH_CLIENT_ID, iss one of GOOGLE_ISSUERS, exp in the future,
 * email_verified "true", and nonce equal to the nonce the app sent. The app
 * always asks Google for a nonce (docs/API.md "Authentication"), so a
 * request or a token without one is refused.
 */
function idTokenProblem_(claims, nonce, nowSec) {
  const clientId = prop_(PROP.OAUTH_CLIENT_ID, true);
  if (typeof claims.aud !== 'string' || claims.aud !== clientId) return 'wrong audience';
  if (typeof claims.iss !== 'string' || GOOGLE_ISSUERS.indexOf(claims.iss) === -1) return 'wrong issuer';
  const exp = typeof claims.exp === 'string' || typeof claims.exp === 'number' ? Number(claims.exp) : NaN;
  if (!isFinite(exp) || exp <= nowSec) return 'expired';
  if (claims.email_verified !== 'true' && claims.email_verified !== true) return 'email not verified';
  if (typeof claims.email !== 'string' || !lower_(claims.email)) return 'no email';
  if (typeof nonce !== 'string' || !nonce) return 'no nonce in the request';
  if (typeof claims.nonce !== 'string' || claims.nonce !== nonce) return 'nonce mismatch';
  return null;
}

function idTokenRejected_(why) {
  console.warn('Google sign-in rejected: ' + why);
  return apiError_(401, 'not_signed_in', "Google sign-in didn't go through. Please try again.");
}

/** signIn {idToken, nonce} → SignInResult, or 403 not_family. */
function signIn_(params, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  const google = verifyGoogleIdToken_(params.idToken, params.nonce, now);
  return completeSignIn_(google.email, now);
}

/** Issues a session for an email that must be an Active App Users row. */
function completeSignIn_(email, nowSec) {
  const appUsers = readAppUsers_();
  const appUser = findAppUser_(appUsers, email);
  if (!appUser) {
    console.warn('Sign-in refused: not an Active App Users row.');
    throw apiError_(403, 'not_family', notFamilyMessage_());
  }
  const s = issueSession_(appUser.email, nowSec);
  return { session: s.token, sessionExpiresAt: s.expiresAt, user: userView_(appUser, ownerEmail_()) };
}

// ---------------------------------------------------------------- session tokens

/**
 * Script Property SESSION_SECRET, created on first use (two random UUIDs).
 * Deleting the property signs every device out.
 */
function sessionSecret_() {
  const props = PropertiesService.getScriptProperties();
  const existing = props.getProperty(PROP.SESSION_SECRET);
  if (existing) return existing;
  return withLock_(() => {
    let secret = props.getProperty(PROP.SESSION_SECRET);  // another request may have just made it
    if (!secret) {
      secret = [Utilities.getUuid(), Utilities.getUuid()].join('');
      props.setProperty(PROP.SESSION_SECRET, secret);
      console.log('Created Script Property SESSION_SECRET.');
    }
    return secret;
  });
}

function signSessionBody_(body) {
  return b64url_(Utilities.computeHmacSha256Signature(body, sessionSecret_()));
}

/**
 * A new session token for an email.
 * @return {{token: string, expiresAt: string, issuedAt: number, expiresAtSec: number}}
 *   expiresAt is ISO 8601 (Chicago offset), for SignInResult.sessionExpiresAt.
 */
function issueSession_(email, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  const payload = {
    e: lower_(email),
    i: now,
    x: now + RULES.SESSION_TTL_DAYS * 86400,
    n: Utilities.getUuid().replace(/-/g, '').slice(0, 12),
  };
  const body = SESSION_VERSION_ + '.' + b64url_(JSON.stringify(payload));
  return {
    token: body + '.' + signSessionBody_(body),
    expiresAt: isoFromDate_(new Date(payload.x * 1000)),
    issuedAt: payload.i,
    expiresAtSec: payload.x,
  };
}

/**
 * Checks a session token's version, signature (constant-time) and expiry.
 * @return {{email: string, issuedAt: number, expiresAt: number, nonce: string}|null}
 */
function verifySession_(token, nowSec) {
  if (typeof token !== 'string' || !token || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== SESSION_VERSION_ || !parts[1] || !parts[2]) return null;
  if (!constantTimeEqual_(signSessionBody_(parts[0] + '.' + parts[1]), parts[2])) return null;
  let p;
  try {
    p = JSON.parse(b64urlDecodeToString_(parts[1]));
  } catch (e) {
    return null;
  }
  if (!p || typeof p.e !== 'string' || !p.e || typeof p.i !== 'number' || typeof p.x !== 'number') return null;
  const now = nowSec === undefined ? nowSec_() : nowSec;
  if (p.x <= now) return null;          // expired
  if (p.i > now + 300) return null;     // issued in the future: not one of ours
  return { email: lower_(p.e), issuedAt: p.i, expiresAt: p.x, nonce: String(p.n || '') };
}

/** The normalized App Users rows, read fresh (the tab is small). */
function readAppUsers_() {
  return normAppUsers_(readTab_(TAB.APP_USERS, false));
}

/**
 * Authenticates a request. Throws 401 not_signed_in for a missing, bad or
 * expired session, and 403 not_family when the email is no longer an Active
 * App Users row.
 * @return {{email: string, appUser: object, appUsers: object[], issuedAt: number, expiresAt: number}}
 */
function requireUser_(sessionToken, nowSec) {
  const s = verifySession_(sessionToken, nowSec);
  if (!s) throw apiError_(401, 'not_signed_in', 'Please sign in again.');
  const appUsers = readAppUsers_();
  const appUser = findAppUser_(appUsers, s.email);
  if (!appUser) throw apiError_(403, 'not_family', notFamilyMessage_());
  return { email: s.email, appUser: appUser, appUsers: appUsers, issuedAt: s.issuedAt, expiresAt: s.expiresAt };
}

/**
 * Rolling renewal: a fresh session when the caller's is older than
 * RULES.SESSION_RENEW_AFTER_DAYS, else null.
 */
function renewSessionIfOld_(ctx, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  if (now - ctx.issuedAt <= RULES.SESSION_RENEW_AFTER_DAYS * 86400) return null;
  return issueSession_(ctx.email, now);
}

// ---------------------------------------------------------------- sign in with a code

/** A random code from PAIR_ALPHABET_ (rejection sampling, so every symbol is equally likely). */
function newPairCode_() {
  const n = PAIR_ALPHABET_.length;
  const limit = 256 - (256 % n);
  let code = '';
  while (code.length < PAIR_CODE_LENGTH_) {
    const bytes = randomBytes_();
    for (let i = 0; i < bytes.length && code.length < PAIR_CODE_LENGTH_; i++) {
      if (bytes[i] < limit) code += PAIR_ALPHABET_.charAt(bytes[i] % n);
    }
  }
  return code;
}

/** What the person typed → canonical code: upper case, spaces and dashes removed. */
function normalizePairCode_(s) {
  return String(s || '').toUpperCase().replace(/[\s-]/g, '');
}

/** Open codes, with expired and malformed ones dropped. */
function readOpenPairCodes_(cache, now) {
  let open = {};
  try { open = JSON.parse(cache.get(PAIR_OPEN_KEY_) || '{}') || {}; } catch (e) { open = {}; }
  if (typeof open !== 'object' || Array.isArray(open)) open = {};
  Object.keys(open).forEach(k => {
    if (!open[k] || typeof open[k].email !== 'string' || !(open[k].exp > now)) delete open[k];
  });
  return open;
}

function writeOpenPairCodes_(cache, open, now) {
  const keys = Object.keys(open);
  if (!keys.length) {
    cache.remove(PAIR_OPEN_KEY_);
    return;
  }
  const ttl = Math.max.apply(null, keys.map(k => open[k].exp - now));
  cache.put(PAIR_OPEN_KEY_, JSON.stringify(open), Math.max(1, Math.min(ttl, 21600)));
}

/** pairCreate → {code, expiresAt}: an 8-character code for the caller, valid once for 10 minutes. */
function pairCreate_(ctx, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  const cache = CacheService.getScriptCache();
  const exp = now + RULES.PAIR_CODE_TTL_SEC;
  const code = withLock_(() => {
    const open = readOpenPairCodes_(cache, now);
    let c = newPairCode_();
    while (open[c]) c = newPairCode_();
    open[c] = { email: ctx.email, exp: exp, fails: 0 };
    // Keep the list short: drop the oldest codes beyond the cap.
    const keys = Object.keys(open).sort((a, b) => open[a].exp - open[b].exp);
    keys.slice(0, Math.max(0, keys.length - PAIR_MAX_OPEN_CODES_)).forEach(k => delete open[k]);
    writeOpenPairCodes_(cache, open, now);
    return c;
  });
  return { code: code, expiresAt: isoFromDate_(new Date(exp * 1000)) };
}

/**
 * pairRedeem {code} → SignInResult. A code works once. Each wrong code counts
 * against every open code (after RULES.PAIR_CODE_MAX_ATTEMPTS it is burned)
 * and against the global limit (then 429 rate_limited for everyone).
 */
function pairRedeem_(params, nowSec) {
  const now = nowSec === undefined ? nowSec_() : nowSec;
  const code = normalizePairCode_(params.code);
  const cache = CacheService.getScriptCache();
  const email = withLock_(() => {
    if (cache.get(PAIR_LOCKOUT_KEY_)) {
      throw apiError_(429, 'rate_limited', 'Too many wrong codes. Please wait 10 minutes and try again.');
    }
    const open = readOpenPairCodes_(cache, now);
    // Only a real code can match: "__proto__" or "constructor" must not look like a hit.
    const wellFormed = code.length === PAIR_CODE_LENGTH_ && new RegExp('^[' + PAIR_ALPHABET_ + ']+$').test(code);
    const hit = wellFormed && Object.prototype.hasOwnProperty.call(open, code) ? open[code] : null;
    if (hit) {
      delete open[code];  // single use
      writeOpenPairCodes_(cache, open, now);
      return hit.email;
    }
    Object.keys(open).forEach(k => {
      open[k].fails = (open[k].fails || 0) + 1;
      if (open[k].fails >= RULES.PAIR_CODE_MAX_ATTEMPTS) delete open[k];
    });
    writeOpenPairCodes_(cache, open, now);
    notePairFailure_(cache, now);
    return null;
  });
  if (!email) {
    throw apiError_(401, 'not_signed_in', "That code didn't work. Codes last 10 minutes and work once.");
  }
  return completeSignIn_(email, now);
}

/** Counts a wrong code toward the global limit; starts the lockout when it's reached. */
function notePairFailure_(cache, now) {
  let rec = null;
  try { rec = JSON.parse(cache.get(PAIR_FAILS_KEY_) || 'null'); } catch (e) { rec = null; }
  if (!rec || typeof rec.since !== 'number' || now - rec.since >= PAIR_GLOBAL_WINDOW_SEC_) rec = { since: now, n: 0 };
  rec.n++;
  if (rec.n >= PAIR_GLOBAL_MAX_FAILS_) {
    cache.put(PAIR_LOCKOUT_KEY_, String(now), PAIR_LOCKOUT_SEC_);
    cache.remove(PAIR_FAILS_KEY_);
    console.warn('pairRedeem locked for ' + PAIR_LOCKOUT_SEC_ + ' s after ' + rec.n + ' wrong codes.');
    return;
  }
  cache.put(PAIR_FAILS_KEY_, JSON.stringify(rec), Math.max(1, PAIR_GLOBAL_WINDOW_SEC_ - (now - rec.since)));
}
