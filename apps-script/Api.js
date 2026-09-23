/**
 * Web app entry points (docs/API.md "Transport" and "Actions").
 *
 * - doGet answers only ?health=1, so Andrew can check a deployment in a
 *   browser. It never returns data.
 * - doPost takes a text/plain JSON body {action, ...params}, checks the
 *   session (except signIn / pairRedeem), validates params, and routes.
 *
 * Apps Script can't set HTTP status codes, so EVERY response is HTTP 200 with
 * a JSON body: {ok: true, ...data} or {ok: false, status, error, message,
 * detail?} (types.ts › ApiError). Nothing ever escapes as an HTML error page.
 *
 * The push, prefs and sign-out handlers live in Notify.js and the scan-status
 * check in Scans.js; this file only routes to them.
 */

/** An error that doPost turns into {ok: false, status, error, message, detail}. */
function apiError_(status, error, message, detail) {
  const e = new Error(message);
  e.apiError = true;
  e.status = status;
  e.error = error;
  if (detail) e.detail = detail;
  return e;
}

function isApiError_(e) {
  return !!(e && e.apiError === true && typeof e.status === 'number' && typeof e.error === 'string');
}

function ok_(data) {
  return Object.assign({ ok: true }, data || {});
}

function fail_(status, error, message, detail) {
  const out = { ok: false, status: status, error: error, message: message };
  if (detail) out.detail = detail;
  return out;
}

/** Any object → a JSON text response. */
function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------- entry points

function doGet(e) {
  try {
    const p = (e && e.parameter) || {};
    if (String(p.health) === '1') return jsonOut_({ ok: true, version: APP_VERSION });
  } catch (err) {
    console.error('doGet: ' + (err && err.stack || err));
  }
  return jsonOut_(fail_(404, 'not_found', 'Nothing here.'));
}

function doPost(e) {
  return jsonOut_(handlePost_(e));
}

/** doPost without the ContentService wrapper (what the tests call). */
function handlePost_(e) {
  let action = '(none)';
  try {
    const text = e && e.postData && typeof e.postData.contents === 'string' ? e.postData.contents : '';
    if (!text) return fail_(400, 'bad_request', 'The request was empty.');
    let body;
    try {
      body = JSON.parse(text);
    } catch (parseErr) {
      return fail_(400, 'bad_request', "The request wasn't valid JSON.");
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail_(400, 'bad_request', 'The request must be a JSON object.');
    }
    action = typeof body.action === 'string' ? body.action : '(none)';
    return ok_(route_(body));
  } catch (err) {
    if (isApiError_(err)) return fail_(err.status, err.error, err.message, err.detail);
    console.error('API error in ' + action + ': ' + (err && err.stack || err));
    return fail_(500, 'server_error', 'Something went wrong on our side. Please try again in a minute.');
  }
}

// ---------------------------------------------------------------- routing

/**
 * The action table, built on demand (the handlers live in other files, which
 * Apps Script may load after this one).
 *   auth:   true when the action needs a session (ctx = requireUser_ result)
 *   params: {name: spec} checked by validateParams_ before the handler runs
 *   run:    (ctx, params) → result data (without `ok`)
 */
function routes_() {
  return {
    signIn: {
      auth: false,
      params: { idToken: { type: 'string', required: true, max: 8192 }, nonce: { type: 'string', max: 256 } },
      run: (ctx, p) => signIn_(p),
    },
    pairRedeem: {
      auth: false,
      params: { code: { type: 'string', required: true, max: 32 } },
      run: (ctx, p) => pairRedeem_(p),
    },
    pairCreate: { auth: true, params: {}, run: (ctx) => pairCreate_(ctx) },
    bootstrap: { auth: true, params: {}, run: (ctx) => bootstrapAction_(ctx) },
    getFile: {
      auth: true,
      params: {
        fileId: { type: 'string', required: true, pattern: /^[A-Za-z0-9_-]{10,200}$/ },
        purpose: { type: 'string', oneOf: ['document', 'photo'] },
      },
      run: (ctx, p) => getFile_(ctx, p),
    },
    addOdometer: {
      auth: true,
      params: {
        vehicle: { type: 'string', required: true, max: 200 },
        mileage: { type: 'number', required: true },
        date: { type: 'string', pattern: /^\d{4}-\d{2}-\d{2}$/ },
        note: { type: 'string', max: 500 },
        clientId: { type: 'string', required: true, max: 100, pattern: /\S/ },
        confirmHigh: { type: 'boolean' },
      },
      run: (ctx, p) => addOdometer_(ctx, p),
    },
    uploadStart: {
      auth: true,
      params: {
        scanId: { type: 'string', required: true, pattern: /^[A-Za-z0-9._:-]{1,100}$/ },
        kind: { type: 'string', required: true, oneOf: ['Receipt', 'Upload', 'Owner entry'] },
        vehicleHint: { type: 'string', required: true, max: 200 },
        size: { type: 'integer', required: true },
        pages: { type: 'integer', required: true },
        capturedAt: { type: 'string', required: true, max: 64 },
      },
      run: (ctx, p) => uploadStart_(ctx, p),
    },
    uploadChunk: {
      auth: true,
      params: {
        uploadId: { type: 'string', required: true, max: 100 },
        offset: { type: 'integer', required: true, min: 0 },
        // One chunk of at most RULES.UPLOAD_CHUNK_BYTES, as base64.
        data: { type: 'string', required: true, max: Math.ceil(RULES.UPLOAD_CHUNK_BYTES / 3) * 4 + 4 },
      },
      run: (ctx, p) => uploadChunk_(ctx, p),
    },
    subscribePush: {
      auth: true,
      params: { subscription: { type: 'object', required: true }, deviceLabel: { type: 'string', max: 100 } },
      run: (ctx, p) => subscribePush_(ctx, p),
    },
    unsubscribePush: {
      auth: true,
      params: { endpoint: { type: 'string', required: true, max: 2048 } },
      run: (ctx, p) => unsubscribePush_(ctx, p),
    },
    savePrefs: {
      auth: true,
      params: { prefs: { type: 'object', required: true } },
      run: (ctx, p) => savePrefs_(ctx, p),
    },
    testPush: { auth: true, params: {}, run: (ctx) => testPush_(ctx) },
    signOut: {
      auth: true,
      params: { endpoint: { type: 'string', max: 2048 } },
      run: (ctx, p) => signOutDevice_(ctx, p),
    },
  };
}

