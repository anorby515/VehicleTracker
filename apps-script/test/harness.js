/**
 * Loads the Apps Script source files into one Node vm context, the way Apps
 * Script shares a single global scope across files, so the pure data logic
 * can be unit-tested without a live Sheet.
 *
 * Usage:
 *   const { load } = require('./harness');
 *   const gas = load();                    // all .js files in apps-script/
 *   gas.ymdToDay_('2026-09-22');
 *
 * Apps Script services (SpreadsheetApp, DriveApp, ...) are NOT stubbed by
 * default; tests that need them pass `globals` (see fakes.js).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');

/** Minimal Utilities shim: the parts the pure code and Auth use. */
function makeUtilities() {
  const toSigned = (buf) => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
  const toBytes = (s) => toSigned(Buffer.from(String(s), 'utf8'));
  const fromBytes = (bytes) => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b)));
  // Apps Script Blob basics: signed bytes plus an optional content type and name.
  const makeBlob = (bytes, contentType, name) => ({
    getBytes: () => bytes,
    getDataAsString: () => fromBytes(bytes).toString('utf8'),
    getContentType: () => contentType || null,
    getName: () => name || null,
  });
  return {
    computeHmacSha256Signature(value, key) {
      const v = Array.isArray(value) ? fromBytes(value) : Buffer.from(String(value), 'utf8');
      const k = Array.isArray(key) ? fromBytes(key) : Buffer.from(String(key), 'utf8');
      return Array.from(crypto.createHmac('sha256', k).update(v).digest()).map(b => (b > 127 ? b - 256 : b));
    },
    computeDigest(_alg, value) {
      const v = Array.isArray(value) ? fromBytes(value) : Buffer.from(String(value), 'utf8');
      return Array.from(crypto.createHash('sha256').update(v).digest()).map(b => (b > 127 ? b - 256 : b));
    },
    DigestAlgorithm: { SHA_256: 'SHA_256' },
    Charset: { UTF_8: 'UTF_8' },
    base64EncodeWebSafe(data) {
      const buf = Array.isArray(data) ? fromBytes(data) : Buffer.from(String(data), 'utf8');
      return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
    },
    base64DecodeWebSafe(s) {
      const b64 = String(s).replace(/-/g, '+').replace(/_/g, '/');
      return Array.from(Buffer.from(b64, 'base64')).map(b => (b > 127 ? b - 256 : b));
    },
    base64Encode(data) {
      const buf = Array.isArray(data) ? fromBytes(data) : Buffer.from(String(data), 'utf8');
      return buf.toString('base64');
    },
    base64Decode(s) {
      return Array.from(Buffer.from(String(s), 'base64')).map(b => (b > 127 ? b - 256 : b));
    },
    newBlob(data, contentType, name) {
      return makeBlob(Array.isArray(data) ? data : toBytes(data), contentType, name);
    },
    // Used by the bootstrap cache (Bootstrap.js).
    gzip(blob) {
      return makeBlob(toSigned(zlib.gzipSync(fromBytes(blob.getBytes()))), 'application/x-gzip');
    },
    ungzip(blob) {
      return makeBlob(toSigned(zlib.gunzipSync(fromBytes(blob.getBytes()))));
    },
    getUuid: () => crypto.randomUUID(),
    sleep: () => {},
    // formatDate intentionally omitted: Dates.js falls back to Intl in Node.
  };
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.files] file names relative to apps-script/ (default: all *.js at the root)
 * @param {object} [opts.globals] extra globals (fakes for SpreadsheetApp, DriveApp, ...)
 * @param {boolean} [opts.utilities] include the Utilities shim (default true)
 */
function load(opts = {}) {
  // Always plain alphabetical, whatever order the caller lists: clasp pushes
  // files alphabetically (unless .clasp.json has filePushOrder), and Apps
  // Script runs each file's top level in push order. A top-level statement
  // that reads another file's constant (e.g. RULES from Config.js in Api.js)
  // therefore fails here exactly as it would in Apps Script.
  const files = orderFiles(opts.files || fs.readdirSync(ROOT).filter(f => f.endsWith('.js')));
  const sandbox = Object.assign({
    console,
    Intl,
    Math,
    JSON,
    Date: opts.Date || Date,
  }, opts.utilities === false ? {} : { Utilities: makeUtilities() }, opts.globals || {});
  const context = vm.createContext(sandbox);
  for (const f of files) {
    const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
    vm.runInContext(code, context, { filename: f });
  }
  // Expose top-level const/let bindings (not properties of the global object).
  return new Proxy(context, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      try { return vm.runInContext(prop, context); } catch (e) { return undefined; }
    },
  });
}

/**
 * Plain alphabetical (code-unit order, like clasp's sort). Deliberately NOT
 * Config-first: .clasp.json's filePushOrder puts Config.js first on push,
 * but the code must not depend on it, so the tests load in the worst case.
 */
function loadOrder(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** The order load() runs a list of files in. */
function orderFiles(files) {
  return files.slice().sort(loadOrder);
}

module.exports = { load, orderFiles, ROOT };
