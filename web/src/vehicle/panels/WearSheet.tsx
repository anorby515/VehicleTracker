/**
 * Wear (spec 8.7): tire tread and brake pads from Inspection Readings, with
 * the replacement points (tread 4/32 in, pads 3 mm, named constants in the
 * API) and a projection when there are two or more readings.
 */

import type { JSX } from 'preact';
import type { Vehicle, WearItem } from '../../api/types';
import { formatDate, formatMiles } from '../../lib/format';
import { href } from '../../state/router';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { RouteLink } from '../common';
import { WearChart } from '../VehicleCharts';
import { formatWearValue, replacementPointText, wearProjectionText } from '../display';

export function WearSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const items = [v.wear.tread, v.wear.brakeFront, v.wear.brakeRear].filter((w): w is WearItem => !!w);
  return (
    <Sheet title="Wear" onClose={props.onClose} class="wear-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
        <p class="secondary">Tire tread is the lowest of the four tires. Brake pads are the lowest front and rear.</p>
      </div>
      {items.length
        ? items.map(w => <WearBlock key={w.label} vehicle={v} item={w} />)
        : <p class="empty">No tread or brake readings yet. They’re added from inspection sheets on receipts.</p>}
    </Sheet>
  );
}

function WearBlock(props: { vehicle: Vehicle; item: WearItem }): JSX.Element {
  const { vehicle: v, item } = props;
  const headingId = `wear-${item.label.replace(/\W+/g, '-').toLowerCase()}`;
  const l = item.latest;
  const projection = wearProjectionText(item, v.estMileage);
  const low = l.value <= item.replacementPoint;
  return (
    <section class="section wear-block" aria-labelledby={headingId}>
      <div class="section-header"><h3 id={headingId}>{item.label}</h3></div>
      <div class="group">
        <div class="row">
          <div class="row-main stack">
            <span class="wear-value">{formatWearValue(l.value, item.unit)}</span>
            <span class="row-sub">
              {[l.date ? formatDate(l.date) : null, l.mileage !== null ? formatMiles(l.mileage) : null].filter(Boolean).join(' · ') || 'Date not recorded'}
            </span>
          </div>
          {l.rating && <span class={`badge ${low || /replace|bad|red/i.test(l.rating) ? 'badge-overdue' : /caution|yellow|monitor/i.test(l.rating) ? 'badge-soon' : 'badge-ok'}`}>{l.rating}</span>}
        </div>
        <div class="row">
          <div class="row-main stack">
            {projection && <span class="row-title wear-projection">{projection}</span>}
            <span class="row-sub">{replacementPointText(item)}</span>
          </div>
        </div>
        {l.visitId && (
          <RouteLink href={href.visit(v.name, l.visitId)} class="row tappable">
            <span class="row-main link-text">See the latest inspection</span>
            <Icon name="chevronRight" class="row-chevron" size={18} />
          </RouteLink>
        )}
      </div>
      {item.readings.some(r => r.mileage !== null) && <div class="wear-chart"><WearChart item={item} /></div>}
    </section>
  );
}
