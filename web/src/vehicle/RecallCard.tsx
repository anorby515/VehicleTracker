/**
 * One recall (spec 8.9), shared by the Recalls panel and the Upcoming item
 * sheet. NHTSA results are for the model, not the exact car, so the copy
 * says "May apply to this model" and offers a VIN check.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Recall, RecallAppStatus, Vehicle } from '../api/types';
import { config } from '../config';
import { formatDate } from '../lib/format';
import { setRecallStatus } from '../state/recalls';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/toast';
import { copyWithToast } from './common';

/** Sentence-case an NHTSA component ("AIR BAGS:FRONTAL" → "Air bags: frontal"). */
export function recallComponentText(component: string | null): string {
  if (!component) return 'Recall';
  const s = component.split(':').map(p => p.trim().toLowerCase()).filter(Boolean).join(': ');
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export function nhtsaVinUrl(vin: string | null): string {
  return vin ? `${config.nhtsaRecallsUrl}?vin=${encodeURIComponent(vin)}` : config.nhtsaRecallsUrl;
}

/**
 * "Check your VIN on nhtsa.gov" (config.nhtsaRecallsUrl + "?vin=" + VIN).
 * Opening it also copies the VIN, in case the site ignores ?vin=; a
 * separate "Copy VIN" button is there too.
 */
export function VinCheckLink(props: { vehicle: Vehicle; class?: string }): JSX.Element {
  const vin = props.vehicle.vin;
  return (
    <>
      <a
        class={props.class ?? 'btn btn-block'}
        href={nhtsaVinUrl(vin)}
        target="_blank"
        rel="noopener"
        onClick={() => { if (vin) copyWithToast(vin, 'VIN copied'); }}
      >
        <Icon name="external" size={20} /> Check your VIN on nhtsa.gov
      </a>
      {vin && (
        <button type="button" class="btn btn-plain btn-block" onClick={() => copyWithToast(vin, 'VIN copied')} aria-label={`Copy VIN ${vin}`}>
          <Icon name="copy" size={20} /> Copy VIN <span class="num secondary">{vin}</span>
        </button>
      )}
    </>
  );
}

const DONE_TOAST: Record<RecallAppStatus, string> = {
  'Done': 'Marked done',
  'Not applicable': 'Marked as not applying',
  'New': 'Marked as new',
};

/**
 * Done / Doesn't apply on a New recall, "Mark as new" on any other. Saved to
 * the Recalls tab's Status (with who and when in Notes), so it moves out of
 * Upcoming for everyone.
 */
function RecallActions(props: { vehicle: Vehicle; recall: Recall; isNew: boolean }): JSX.Element {
  const [busy, setBusy] = useState(false);
  const what = recallComponentText(props.recall.component);
  const set = async (status: RecallAppStatus) => {
    setBusy(true);
    const res = await setRecallStatus(props.vehicle.name, props.recall.campaignNumber, status);
    setBusy(false);
    toast(res.ok ? DONE_TOAST[status] : res.message);
  };
  if (!props.isNew) {
    return (
      <div class="recall-actions">
        <button type="button" class="btn btn-plain btn-small" disabled={busy} onClick={() => void set('New')}
          aria-label={`Mark the ${what} recall as new again`}>
          Mark as new
        </button>
      </div>
    );
  }
  return (
    <div class="recall-actions">
      <p class="footnote">Fixed already, or not on your VIN? Mark it so it stops showing as new.</p>
      <div class="recall-actions-row">
        <button type="button" class="btn btn-small" disabled={busy} onClick={() => void set('Done')}
          aria-label={`Mark the ${what} recall done`}>
          <Icon name="check" size={18} /> Done
        </button>
        <button type="button" class="btn btn-small" disabled={busy} onClick={() => void set('Not applicable')}
          aria-label={`Mark the ${what} recall as not applying to this vehicle`}>
          Doesn’t apply
        </button>
      </div>
    </div>
  );
}

export function RecallCard(props: { recall: Recall; vehicle?: Vehicle }): JSX.Element {
  const r = props.recall;
  const isNew = (r.status ?? '').toLowerCase() === 'new';
  return (
    <article class="recall-card" aria-label={recallComponentText(r.component)}>
      {r.parkIt && (
        <div class="callout callout-danger recall-warning">
          <Icon name="alert" />
          <p><strong>Do not drive until repaired.</strong> NHTSA says this vehicle shouldn’t be driven until the fix is done.</p>
        </div>
      )}
      {r.parkOutside && (
        <div class="callout callout-warn recall-warning">
          <Icon name="alert" />
          <p><strong>Park outside</strong>, away from buildings, until it’s repaired (fire risk).</p>
        </div>
      )}
      <div class="group">
        <div class="row recall-head">
          <div class="row-main stack">
            <span class="row-title recall-component">{recallComponentText(r.component)}</span>
            <span class="row-sub">
              {r.reportDate ? `Reported ${formatDate(r.reportDate)}` : 'Report date not listed'} · Campaign {r.campaignNumber}
            </span>
          </div>
          <span class={`badge ${isNew ? 'badge-recall' : 'badge-ok'}`}>{r.status || 'New'}</span>
        </div>
        {r.summary && <p class="vsheet-text recall-summary">{r.summary}</p>}
        {r.consequence && (
          <p class="vsheet-text recall-consequence"><strong>What could happen: </strong>{r.consequence}</p>
        )}
        {r.remedy && (
          <details class="recall-remedy">
            <summary class="row tappable"><span class="row-main">How it’s fixed</span><Icon name="chevronDown" size={18} class="row-chevron" /></summary>
            <p class="vsheet-text">{r.remedy}</p>
          </details>
        )}
        {r.notes && <p class="vsheet-text footnote recall-notes">Note: {r.notes}</p>}
        {props.vehicle && <RecallActions vehicle={props.vehicle} recall={r} isNew={isNew} />}
      </div>
    </article>
  );
}
