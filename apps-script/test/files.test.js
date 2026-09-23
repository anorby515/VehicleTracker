'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/sheet');
const { loadApi, toSigned } = require('./fakes-services');

const MB = 1024 * 1024;
const PDF = '%PDF-1.4\nfake receipt\n%%EOF';
const PNG = 'fakePNG photo bytes';

function setup() {
  const env = loadApi({ tabs: fx.cloneTabs() });
  const { drive } = env.services;
  drive.addFile({ id: 'fake-doc-4r-0824-inv', name: 'invoice.pdf', mimeType: 'application/pdf', text: PDF });
  drive.addFile({ id: 'fake-scan-0001', name: 'App scan.pdf', mimeType: 'application/pdf', text: PDF });
  drive.addFile({ id: 'fake-photo-4r', name: '2023 Toyota 4Runner - Photo.png', mimeType: 'image/png', text: PNG });
  drive.addFile({ id: 'fake-reg-4r', name: 'Registration.pdf', mimeType: 'application/pdf', text: PDF });
  // Big photo: getSize() says 2 MB, so the API asks Drive for a thumbnail.
  drive.addFile({ id: 'fake-photo-x7', name: '2023 BMW X7 - Photo.png', mimeType: 'image/png', text: PNG, size: 2 * MB });
  // A real Drive file the script could open, but not part of this system.
  drive.addFile({ id: 'fake-private-file-0001', name: 'Tax return.pdf', mimeType: 'application/pdf', text: PDF });

  // Count Drive opens, to prove refused IDs never reach Drive.
  env.opened = [];
  const getFileById = drive.getFileById.bind(drive);
  drive.getFileById = (id) => { env.opened.push(id); return getFileById(id); };

  env.ctx = { email: 'leo@example.com' };
  env.getFile = (params) => JSON.parse(JSON.stringify(env.gas.getFile_(env.ctx, params)));
  return env;
}

function apiErr(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e.apiError, 'expected an apiError_, got ' + (e && e.stack));
    // detail comes from the vm realm: compare it as plain JSON.
    return { status: e.status, error: e.error, message: e.message,
      detail: e.detail === undefined ? undefined : JSON.parse(JSON.stringify(e.detail)) };
  }
  assert.fail('expected an error');
}

const b64 = s => Buffer.from(s, 'latin1').toString('base64');

test('getFile serves IDs from Documents, App Scans, Vehicles Photo File ID and Registration File ID', () => {
  const { getFile } = setup();
  assert.deepEqual(getFile({ fileId: 'fake-doc-4r-0824-inv' }), {
    fileId: 'fake-doc-4r-0824-inv', name: 'invoice.pdf', mimeType: 'application/pdf', size: PDF.length, data: b64(PDF),
  });
  assert.equal(getFile({ fileId: 'fake-scan-0001', purpose: 'document' }).name, 'App scan.pdf');
  assert.equal(getFile({ fileId: 'fake-photo-4r', purpose: 'photo' }).mimeType, 'image/png');
  assert.equal(getFile({ fileId: 'fake-reg-4r' }).data, b64(PDF));
});

test('getFile refuses a Drive file ID that is not part of this system (403), without opening it', () => {
  const env = setup();
  const e = apiErr(() => env.getFile({ fileId: 'fake-private-file-0001' }));
  assert.deepEqual([e.status, e.error, e.message], [403, 'forbidden', "That file isn't part of this app."]);
  assert.deepEqual(env.opened, []);
  // Also refused through doPost, as the family's app would see it.
  const token = env.gas.issueSession_('leo@example.com', Math.floor(Date.now() / 1000)).token;
  const res = JSON.parse(env.gas.doPost({ postData: { contents: JSON.stringify({
    action: 'getFile', session: token, fileId: 'fake-private-file-0001', purpose: 'document' }) } }).getContent());
  assert.deepEqual(res, { ok: false, status: 403, error: 'forbidden', message: "That file isn't part of this app." });
  // A value that appears in some other column (a Visit ID) doesn't count either.
  assert.equal(apiErr(() => env.getFile({ fileId: '4r-20260903-L1102' })).status, 403);
});

