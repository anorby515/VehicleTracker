'use strict';
process.env.TZ = process.env.TZ || 'America/Chicago';

const test = require('node:test');
const assert = require('node:assert/strict');
const fx = require('./fixtures/sheet');
const { loadApi, installDriveUpload, fromSigned } = require('./fakes-services');

const R4 = fx.vehicleNames.fourRunner;
const KB = 1024;
const plain = x => JSON.parse(JSON.stringify(x));

/** A fake PDF of `size` bytes: "%PDF-1.7\n" then a byte pattern. */
function makePdf(size) {
  const buf = Buffer.alloc(size);
  buf.write('%PDF-1.7\n', 0, 'latin1');
  for (let i = 9; i < size; i++) buf[i] = (i * 31) % 251;
  return buf;
}

function setup(opts = {}) {
  const env = loadApi({ tabs: fx.cloneTabs() });
  const { gas, services } = env;
  services.drive.addFolder('fake-inbox', 'Inbox');
  env.drive = installDriveUpload(services.urlFetch, services.drive, opts.drive);
  const token = email => gas.issueSession_(email, Math.floor(Date.now() / 1000)).token;
  env.ctx = gas.requireUser_(token('leo@example.com'));
  env.maya = gas.requireUser_(token('maya@example.com'));
  env.start = (params, ctx) => plain(gas.uploadStart_(ctx || env.ctx, Object.assign({
    scanId: 'scan-new-1', kind: 'Receipt', vehicleHint: R4, size: 614400, pages: 2,
    capturedAt: '2026-09-22T23:05:00Z',  // 6:05 PM in Chicago
  }, params)));
  env.chunk = (uploadId, pdf, offset, len, ctx) => plain(gas.uploadChunk_(ctx || env.ctx, {
    uploadId, offset, data: pdf.subarray(offset, offset + len).toString('base64'),
  }));
  env.scanRows = () => {
    const [h, ...rows] = env.fakes.spreadsheet.getSheetByName('App Scans').toValues();
    return rows.map(r => Object.fromEntries(h.map((k, i) => [k, r[i]])));
  };
  env.puts = () => services.urlFetch.calls.filter(c => c.url.startsWith('https://upload.fake/session/'));
  return env;
}

function apiErr(fn) {
  try {
    fn();
  } catch (e) {
    assert.ok(e.apiError, 'expected an apiError_, got ' + (e && e.stack));
    return { status: e.status, error: e.error, message: e.message,
      detail: e.detail === undefined ? undefined : JSON.parse(JSON.stringify(e.detail)) };
  }
  assert.fail('expected an error');
}

