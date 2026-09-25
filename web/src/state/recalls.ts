/**
 * The recall buttons: Done, Doesn't apply, and Mark as new (undo). The
 * Recalls tab is the record, so the change is saved there first and then
 * shown here; the refresh after it updates Upcoming and the banner.
 */

import { ApiFailure, NetworkError, call } from '../api/client';
import type { RecallAppStatus } from '../api/types';
import { bootstrap, refresh } from './store';

export type RecallStatusOutcome = { ok: true } | { ok: false; message: string };

export async function setRecallStatus(
  vehicle: string,
  campaignNumber: string,
  status: RecallAppStatus,
): Promise<RecallStatusOutcome> {
  try {
    const res = await call('setRecallStatus', { vehicle, campaignNumber, status });
    const b = bootstrap.value;
    if (b) {
      bootstrap.value = {
        ...b,
        vehicles: b.vehicles.map(v => (v.name !== vehicle ? v : {
          ...v,
          recalls: v.recalls.map(r => (r.campaignNumber === campaignNumber ? res.recall : r)),
        })),
      };
    }
    void refresh();
    return { ok: true };
  } catch (e) {
    if (e instanceof NetworkError) return { ok: false, message: 'No connection. Try again when you’re online.' };
    if (e instanceof ApiFailure) return { ok: false, message: e.message };
    return { ok: false, message: 'Couldn’t save that. Try again.' };
  }
}
