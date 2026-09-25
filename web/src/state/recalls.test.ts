import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setTransport } from '../api/client';
import type { Bootstrap, Recall } from '../api/types';
import { clearAll } from '../lib/db';
import { setRecallStatus } from './recalls';
import { bootstrap, resetDevice, session } from './store';

const RECALL: Recall = {
  campaignNumber: '26V901000', reportDate: '2026-08-20', component: 'AIR BAGS:FRONTAL', summary: 'Sample.',
  consequence: null, remedy: null, status: 'New', firstSeen: '2026-08-21', notes: null, parkIt: false, parkOutside: false,
};
const JEEP = '2016 Jeep Wrangler';

let sent: Record<string, unknown>[] = [];
let reply: (body: Record<string, unknown>) => unknown;

beforeEach(async () => {
  await clearAll();
  sent = [];
  session.value = 'test-session';
  bootstrap.value = {
    user: { email: 'robert@example.com', name: 'Robert' },
    vehicles: [{ name: JEEP, recalls: [RECALL] }, { name: '2023 BMW X7', recalls: [{ ...RECALL }] }],
  } as unknown as Bootstrap;
  setTransport(async body => {
    sent.push(body);
    return reply(body);
  });
});

afterEach(async () => { await resetDevice(); });

describe('setRecallStatus', () => {
  it('saves the status, then shows the recall as the server returned it on that vehicle only', async () => {
    reply = b => (b.action === 'setRecallStatus'
      ? { ok: true, recall: { ...RECALL, status: 'Done', notes: 'Marked Done by Robert on 2026-09-25' } }
      : { ok: false, status: 500, error: 'server_error', message: 'not in this test' });
    expect(await setRecallStatus(JEEP, '26V901000', 'Done')).toEqual({ ok: true });
    expect(sent[0]).toMatchObject({ action: 'setRecallStatus', vehicle: JEEP, campaignNumber: '26V901000', status: 'Done' });
    const [jeep, bmw] = bootstrap.value!.vehicles;
    expect(jeep.recalls[0].status).toBe('Done');
    expect(jeep.recalls[0].notes).toBe('Marked Done by Robert on 2026-09-25');
    expect(bmw.recalls[0].status).toBe('New');
  });

  it('reports no connection, or the server’s message, and leaves the recall as it was', async () => {
    reply = () => { throw new TypeError('Failed to fetch'); };
    expect(await setRecallStatus(JEEP, '26V901000', 'Done')).toEqual({ ok: false, message: 'No connection. Try again when you’re online.' });
    reply = () => ({ ok: false, status: 404, error: 'not_found', message: 'That recall isn’t on the list any more.' });
    expect(await setRecallStatus(JEEP, '26V901000', 'Not applicable')).toEqual({ ok: false, message: 'That recall isn’t on the list any more.' });
    expect(bootstrap.value!.vehicles[0].recalls[0].status).toBe('New');
  });
});
