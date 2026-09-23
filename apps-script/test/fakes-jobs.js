'use strict';
/**
 * Fakes for the services the jobs use that fakes.js doesn't cover:
 * DriveApp (file → folder chain) and UrlFetchApp (NHTSA and the Push Worker).
 * Pass them to makeFakes({extraGlobals: {...}}).
 */

/**
 * A tiny Drive: files and folders with one parent each (the My Drive model).
 * @param {object} tree
 *   files:   {fileId: {parent?: folderId, trashed?: boolean, error?: string}}
 *            `error` makes getFileById throw that message (a Drive hiccup)
 *   folders: {folderId: parentFolderId | null}
 */
function makeDriveApp(tree) {
  const files = tree.files || {};
  const folders = tree.folders || {};
  const calls = { getFileById: 0, getParents: 0 };
  const iter = (ids) => {
    let i = 0;
    return { hasNext: () => i < ids.length, next: () => folderObj(ids[i++]) };
  };
  const folderObj = (id) => ({
    getId: () => id,
    getParents: () => {
      calls.getParents++;
      return iter(folders[id] ? [folders[id]] : []);
    },
  });
  return {
    calls,
    getFileById(id) {
      calls.getFileById++;
      const f = files[id];
      if (!f) {
        throw new Error('Exception: No item with the given ID could be found. Possibly because you have not ' +
          'edited this item or you do not have permission to access it.');
      }
      if (f.error) throw new Error(f.error);
      return {
        getId: () => id,
        isTrashed: () => !!f.trashed,
        getParents: () => {
          calls.getParents++;
          return iter(f.parent ? [f.parent] : []);
        },
      };
    },
  };
}

/** An HTTPResponse-like object. `body` objects are JSON-encoded. */
function response(code, body, headers) {
  const text = body === undefined || body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  return {
    getResponseCode: () => code,
    getContentText: () => text,
    getAllHeaders: () => Object.assign({}, headers || {}),
    getHeaders: () => Object.assign({}, headers || {}),
  };
}

/**
 * UrlFetchApp whose fetch(url, opts) calls `handler(url, opts)`, which returns
 * {code, body, headers} (or throws, like a network error). Every call is
 * recorded in `requests` as {url, opts, json} (json = parsed payload, if any).
 */
function makeUrlFetchApp(handler) {
  const requests = [];
  return {
    requests,
    fetch(url, opts) {
      let json = null;
      try { json = opts && typeof opts.payload === 'string' ? JSON.parse(opts.payload) : null; } catch (e) { json = null; }
      requests.push({ url, opts: opts || {}, json });
      const r = handler(url, opts || {}, json);
      return response(r.code, r.body, r.headers);
    },
  };
}

/**
 * A Push Worker stand-in for makeUrlFetchApp: answers /send with one result
 * per message from `resultFor(message)` → {status, error?} (default 201).
 * NHTSA or any other URL goes to `other(url)` when given.
 */
function workerHandler(resultFor, other) {
  return (url, opts, json) => {
    if (/\/send$/.test(url)) {
      const results = (json.messages || []).map(m => {
        const r = (resultFor && resultFor(m)) || { status: 201 };
        const status = r.status;
        const out = { id: m.id, status, ok: status >= 200 && status < 300, gone: status === 404 || status === 410 };
        if (!out.ok) {
          // Like the real Worker: the raw text in `error`, the JSON "reason" parsed out (or null).
          out.error = r.error || 'http_' + status;
          let parsed = null;
          try { parsed = JSON.parse(r.error).reason || null; } catch (e) { parsed = null; }
          out.reason = 'reason' in r ? r.reason : parsed;
        }
        return out;
      });
      return { code: 200, body: { results } };
    }
    if (other) return other(url, opts, json);
    throw new Error('Unexpected fetch: ' + url);
  };
}

module.exports = { makeDriveApp, makeUrlFetchApp, workerHandler, response };
