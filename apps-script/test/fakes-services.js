'use strict';
/**
 * In-memory fakes for the Apps Script services that test/fakes.js doesn't
 * cover: UrlFetchApp (with scriptable handlers, a Google tokeninfo stand-in
 * and a Drive resumable-upload stand-in), DriveApp, ScriptApp, ContentService
 * and Logger. SpreadsheetApp, CacheService, PropertiesService, Session and
 * LockService come from test/fakes.js (makeFakes).
 *
 * Usage:
 *   const { makeFakes } = require('./fakes');
 *   const svc = require('./fakes-services');
 *   const fakes = makeFakes({ tabs, props });
 *   const services = svc.makeServices();
 *   const gas = load({ globals: Object.assign({}, fakes.globals, services.globals) });
 *
 * The fakes enforce the real services' rules that the code must respect:
 * UrlFetchApp refuses a Content-Length header, Drive's resumable session
 * wants every chunk but the last in multiples of 256 KiB and answers 308 with
 * a Range header, DriveApp.getFileById throws for unknown IDs, and so on.
 */

const fakesModule = require('./fakes');

// ---------------------------------------------------------------- byte helpers

const toSigned = (buf) => Array.from(buf).map(b => (b > 127 ? b - 256 : b));
const fromSigned = (bytes) => Buffer.from(bytes.map(b => (b < 0 ? b + 256 : b)));

function makeBlob(bytes, contentType, name) {
  return {
    getBytes: () => bytes.slice(),
    getDataAsString: () => fromSigned(bytes).toString('utf8'),
    getContentType: () => contentType || null,
    getName: () => name || null,
  };
}

function iterator(list) {
  let i = 0;
  return { hasNext: () => i < list.length, next: () => list[i++] };
}

// ---------------------------------------------------------------- UrlFetchApp

/** HTTPResponse fake. `headers` keys keep the case they are given in. */
function makeHttpResponse(r) {
  const code = r.code === undefined ? 200 : r.code;
  const headers = r.headers || {};
  const bytes = r.bytes || toSigned(Buffer.from(r.body === undefined ? '' : String(r.body), 'utf8'));
  return {
    getResponseCode: () => code,
    getContentText: () => fromSigned(bytes).toString('utf8'),
    getContent: () => bytes.slice(),
    getAllHeaders: () => Object.assign({}, headers),
    getHeaders: () => Object.assign({}, headers),
    getBlob: () => makeBlob(bytes, r.contentType || headers['Content-Type'] || headers['content-type']),
  };
}

/**
 * UrlFetchApp whose answers come from handlers: [{match(url, opts), respond(url, opts)}].
 * Unmatched URLs throw, so a test notices any unexpected network call.
 */
function makeUrlFetchApp() {
  const handlers = [];
  const api = {
    calls: [],
    on(match, respond) {
      handlers.unshift({ match: typeof match === 'function' ? match : (url) => url.indexOf(match) === 0, respond });
      return api;
    },
    fetch(url, opts) {
      opts = opts || {};
      const hdrs = opts.headers || {};
      Object.keys(hdrs).forEach(k => {
        if (k.toLowerCase() === 'content-length') throw new Error('Attribute provided with invalid value: Header:Content-Length');
      });
      api.calls.push({ url, opts });
      const h = handlers.filter(x => x.match(url, opts))[0];
      if (!h) throw new Error('fakes-services: unexpected fetch ' + (opts.method || 'get').toUpperCase() + ' ' + url);
      const r = h.respond(url, opts);
      if (r instanceof Error) throw r;
      return makeHttpResponse(r);
    },
  };
  return api;
}

/**
 * Google's tokeninfo endpoint: `tokens` maps an ID token → its claims
 * (every value a string, as Google returns them); anything else → 400.
 */
function installTokeninfo(urlFetch, tokens) {
  urlFetch.on('https://oauth2.googleapis.com/tokeninfo', (url) => {
    const tok = decodeURIComponent(url.split('id_token=')[1] || '');
    if (!Object.prototype.hasOwnProperty.call(tokens, tok)) {
      return { code: 400, body: JSON.stringify({ error: 'invalid_token', error_description: 'Invalid Value' }) };
    }
    return { code: 200, body: JSON.stringify(tokens[tok]), headers: { 'Content-Type': 'application/json; charset=UTF-8' } };
  });
}

/**
 * Drive's resumable upload protocol, backed by a DriveApp fake:
 * POST .../upload/drive/v3/files?uploadType=resumable → 200 + location header;
 * PUT <session> with Content-Range "bytes S-E/T" → 308 (+ Range) until the
 * last byte, then 200 {id, name} and the file appears in `drive`.
 *
 * `opts.persistAlign`: Drive keeps only whole multiples of this many bytes
 * of an incomplete upload (simulates a partial 308). Per session:
 * `expired` → 404; `fail = n` → the next n PUTs answer 503; `loseResponse`
 * → the next PUT is handled but UrlFetchApp throws instead of answering.
 */
