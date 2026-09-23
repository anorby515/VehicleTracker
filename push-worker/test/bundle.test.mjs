import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { bundle } from '../scripts/bundle.mjs';
import { makeSubscription, makeVapidKeys } from './helpers.mjs';

test('the dashboard bundle is one self-contained module that works like src/', async (t) => {
  const code = bundle();
  assert.doesNotMatch(code, /^\s*import\b/m);
  assert.deepEqual(code.match(/^export\b.*$/gm), ['export default {']);

  // Load it as a module from a temp dir, then run a real send through it.
  const dir = mkdtempSync(join(tmpdir(), 'vehicles-push-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, 'worker.mjs');
  writeFileSync(file, code);
  const { default: worker } = await import(pathToFileURL(file).href);

  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response(null, { status: 201 }); };
  t.after(() => { globalThis.fetch = original; });

  const vapid = makeVapidKeys();
  const env = { PUSH_SECRET: 's', VAPID_PUBLIC_KEY: vapid.publicKey, VAPID_PRIVATE_KEY: vapid.privateKey, VAPID_SUBJECT: 'mailto:owner@example.com' };
  const health = await worker.fetch(new Request('https://w.example/'), env);
  assert.deepEqual(await health.json(), { ok: true, service: 'vehicles-push' });

  const sub = makeSubscription('https://web.push.apple.com/QFake');
  const res = await worker.fetch(new Request('https://w.example/send', {
    method: 'POST',
    headers: { Authorization: 'Bearer s' },
    body: JSON.stringify({ messages: [{ id: 'a', subscription: sub.subscription, payload: { title: 'Test notification', body: '', url: 'https://example.github.io/VehicleTracker/', tag: 'test' } }] }),
  }), env);
  assert.deepEqual(await res.json(), { results: [{ id: 'a', status: 201, ok: true, gone: false }] });
  assert.equal(JSON.parse(sub.decrypt(calls[0].init.body).plaintext).notification.title, 'Test notification');
});