test('upload: start → 308 chunks → final 200 → App Scans row and the scan', () => {
  const env = setup();
  const cacheKey = env.gas.bootstrapCacheKey_();
  env.fakes.scriptCache.put(cacheKey, '{"id":"x","n":1}', 300);
  const pdf = makePdf(614400);  // 600 KiB: 256 KiB + 256 KiB + 88 KiB

  const started = env.start();
  assert.deepEqual(Object.keys(started), ['uploadId', 'chunkSize']);
  assert.equal(started.chunkSize, 2 * 1024 * 1024);
  const open = env.services.urlFetch.calls[0];
  assert.equal(open.url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name');
  assert.equal(open.opts.method, 'post');
  assert.equal(open.opts.contentType, 'application/json; charset=UTF-8');
  assert.equal(open.opts.headers.Authorization, 'Bearer fake-oauth-token');
  assert.deepEqual(JSON.parse(open.opts.payload), {
    name: 'App scan - 2023 Toyota 4Runner - 2026-09-22 1805 - Leo.pdf', parents: ['fake-inbox'], mimeType: 'application/pdf',
  });

  assert.deepEqual(env.chunk(started.uploadId, pdf, 0, 256 * KB), { received: 262144, done: false });
  assert.deepEqual(env.chunk(started.uploadId, pdf, 262144, 256 * KB), { received: 524288, done: false });
  assert.equal(env.services.drive.files.size, 0, 'no file in Drive until the last byte');
  const done = env.chunk(started.uploadId, pdf, 524288, 88 * KB);

  const puts = env.puts();
  assert.deepEqual(puts.map(p => p.opts.headers['Content-Range']),
    ['bytes 0-262143/614400', 'bytes 262144-524287/614400', 'bytes 524288-614399/614400']);
  puts.forEach(p => {
    assert.equal(p.opts.method, 'put');
    assert.equal(p.opts.contentType, 'application/pdf');
    assert.equal(p.opts.followRedirects, false);
  });

  // The file landed in Inbox, byte for byte.
  const file = env.services.drive.files.get('fake-upload-1');
  assert.equal(file.parentId, 'fake-inbox');
  assert.ok(fromSigned(file.bytes).equals(pdf));

  const rows = env.scanRows();
  const row = rows[rows.length - 1];
  assert.equal(rows.length, 10);
  assert.deepEqual(
    [row['Scan ID'], row['Kind'], row['Vehicle Hint'], row['Drive File ID'], row['File Name'], row['Pages'],
      row['Uploaded By'], row['Status'], row['Status Detail'], row['Visit ID']],
    ['scan-new-1', 'Receipt', R4, 'fake-upload-1', 'App scan - 2023 Toyota 4Runner - 2026-09-22 1805 - Leo.pdf', 2,
      'leo@example.com', 'Waiting', '', '']);
  assert.equal(Object.prototype.toString.call(row['Uploaded At']), '[object Date]');
  assert.equal(Object.prototype.toString.call(row['Last Checked']), '[object Date]');

  assert.equal(done.received, 614400);
  assert.equal(done.done, true);
  assert.deepEqual(Object.assign({}, done.scan, { uploadedAt: 'x', lastChecked: 'x' }), {
    scanId: 'scan-new-1', kind: 'Receipt', vehicleHint: R4, fileId: 'fake-upload-1',
    fileName: 'App scan - 2023 Toyota 4Runner - 2026-09-22 1805 - Leo.pdf', pages: 2, uploadedAt: 'x',
    status: 'Waiting', statusLabel: 'Waiting to be filed',
    statusDetail: "It's in the pile. Receipts are usually filed within a few hours.", visitId: null,
    filedVehicle: null, lastChecked: 'x',
  });
  assert.match(done.scan.uploadedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[56]:00$/);
  assert.equal(env.fakes.scriptCache.get(cacheKey), null, 'bootstrap cache invalidated');

  // The new scan shows in the uploader's My scans.
  const boot = plain(env.gas.getBootstrap_('leo@example.com'));
  assert.equal(boot.myScans[0].scanId, 'scan-new-1');
});

test('upload retries: a repeated last chunk or uploadStart after done returns the scan, adds nothing', () => {
  const env = setup();
  const pdf = makePdf(300 * KB);
  const { uploadId } = env.start({ size: pdf.length });
  env.chunk(uploadId, pdf, 0, 256 * KB);
  const done = env.chunk(uploadId, pdf, 262144, 44 * KB);
  assert.equal(done.done, true);

  const putsBefore = env.puts().length;
  assert.deepEqual(env.chunk(uploadId, pdf, 262144, 44 * KB), done, 'lost response to the last chunk');
  const again = env.start({ size: pdf.length });
  assert.deepEqual(again, { done: true, scan: done.scan }, 'lost response, phone restarts');
  assert.equal(env.puts().length, putsBefore);
  assert.equal(env.drive.sessions.length, 1);
  assert.equal(env.scanRows().filter(r => r['Scan ID'] === 'scan-new-1').length, 1);

  // A scanId already on App Scans (from the fixture) is done straight away.
  const old = env.start({ scanId: 'scan-0001' });
  assert.equal(old.done, true);
  assert.equal(old.scan.fileName, 'App scan - 2023 Toyota 4Runner - 2026-09-21 1805 - Leo.pdf');
});

test('upload: an offset that is not `received` gets the current count back, nothing forwarded', () => {
  const env = setup();
  const pdf = makePdf(614400);
  const { uploadId } = env.start();
  env.chunk(uploadId, pdf, 0, 256 * KB);
  const puts = env.puts().length;
  assert.deepEqual(env.chunk(uploadId, pdf, 0, 256 * KB), { received: 262144, done: false }, 'resent chunk');
  assert.deepEqual(env.chunk(uploadId, pdf, 524288, 88 * KB), { received: 262144, done: false }, 'skipped ahead');
  assert.equal(env.puts().length, puts);
});

test('upload: the first chunk must be a PDF; chunks must fit the announced size and 256 KiB steps', () => {
  const env = setup();
  const { uploadId } = env.start();
  const notPdf = Buffer.alloc(256 * KB, 0x41);
  assert.deepEqual(apiErr(() => env.chunk(uploadId, notPdf, 0, 256 * KB)).message, "That isn't a PDF.");
  const pdf = makePdf(614400);
  assert.equal(apiErr(() => env.chunk(uploadId, pdf, 0, 100 * KB)).status, 400, 'not a multiple of 256 KiB');
  const tooMuch = makePdf(700 * KB);
  assert.equal(apiErr(() => env.chunk(uploadId, tooMuch, 0, 700 * KB)).message, 'The upload is bigger than announced.');
  assert.equal(apiErr(() => env.gas.uploadChunk_(env.ctx, { uploadId, offset: 0, data: '' })).status, 400);
  assert.equal(env.puts().length, 0);
});

test('uploadStart validation: size, pages, kind, vehicle, time', () => {
  const env = setup();
  const big = apiErr(() => env.start({ size: 25 * 1024 * 1024 + 1 }));
  assert.deepEqual([big.status, big.error], [413, 'too_large']);
  assert.ok(env.start({ scanId: 'exactly-25', size: 25 * 1024 * 1024 }).uploadId, 'exactly 25 MB is allowed');
  for (const pages of [0, 41]) assert.equal(apiErr(() => env.start({ pages })).status, 400);
  assert.equal(apiErr(() => env.start({ kind: 'Photo' })).status, 400);
  assert.equal(apiErr(() => env.start({ vehicleHint: 'Batmobile' })).message, "Pick one of the family's vehicles.");
  assert.equal(apiErr(() => env.start({ capturedAt: 'yesterday-ish' })).status, 400);
  assert.equal(apiErr(() => env.start({ size: 0 })).status, 400);
  assert.equal(env.drive.sessions.length, 1, 'only the valid start opened a Drive session');
});

test('upload: only the person who started an upload may send its chunks; unknown IDs are 404', () => {
  const env = setup();
  const pdf = makePdf(614400);
  const { uploadId } = env.start();
  const e = apiErr(() => env.chunk(uploadId, pdf, 0, 256 * KB, env.maya));
  assert.deepEqual([e.status, e.error], [403, 'forbidden']);
  const missing = apiErr(() => env.chunk('no-such-upload', pdf, 0, 256 * KB));
  assert.deepEqual([missing.status, missing.error], [404, 'not_found']);
  assert.equal(env.puts().length, 0);
});

test('upload: a second uploadStart for the same scanId in progress reuses the session', () => {
  const env = setup();
  const pdf = makePdf(614400);
  const first = env.start();
  env.chunk(first.uploadId, pdf, 0, 256 * KB);
  const second = env.start();
  assert.equal(second.uploadId, first.uploadId);
  assert.equal(env.drive.sessions.length, 1);
  // The phone starts at 0 and is told where to carry on.
  assert.deepEqual(env.chunk(second.uploadId, pdf, 0, 256 * KB), { received: 262144, done: false });
});

test('upload: an expired Drive session is 404 not_found; the phone restarts with the same scanId', () => {
  const env = setup();
  const pdf = makePdf(614400);
  const first = env.start();
  env.chunk(first.uploadId, pdf, 0, 256 * KB);
  env.drive.sessions[0].expired = true;
  const e = apiErr(() => env.chunk(first.uploadId, pdf, 262144, 256 * KB));
  assert.deepEqual([e.status, e.error, e.message], [404, 'not_found', 'This upload expired. Please start it again.']);
  assert.equal(apiErr(() => env.chunk(first.uploadId, pdf, 262144, 256 * KB)).status, 404, 'state forgotten');

  const again = env.start();
  assert.notEqual(again.uploadId, first.uploadId);
  assert.equal(env.drive.sessions.length, 2);
  env.chunk(again.uploadId, pdf, 0, 256 * KB);
  env.chunk(again.uploadId, pdf, 262144, 256 * KB);
  assert.equal(env.chunk(again.uploadId, pdf, 524288, 88 * KB).done, true);
  assert.equal(env.scanRows().filter(r => r['Scan ID'] === 'scan-new-1').length, 1);
});

test('upload: Drive keeping fewer bytes than sent (308 Range) moves `received` back', () => {
  const env = setup({ drive: { persistAlign: 512 * KB } });
  const pdf = makePdf(1024 * KB);
  const { uploadId } = env.start({ size: pdf.length });
  assert.deepEqual(env.chunk(uploadId, pdf, 0, 768 * KB), { received: 524288, done: false });
  assert.equal(env.chunk(uploadId, pdf, 524288, 512 * KB).done, true);
  assert.ok(fromSigned(env.services.drive.files.get('fake-upload-1').bytes).equals(pdf));
});

test('upload: a Drive 503 or a lost reply is resynced with a status query, and the upload completes', () => {
  const env = setup();
  const pdf = makePdf(614400);
  const { uploadId } = env.start();

  env.drive.sessions[0].fail = 1;  // next PUT → 503
  assert.deepEqual(env.chunk(uploadId, pdf, 0, 256 * KB), { received: 0, done: false });
  assert.deepEqual(env.chunk(uploadId, pdf, 0, 256 * KB), { received: 262144, done: false });

  env.drive.sessions[0].loseResponse = true;  // Drive stores the chunk, the reply is lost
  assert.throws(() => env.chunk(uploadId, pdf, 262144, 256 * KB), /Timeout/);
  // The phone retries the same chunk: the API asks Drive first and moves on.
  assert.deepEqual(env.chunk(uploadId, pdf, 262144, 256 * KB), { received: 524288, done: false });
  const statusQuery = env.puts().filter(p => p.opts.headers['Content-Range'] === 'bytes */614400');
  assert.equal(statusQuery.length, 2);
  assert.equal(env.chunk(uploadId, pdf, 524288, 88 * KB).done, true);
  assert.ok(fromSigned(env.services.drive.files.get('fake-upload-1').bytes).equals(pdf));
});

test('scan file names: prefix per kind, Chicago time, first name, (2) when taken', () => {
  const env = setup();
  const { gas } = env;
  const leo = { name: 'Leo Sample', email: 'leo@example.com' };
  const at = new Date('2026-01-05T15:07:00Z');  // 9:07 AM CST
  assert.equal(gas.scanFileName_('Receipt', R4, at, leo), 'App scan - 2023 Toyota 4Runner - 2026-01-05 0907 - Leo.pdf');
  assert.equal(gas.scanFileName_('Upload', R4, at, leo), 'App upload - 2023 Toyota 4Runner - 2026-01-05 0907 - Leo.pdf');
  assert.equal(gas.scanFileName_('Owner entry', R4, at, leo),
    'App owner entry - 2023 Toyota 4Runner - 2026-01-05 0907 - Leo.pdf');
  const name = 'App scan - X - 2026-01-05 0907 - Leo.pdf';
  assert.equal(gas.uniqueScanFileName_(name, []), name);
  assert.equal(gas.uniqueScanFileName_(name, [name.toUpperCase()]), 'App scan - X - 2026-01-05 0907 - Leo (2).pdf');
  assert.equal(gas.uniqueScanFileName_(name, [name, 'App scan - X - 2026-01-05 0907 - Leo (2).pdf']),
    'App scan - X - 2026-01-05 0907 - Leo (3).pdf');

  // Through uploadStart: the fixture already has Leo's 2026-09-21 18:05 4Runner scan.
  env.start({ scanId: 'scan-dup', capturedAt: '2026-09-21T18:05:30-05:00' });
  assert.equal(JSON.parse(env.services.urlFetch.calls[0].opts.payload).name,
    'App scan - 2023 Toyota 4Runner - 2026-09-21 1805 - Leo (2).pdf');
});

test('upload through doPost: a chunk from another user is refused as JSON', () => {
  const env = setup();
  const now = Math.floor(Date.now() / 1000);
  const post = body => JSON.parse(env.gas.doPost({ postData: { contents: JSON.stringify(body) } }).getContent());
  const leo = env.gas.issueSession_('leo@example.com', now).token;
  const maya = env.gas.issueSession_('maya@example.com', now).token;
  const started = post({ action: 'uploadStart', session: leo, scanId: 'dp-scan', kind: 'Upload', vehicleHint: R4,
    size: 1000, pages: 1, capturedAt: '2026-09-22T12:00:00-05:00' });
  assert.equal(started.ok, true);
  const data = makePdf(1000).toString('base64');
  assert.equal(post({ action: 'uploadChunk', session: maya, uploadId: started.uploadId, offset: 0, data }).status, 403);
  const done = post({ action: 'uploadChunk', session: leo, uploadId: started.uploadId, offset: 0, data });
  assert.deepEqual([done.ok, done.done, done.received, done.scan.kind], [true, true, 1000, 'Upload']);
});

test('regression: uploadStart never hands someone else\'s scan or upload session to the caller', () => {
  const env = setup();
  // scan-0001 is Leo's: Maya retrying "his" scanId learns nothing about it.
  const e = apiErr(() => env.start({ scanId: 'scan-0001' }, env.maya));
  assert.deepEqual([e.status, e.error, e.message], [403, 'forbidden', 'That upload belongs to someone else.']);
  assert.equal(env.start({ scanId: 'scan-0001' }).done, true, 'Leo still gets his own row back');

  // Leo's upload in progress: Maya can't take over its session with the same scanId.
  const pdf = makePdf(614400);
  const leo = env.start({ scanId: 'scan-in-flight' });
  env.chunk(leo.uploadId, pdf, 0, 256 * KB);
  const taken = apiErr(() => env.start({ scanId: 'scan-in-flight' }, env.maya));
  assert.deepEqual([taken.status, taken.error], [403, 'forbidden']);
  assert.equal(env.drive.sessions.length, 1, 'no second Drive session was opened');
  assert.deepEqual(env.chunk(leo.uploadId, pdf, 262144, 256 * KB), { received: 524288, done: false });
});

test('regression: an uploadChunk bigger than one chunk is refused before it is decoded', () => {
  const env = setup();
  const post = body => JSON.parse(JSON.stringify(env.gas.handlePost_({ postData: { contents: JSON.stringify(body) } })));
  const session = env.gas.issueSession_('leo@example.com', Math.floor(Date.now() / 1000)).token;
  const { uploadId } = env.start();
  const r = post({ action: 'uploadChunk', session, uploadId, offset: 0, data: 'A'.repeat(2796204 + 8) });
  assert.deepEqual([r.status, r.error, r.detail && r.detail.field], [400, 'bad_request', 'data']);
  assert.equal(env.puts().length, 0);
});