test('getFile reads the columns by header name and caches a positive check for 5 minutes', () => {
  const env = setup();
  assert.equal(env.getFile({ fileId: 'fake-doc-4r-0824-inv' }).fileId, 'fake-doc-4r-0824-inv');
  // The Documents row goes away (the ingestion script merged pages, say).
  const docs = env.fakes.spreadsheet.getSheetByName('Documents');
  const col = docs.toValues()[0].indexOf('Drive File ID') + 1;
  docs.getRange(2, col).setValue('');
  assert.equal(env.getFile({ fileId: 'fake-doc-4r-0824-inv' }).fileId, 'fake-doc-4r-0824-inv', 'cached');
  env.fakes.clock.advance(301);
  assert.equal(apiErr(() => env.getFile({ fileId: 'fake-doc-4r-0824-inv' })).status, 403);
});

test('getFile: missing or trashed → 404; over 20 MB → 413 too_large', () => {
  const env = setup();
  env.services.drive.files.delete('fake-scan-0001');
  assert.deepEqual(apiErr(() => env.getFile({ fileId: 'fake-scan-0001' })).status, 404);
  env.services.drive.files.get('fake-reg-4r').trashed = true;
  assert.deepEqual(apiErr(() => env.getFile({ fileId: 'fake-reg-4r' })).error, 'not_found');
  env.services.drive.files.get('fake-doc-4r-0824-inv').size = 20 * MB + 1;
  const big = apiErr(() => env.getFile({ fileId: 'fake-doc-4r-0824-inv' }));
  assert.deepEqual([big.status, big.error, big.detail], [413, 'too_large', { size: 20 * MB + 1 }]);
  env.services.drive.files.get('fake-doc-4r-0824-inv').size = 20 * MB;
  assert.equal(env.getFile({ fileId: 'fake-doc-4r-0824-inv' }).fileId, 'fake-doc-4r-0824-inv', 'exactly 20 MB is fine');
});

test('getFile photo: small originals as is; big ones as a 1,200 px Drive thumbnail', () => {
  const env = setup();
  const { urlFetch } = env.services;
  urlFetch.on('https://www.googleapis.com/drive/v3/files/fake-photo-x7', () => ({
    code: 200, body: JSON.stringify({ thumbnailLink: 'https://lh3.googleusercontent.com/drive-storage/fakeThumb=s220' }),
  }));
  urlFetch.on('https://lh3.googleusercontent.com/drive-storage/', (url, o) => {
    assert.equal(url, 'https://lh3.googleusercontent.com/drive-storage/fakeThumb=s1200');
    assert.equal(o.headers.Authorization, 'Bearer fake-oauth-token');
    return { code: 200, bytes: toSigned(Buffer.from('JPEGDATA')), contentType: 'image/jpeg' };
  });

  const small = env.getFile({ fileId: 'fake-photo-4r', purpose: 'photo' });
  assert.equal(small.data, b64(PNG));
  assert.equal(urlFetch.calls.length, 0, 'no thumbnail for a small photo');

  const thumb = env.getFile({ fileId: 'fake-photo-x7', purpose: 'photo' });
  assert.deepEqual(thumb, {
    fileId: 'fake-photo-x7', name: '2023 BMW X7 - Photo.png', mimeType: 'image/jpeg', size: 8, data: b64('JPEGDATA'),
  });
  assert.equal(urlFetch.calls[0].url, 'https://www.googleapis.com/drive/v3/files/fake-photo-x7?fields=thumbnailLink');
  assert.equal(urlFetch.calls[0].opts.headers.Authorization, 'Bearer fake-oauth-token');

  // purpose 'document' (or none) always gets the original.
  assert.equal(env.getFile({ fileId: 'fake-photo-x7' }).mimeType, 'image/png');
});

test('getFile photo: when the thumbnail fails, the original is sent', () => {
  const env = setup();
  env.services.urlFetch.on('https://www.googleapis.com/drive/v3/files/', () => ({ code: 403, body: 'nope' }));
  const res = env.getFile({ fileId: 'fake-photo-x7', purpose: 'photo' });
  assert.equal(res.mimeType, 'image/png');
  assert.equal(res.data, b64(PNG));

  env.services.urlFetch.on('https://www.googleapis.com/drive/v3/files/', () => ({ code: 200, body: '{}' }));
  assert.equal(env.getFile({ fileId: 'fake-photo-x7', purpose: 'photo' }).data, b64(PNG), 'no thumbnailLink');

  env.services.urlFetch.on('https://www.googleapis.com/drive/v3/files/', () => new Error('Address unavailable'));
  assert.equal(env.getFile({ fileId: 'fake-photo-x7', purpose: 'photo' }).data, b64(PNG), 'network error');
});