/** Authenticates (when needed), validates and runs one action. Returns result data. */
function route_(body) {
  const routes = routes_();
  const action = body.action;
  if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(routes, action)) {
    throw apiError_(400, 'bad_request', 'Unknown action.');
  }
  const r = routes[action];
  const ctx = r.auth ? requireUser_(body.session) : null;
  const params = validateParams_(body, r.params);
  return r.run(ctx, params) || {};
}

/**
 * Checks body fields against a spec and returns only the declared ones.
 * Spec per field: {type: 'string'|'number'|'integer'|'boolean'|'object',
 * required, max (string length), min (numbers), pattern (RegExp), oneOf}.
 * null counts as missing. Throws 400 bad_request naming the field.
 */
function validateParams_(body, spec) {
  const out = {};
  Object.keys(spec || {}).forEach(name => {
    const rule = spec[name];
    const v = body[name];
    if (v === undefined || v === null) {
      if (rule.required) throw badParam_(name, 'is missing');
      return;
    }
    switch (rule.type) {
      case 'string':
        if (typeof v !== 'string') throw badParam_(name, 'must be text');
        if (rule.required && !v.trim() && !rule.pattern) throw badParam_(name, 'is missing');
        if (rule.max !== undefined && v.length > rule.max) throw badParam_(name, 'is too long');
        break;
      case 'number':
        if (typeof v !== 'number' || !isFinite(v)) throw badParam_(name, 'must be a number');
        break;
      case 'integer':
        if (typeof v !== 'number' || !isFinite(v) || Math.floor(v) !== v) throw badParam_(name, 'must be a whole number');
        break;
      case 'boolean':
        if (typeof v !== 'boolean') throw badParam_(name, 'must be true or false');
        break;
      case 'object':
        if (typeof v !== 'object' || Array.isArray(v)) throw badParam_(name, 'must be an object');
        break;
      default:
        throw new Error('validateParams_: unknown type ' + rule.type);
    }
    if (rule.min !== undefined && v < rule.min) throw badParam_(name, 'is too small');
    if (rule.pattern && !rule.pattern.test(v)) throw badParam_(name, 'is not in the expected format');
    if (rule.oneOf && rule.oneOf.indexOf(v) === -1) throw badParam_(name, 'must be one of ' + rule.oneOf.join(', '));
    out[name] = v;
  });
  return out;
}

function badParam_(name, what) {
  return apiError_(400, 'bad_request', 'The request ' + name + ' ' + what + '.', { field: name });
}

// ---------------------------------------------------------------- bootstrap

/**
 * bootstrap → {bootstrap, session?, sessionExpiresAt?}. Runs this user's
 * throttled scan-status check first (a Drive hiccup never breaks bootstrap),
 * and rolls the session forward when it's more than a week old.
 */
function bootstrapAction_(ctx) {
  try {
    if (typeof checkUserScans_ === 'function') checkUserScans_(ctx.email, { name: ctx.appUser && ctx.appUser.name });
  } catch (e) {
    console.warn('Scan status check skipped: ' + (e && e.stack || e));
  }
  const bootstrap = getBootstrap_(ctx.email);
  if (!bootstrap) throw apiError_(403, 'not_family', notFamilyMessage_());
  const out = { bootstrap: bootstrap };
  const renewed = renewSessionIfOld_(ctx);
  if (renewed) {
    out.session = renewed.token;
    out.sessionExpiresAt = renewed.expiresAt;
  }
  return out;
}
