/**
 * One recall (spec 8.9), shared by the Recalls panel and the Upcoming item
 * sheet. NHTSA results are for the model, not the exact car, so the copy
 * says "May apply to this model" and offers a VIN check.
 */

import type { JSX } from 'preact';
import type { Recall, Vehicle } from '../api/types';
import { config } from '../config';
import { formatDate } from '../lib/format';
import { Icon } from '../ui/Icon';
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

export function RecallCard(props: { recall: Recall }): JSX.Element {
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
        {r.notes && <p class="vsheet-text footnote">Note: {r.notes}</p>}
      </div>
    </article>
  );
}
