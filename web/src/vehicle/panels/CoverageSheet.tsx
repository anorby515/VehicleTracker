/**
 * Coverage (spec 8.3): warranties and prepaid plans, active ones first,
 * with when each ends (date or mileage, whichever comes first) and what it
 * covers. Active = before the End Date and under the End Miles (the API
 * decides; blank limits don't count).
 */

import type { JSX } from 'preact';
import type { CoveragePlan, Vehicle } from '../../api/types';
import { formatDate, formatMiles } from '../../lib/format';
import { Sheet } from '../../ui/Sheet';
import { ownerName } from '../common';
import { coverageEndText, coversText } from '../display';

export function CoverageSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const plans = [...v.coverage].sort((a, b) => Number(b.active) - Number(a.active));
  return (
    <Sheet title="Coverage" onClose={props.onClose} class="coverage-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
        <p class="secondary">Warranties and prepaid plans. Check here before paying for work that may already be covered.</p>
      </div>
      {plans.length
        ? (
          <section class="section" aria-label="Plans">
            <div class="group">{plans.map(p => <PlanRow key={p.name} plan={p} />)}</div>
            <p class="section-footer">
              Mileage limits are converted to a date using the average miles a day. {ownerName()} keeps plans in the Warranties tab.
            </p>
          </section>
        )
        : <p class="empty">No warranties or plans listed. {ownerName()} adds them in the Sheet.</p>}
    </Sheet>
  );
}

function PlanRow(props: { plan: CoveragePlan }): JSX.Element {
  const p = props.plan;
  const covers = coversText(p);
  const started = [p.startDate ? `Started ${formatDate(p.startDate)}` : null, p.startMiles ? `at ${formatMiles(p.startMiles)}` : null].filter(Boolean).join(' ');
  return (
    <div class={`row plan-row${p.active ? '' : ' plan-ended'}`}>
      <div class="row-main stack">
        <span class="plan-head">
          <span class="row-title plan-name">{p.name}</span>
          <span class={`badge ${p.active ? 'badge-covered' : 'badge-nohistory'}`}>{p.active ? 'Active' : 'Ended'}</span>
        </span>
        {p.type && <span class="row-sub">{p.type}</span>}
        <span class="row-sub plan-ends">{coverageEndText(p)}</span>
        <span class="row-sub">{covers ?? 'What it covers isn’t listed yet'}</span>
        {started && <span class="row-sub footnote">{started}</span>}
        {p.notes && <span class="row-sub footnote">{p.notes}</span>}
      </div>
    </div>
  );
}