function installDriveUpload(urlFetch, drive, opts) {
  opts = opts || {};
  const state = { sessions: [], nextFile: 1 };
  urlFetch.on('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', (url, o) => {
    if (String(o.method).toLowerCase() !== 'post') return { code: 405 };
    const auth = (o.headers || {}).Authorization || '';
    if (auth !== 'Bearer fake-oauth-token') return { code: 401 };
    const meta = JSON.parse(o.payload);
    const uri = 'https://upload.fake/session/' + (state.sessions.length + 1);
    state.sessions.push({ uri, meta, bytes: [], expired: false, puts: 0, fail: 0 });
    // Lower-case header name on purpose: the code must read headers case-insensitively.
    return { code: 200, headers: { location: uri } };
  });
  urlFetch.on((url) => url.indexOf('https://upload.fake/session/') === 0, (url, o) => {
    const s = state.sessions.filter(x => x.uri === url)[0];
    if (!s || s.expired) return { code: 404, body: 'Not Found' };
    if (String(o.method).toLowerCase() !== 'put') return { code: 405 };
    if (o.followRedirects !== false) return new Error('fakes-services: 308 needs followRedirects: false');
    s.puts++;
    if (s.fail > 0) { s.fail--; return { code: 503, body: 'Backend Error' }; }
    // loseResponse: Drive handles the request, but the reply never arrives.
    const lose = s.loseResponse;
    s.loseResponse = false;
    const r = handlePut(s, o);
    return lose ? new Error('Timeout: the response from Drive was lost') : r;
  });

  function handlePut(s, o) {
    const range = (o.headers || {})['Content-Range'] || '';
    const status = () => (s.bytes.length
      ? { code: 308, headers: { Range: 'bytes=0-' + (s.bytes.length - 1) } }
      : { code: 308, headers: {} });
    let m = /^bytes \*\/(\d+)$/.exec(range);
    if (m) return s.done ? { code: 200, body: JSON.stringify(s.done) } : status();
    m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range);
    if (!m) return { code: 400, body: 'Bad Content-Range ' + range };
    const start = +m[1], end = +m[2], total = +m[3];
    const payload = o.payload || [];
    if (end - start + 1 !== payload.length) return { code: 400, body: 'Content-Range does not match the payload' };
    if (start !== s.bytes.length) return status();  // Drive ignores out-of-order bytes and reports what it has
    const last = end + 1 === total;
    if (!last && payload.length % (256 * 1024) !== 0) return { code: 400, body: 'Chunk not a multiple of 256 KiB' };
    s.bytes = s.bytes.concat(payload);
    if (last) {
      const id = 'fake-upload-' + state.nextFile++;
      drive.addFile({ id, name: s.meta.name, mimeType: s.meta.mimeType, bytes: s.bytes, parentId: s.meta.parents[0] });
      s.done = { id, name: s.meta.name };
      return { code: 200, body: JSON.stringify(s.done) };
    }
    if (opts.persistAlign) s.bytes = s.bytes.slice(0, Math.floor(s.bytes.length / opts.persistAlign) * opts.persistAlign);
    return status();
  }
  return state;
}

// ---------------------------------------------------------------- DriveApp

function makeDriveApp() {
  const files = new Map();
  const folders = new Map();
  const notFound = () => new Error('No item with the given ID could be found. Possibly because you have not ' +
    'edited this item or you do not have permission to access it.');

  function fileObj(f) {
    return {
      getId: () => f.id,
      getName: () => f.name,
      getMimeType: () => f.mimeType,
      getSize: () => (f.size !== undefined ? f.size : f.bytes.length),
      isTrashed: () => !!f.trashed,
      getBlob: () => makeBlob(f.bytes, f.mimeType, f.name),
      getParents: () => iterator(f.parentId && folders.has(f.parentId) ? [folderObj(folders.get(f.parentId))] : []),
    };
  }
  function folderObj(d) {
    return {
      getId: () => d.id,
      getName: () => d.name,
      getFiles: () => iterator(Array.from(files.values()).filter(f => f.parentId === d.id).map(fileObj)),
      getFolders: () => iterator(Array.from(folders.values()).filter(x => x.parentId === d.id).map(folderObj)),
    };
  }
  return {
    files,
    folders,
    addFolder(id, name, parentId) {
      folders.set(id, { id, name, parentId: parentId || null });
      return this;
    },
    /** {id, name, mimeType, bytes? (signed), text?, size?, parentId?, trashed?} */
    addFile(f) {
      const bytes = f.bytes || toSigned(Buffer.from(f.text || 'x', 'utf8'));
      files.set(f.id, Object.assign({ mimeType: 'application/octet-stream' }, f, { bytes }));
      return this;
    },
    getFileById(id) {
      if (!files.has(id)) throw notFound();
      return fileObj(files.get(id));
    },
    getFolderById(id) {
      if (!folders.has(id)) throw notFound();
      return folderObj(folders.get(id));
    },
  };
}

