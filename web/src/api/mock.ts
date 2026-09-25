/**
 * In-memory stand-in for the App API, used by `npm run dev:mock`, the
 * Playwright tests, and whenever app.config.json has no apiUrl yet.
 *
 * Data comes from src/mock/bootstrap.<name>.json, generated from the
 * synthetic Sheet fixture by `npm run fixture` (apps-script/test/make-fixture.js),
 * so the mock always matches what the real API would build.
 *
 * Sign-in in mock mode: the "idToken" is simply one of the fixture emails.
 */

import type { Bootstrap, Scan, ScanKind } from './types';

interface MockIndex { users: { email: string; name: string; file: string }[] }

const files = import.meta.glob('../mock/*.json', { eager: true, import: 'default' }) as Record<string, unknown>;

export function mockIndex(): MockIndex {
  return (files['../mock/index.json'] as MockIndex | undefined) ?? { users: [] };
}

function bootstrapFor(email: string): Bootstrap | null {
  const entry = mockIndex().users.find(u => u.email.toLowerCase() === email.toLowerCase());
  if (!entry) return null;
  const b = files[`../mock/${entry.file}`] as Bootstrap | undefined;
  return b ? structuredClone(b) : null;
}

interface MockState {
  uploads: Map<string, { scanId: string; kind: ScanKind; vehicleHint: string; size: number; pages: number; received: number; email: string }>;
  scans: Map<string, Scan[]>;             // email → extra scans uploaded in this session
  odometer: Map<string, { vehicle: string; mileage: number; date: string }[]>;
  recalls: Map<string, { status: string; notes: string }>;  // "email|vehicle|campaign" → set in this session
  pairCodes: Map<string, string>;
  failNext: number;
}

const state: MockState = {
  uploads: new Map(),
  scans: new Map(),
  odometer: new Map(),
  recalls: new Map(),
  pairCodes: new Map(),
  failNext: 0,
};

/** Test hook: make the next N calls fail as if offline. */
export function mockFailNext(n: number): void {
  state.failNext = n;
}

const ok = <T extends object>(data: T) => ({ ok: true, ...data });

/** Recall statuses set in this session, applied the way the real API would (Upcoming and the banner only count New). */
function applyRecallStatuses(email: string, b: Bootstrap): void {
  for (const v of b.vehicles) {
    for (const r of v.recalls) {
      const set = state.recalls.get(`${email}|${v.name}|${r.campaignNumber}`);
      if (!set) continue;
      r.status = set.status;
      r.notes = set.notes;
      if (set.status !== 'New') v.upcoming = v.upcoming.filter(u => u.recall?.campaignNumber !== r.campaignNumber);
    }
    const fresh = v.recalls.filter(r => (r.status ?? '').toLowerCase() === 'new').length;
    v.attention = v.attention.flatMap(a => {
      if (a.kind !== 'recall') return [a];
      if (!fresh) return [];
      return [{ ...a, text: `${fresh === 1 ? 'New recall may' : `${fresh} new recalls may`} apply to the ${v.shortName}` }];
    });
  }
}
const err = (status: number, error: string, message: string, detail?: Record<string, unknown>) =>
  ({ ok: false, status, error, message, detail });

/** Mock sessions are stateless ("mock.<base64 email>") so they survive a page reload. */
export function mockSessionFor(email: string): string {
  return `mock.${btoa(email.toLowerCase())}`;
}

function emailFor(session: unknown): string | null {
  if (typeof session !== 'string' || !session.startsWith('mock.')) return null;
  try {
    const email = atob(session.slice(5));
    return bootstrapFor(email) ? email : null;
  } catch {
    return null;
  }
}

function signInAs(email: string) {
  const b = bootstrapFor(email);
  if (!b) return err(403, 'not_family', 'This app is for the family.');
  return ok({ session: mockSessionFor(email), sessionExpiresAt: new Date(Date.now() + 60 * 864e5).toISOString(), user: b.user });
}

