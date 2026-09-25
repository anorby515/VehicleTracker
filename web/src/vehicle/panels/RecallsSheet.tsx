/**
 * Recalls (spec 8.9): every Recalls row for the vehicle, newest first. The
 * lookup is by model, so each may or may not apply to this exact car.
 */

import type { JSX } from 'preact';
import type { Vehicle } from '../../api/types';
import { Sheet } from '../../ui/Sheet';
import { ownerName } from '../common';
import { RecallCard, VinCheckLink } from '../RecallCard';

export function RecallsSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const open = v.recalls.filter(r => (r.status ?? '').toLowerCase() === 'new');
  const rest = v.recalls.filter(r => (r.status ?? '').toLowerCase() !== 'new');
  return (
    <Sheet title="Recalls" onClose={props.onClose} class="recalls-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
        <p class="secondary">
          May apply to this model. NHTSA lists recalls by model, not by your exact vehicle, so check your VIN to be sure.
        </p>
      </div>
      <div class="vsheet-actions"><VinCheckLink vehicle={v} /></div>

      {v.recalls.length === 0 && <p class="empty">No recalls found for this model.</p>}

      {open.length > 0 && (
        <section class="section" aria-labelledby="recalls-new">
          <div class="section-header"><h3 id="recalls-new">New</h3></div>
          <div class="recall-list">{open.map(r => <RecallCard key={r.campaignNumber} recall={r} vehicle={v} />)}</div>
        </section>
      )}
      {rest.length > 0 && (
        <section class="section" aria-labelledby="recalls-old">
          <div class="section-header"><h3 id="recalls-old">Already looked at</h3></div>
          <div class="recall-list">{rest.map(r => <RecallCard key={r.campaignNumber} recall={r} vehicle={v} />)}</div>
          <p class="section-footer">{ownerName()} updates each recall’s status in the Sheet.</p>
        </section>
      )}
    </Sheet>
  );
}