// ---------------------------------------------------------------- ScriptApp, ContentService, Logger

function makeScriptApp(initialTriggers) {
  let nextId = 1;
  const triggers = (initialTriggers || []).map(t => Object.assign({ id: 'trigger-' + nextId++ }, t));
  const asObject = t => ({
    getHandlerFunction: () => t.handler,
    getUniqueId: () => t.id,
    getEventType: () => t.eventType || 'CLOCK',
  });
  return {
    triggers,
    deleted: [],
    getOAuthToken: () => 'fake-oauth-token',
    getProjectTriggers() { return triggers.map(asObject); },
    deleteTrigger(t) {
      const i = triggers.findIndex(x => x.id === t.getUniqueId());
      if (i === -1) throw new Error('fakes-services: deleting an unknown trigger');
      this.deleted.push(triggers.splice(i, 1)[0]);
    },
    newTrigger(handler) {
      const config = { handler, id: 'trigger-' + nextId++ };
      const time = {
        everyMinutes(n) { config.everyMinutes = n; return time; },
        everyHours(n) { config.everyHours = n; return time; },
        everyDays(n) { config.everyDays = n; return time; },
        atHour(h) { config.atHour = h; return time; },
        nearMinute(m) { config.nearMinute = m; return time; },
        inTimezone(tz) { config.timezone = tz; return time; },
        create() { triggers.push(config); return asObject(config); },
      };
      return { timeBased: () => time };
    },
  };
}

function makeContentService() {
  return {
    MimeType: { JSON: 'JSON', TEXT: 'TEXT' },
    createTextOutput(content) {
      return {
        content: String(content),
        mimeType: null,
        setMimeType(m) { this.mimeType = m; return this; },
        getContent() { return this.content; },
      };
    },
  };
}

function makeLogger() {
  const lines = [];
  return { lines, log(s) { lines.push(String(s)); } };
}

// ---------------------------------------------------------------- all together

/** The App API source files the endpoint tests load (not Notify/Scans/Jobs: tests stub those). */
const API_FILES = ['Config.js', 'Dates.js', 'Sheet.js', 'Model.js', 'Logic.js', 'Bootstrap.js',
  'Api.js', 'Auth.js', 'Files.js', 'Uploads.js', 'Odometer.js', 'Setup.js'];

/** Script Properties for tests (all fictional). */
const TEST_PROPS = {
  OAUTH_CLIENT_ID: 'test-client-id.apps.googleusercontent.com',
  INBOX_FOLDER_ID: 'fake-inbox',
  NEEDS_REVIEW_FOLDER_ID: 'fake-needs-review',
  OWNER_EMAIL: 'robert@example.com',
  PUSH_WORKER_URL: 'https://push-worker.example.com',
  PUSH_WORKER_SECRET: 'test-worker-secret',
  SESSION_SECRET: 'test-session-secret-not-a-real-one',
};

/**
 * @param {object} [opts]
 * @param {object[]} [opts.triggers] existing project triggers [{handler}]
 * @return {{globals, urlFetch, drive, scriptApp, contentService, logger}}
 */
function makeServices(opts = {}) {
  const urlFetch = makeUrlFetchApp();
  const drive = makeDriveApp();
  const scriptApp = makeScriptApp(opts.triggers);
  const contentService = makeContentService();
  const logger = makeLogger();
  return {
    globals: {
      UrlFetchApp: urlFetch,
      DriveApp: drive,
      ScriptApp: scriptApp,
      ContentService: contentService,
      Logger: logger,
    },
    urlFetch,
    drive,
    scriptApp,
    contentService,
    logger,
  };
}

/**
 * Loads the API files with every fake in place.
 * @param {object} opts {tabs, formulas, props (merged over TEST_PROPS; null deletes), now, triggers,
 *   files (default API_FILES; 'all' = every apps-script/*.js), globals}
 * @return {{gas, fakes, services}}
 */
function loadApi(opts = {}) {
  const { load } = require('./harness');
  const props = Object.assign({}, TEST_PROPS, opts.props || {});
  Object.keys(props).forEach(k => { if (props[k] === null) delete props[k]; });
  const fakes = fakesModule.makeFakes({ tabs: opts.tabs, formulas: opts.formulas, props, now: opts.now });
  const services = makeServices({ triggers: opts.triggers });
  const gas = load({
    files: opts.files === 'all' ? undefined : (opts.files || API_FILES),
    globals: Object.assign({}, fakes.globals, services.globals, opts.globals || {}),
  });
  return { gas, fakes, services };
}

module.exports = {
  API_FILES,
  TEST_PROPS,
  loadApi,
  makeServices,
  makeUrlFetchApp,
  makeHttpResponse,
  installTokeninfo,
  installDriveUpload,
  makeDriveApp,
  makeScriptApp,
  makeContentService,
  makeLogger,
  toSigned,
  fromSigned,
};