export async function mockTransport(body: Record<string, unknown>): Promise<unknown> {
  await new Promise(r => setTimeout(r, 120));
  if (state.failNext > 0) {
    state.failNext--;
    throw new TypeError('Failed to fetch');
  }
  const action = body.action as string;

  if (action === 'signIn') return signInAs(String(body.idToken || ''));
  if (action === 'pairRedeem') {
    const email = state.pairCodes.get(String(body.code || '').toUpperCase());
    if (!email) return err(401, 'not_signed_in', 'That code didn’t work. Codes last 10 minutes.');
    state.pairCodes.delete(String(body.code).toUpperCase());
    return signInAs(email);
  }

  const email = emailFor(body.session);
  if (!email) return err(401, 'not_signed_in', 'Please sign in again.');

  switch (action) {
    case 'bootstrap': {
      const b = bootstrapFor(email)!;
      b.generatedAt = new Date().toISOString();
      const extra = state.scans.get(email) ?? [];
      b.myScans = [...extra, ...b.myScans];
      for (const r of state.odometer.get(email) ?? []) {
        const v = b.vehicles.find(x => x.name === r.vehicle);
        if (v && (v.latestOdometer ?? 0) <= r.mileage) {
          v.latestOdometer = r.mileage;
          v.latestOdometerDate = r.date;
          v.estMileage = r.mileage;
          v.lastMileageEvidenceDate = r.date;
          v.attention = v.attention.filter(a => a.kind !== 'odometer');
        }
      }
      applyRecallStatuses(email, b);
      return ok({ bootstrap: b });
    }
    case 'pairCreate': {
      const code = Math.random().toString(36).slice(2, 10).toUpperCase();
      state.pairCodes.set(code, email);
      return ok({ code, expiresAt: new Date(Date.now() + 600e3).toISOString() });
    }
    case 'getFile': {
      // A 1×1 PNG or a tiny one-page PDF, depending on what was asked for.
      const fileId = String(body.fileId || '');
      if (fileId.startsWith('forbidden')) return err(403, 'forbidden', 'That file isn’t part of this app.');
      const isPhoto = body.purpose === 'photo';
      return ok({
        fileId,
        name: isPhoto ? 'photo.png' : 'document.pdf',
        mimeType: isPhoto ? 'image/png' : 'application/pdf',
        size: 100,
        data: isPhoto ? TINY_PNG : TINY_PDF,
      });
    }
    case 'addOdometer': {
      const b = bootstrapFor(email)!;
      const v = b.vehicles.find(x => x.name === body.vehicle);
      if (!v) return err(400, 'bad_request', 'Unknown vehicle.');
      const mileage = Number(body.mileage);
      const latest = Math.max(v.latestOdometer ?? 0, ...(state.odometer.get(email) ?? []).filter(r => r.vehicle === v.name).map(r => r.mileage));
      if (mileage < latest) {
        return err(409, 'below_latest', 'That’s lower than the last reading.', { mileage: latest, date: v.latestOdometerDate });
      }
      if (v.estMileage !== null && mileage > v.estMileage + 5000 && !body.confirmHigh) {
        return err(409, 'confirm_high', 'That’s a lot more than expected.', { estimate: v.estMileage });
      }
      const date = (body.date as string) || b.today;
      const list = state.odometer.get(email) ?? [];
      list.push({ vehicle: v.name, mileage, date });
      state.odometer.set(email, list);
      return ok({
        reading: { readingId: String(body.clientId), vehicle: v.name, date, mileage, enteredBy: b.user.name, enteredAt: new Date().toISOString(), note: (body.note as string) || null },
        latestOdometer: mileage,
        latestOdometerDate: date,
      });
    }
    case 'setRecallStatus': {
      const b = bootstrapFor(email)!;
      applyRecallStatuses(email, b);
      const v = b.vehicles.find(x => x.name === body.vehicle);
      const r = v?.recalls.find(x => x.campaignNumber === body.campaignNumber);
      if (!v || !r) return err(404, 'not_found', 'That recall isn’t on the list any more.');
      const status = String(body.status);
      if ((r.status ?? 'New').toLowerCase() !== status.toLowerCase()) {
        const line = `Marked ${status} by ${b.user.name} on ${b.today}`;
        r.status = status;
        r.notes = r.notes ? `${r.notes}\n${line}` : line;
        state.recalls.set(`${email}|${v.name}|${r.campaignNumber}`, { status, notes: r.notes });
      }
      return ok({ recall: r });
    }
    case 'uploadStart': {
      const scanId = String(body.scanId);
      const existing = (state.scans.get(email) ?? []).find(s => s.scanId === scanId);
      if (existing) return ok({ done: true, scan: existing });
      if (Number(body.size) > 25 * 1024 * 1024) return err(413, 'too_large', 'That’s over 25 MB.');
      const uploadId = `up-${scanId}`;
      state.uploads.set(uploadId, {
        scanId, kind: body.kind as ScanKind, vehicleHint: String(body.vehicleHint), size: Number(body.size),
        pages: Number(body.pages), received: 0, email,
      });
      return ok({ uploadId, chunkSize: 2 * 1024 * 1024 });
    }
    case 'uploadChunk': {
      const up = state.uploads.get(String(body.uploadId));
      if (!up || up.email !== email) return err(404, 'not_found', 'Upload expired. Starting again.');
      if (Number(body.offset) !== up.received) return ok({ received: up.received, done: false });
      up.received += atob(String(body.data)).length;
      if (up.received < up.size) return ok({ received: up.received, done: false });
      const b = bootstrapFor(email)!;
      const prefix = up.kind === 'Receipt' ? 'App scan' : up.kind === 'Upload' ? 'App upload' : 'App owner entry';
      const scan: Scan = {
        scanId: up.scanId, kind: up.kind, vehicleHint: up.vehicleHint, fileId: `mock-${up.scanId}`,
        fileName: `${prefix} - ${up.vehicleHint} - ${b.today} 1200 - ${b.user.name}.pdf`, pages: up.pages,
        uploadedAt: new Date().toISOString(), status: 'Waiting', statusLabel: 'Waiting to be filed',
        statusDetail: 'It’s in the pile. It’s usually filed within a few hours.', visitId: null, filedVehicle: null,
        lastChecked: new Date().toISOString(),
      };
      state.scans.set(email, [scan, ...(state.scans.get(email) ?? [])]);
      state.uploads.delete(String(body.uploadId));
      return ok({ received: up.size, done: true, scan });
    }
    case 'savePrefs':
      return ok({ prefs: body.prefs as object });
    case 'testPush':
      return ok({ sent: 1, failed: 0 });
    case 'subscribePush':
    case 'unsubscribePush':
    case 'signOut':
      return ok({ done: true });
    default:
      return err(400, 'bad_request', `Unknown action ${action}`);
  }
}

const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const TINY_PDF = btoa(
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj\n' +
  '4 0 obj<</Length 44>>stream\nBT /F1 18 Tf 20 100 Td (Sample receipt) Tj ET\nendstream endobj\n' +
  '5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF',
);
