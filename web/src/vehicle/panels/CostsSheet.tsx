/**
 * Costs (spec 8.6). All numbers come from the bootstrap (the API sums
 * Invoice Totals since purchase, leaving out the purchase itself).
 */

import type { JSX } from 'preact';
import type { Vehicle } from '../../api/types';
import { formatDate, formatMoney, formatMoneyWhole } from '../../lib/format';
import { Sheet } from '../../ui/Sheet';
import { SpendByYearChart } from '../VehicleCharts';
import { visitsWithoutTotalText } from '../display';

export function CostsSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const c = v.costs;
  const missing = visitsWithoutTotalText(c.visitsWithoutTotal);
  const typeMax = c.byServiceType.reduce((m, t) => Math.max(m, t.total), 0) || 1;
  return (
    <Sheet title="Costs" onClose={props.onClose} class="costs-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
        <p class="secondary">{v.purchaseDate ? `Since you bought it on ${formatDate(v.purchaseDate)}` : 'All recorded visits'}</p>
      </div>

      <div class="stat-grid">
        <Stat label="This year" value={formatMoney(c.thisYear)} />
        <Stat label="Last 12 months" value={formatMoney(c.last12Months)} />
        <Stat label="Since purchase" value={formatMoney(c.sincePurchase)} />
        <Stat label="Cost per mile" value={c.costPerMile !== null ? formatMoney(c.costPerMile) : '—'} />
      </div>
      <p class="section-footer costs-footnote">
        {missing ? `${missing}, so the real totals are a little higher. ` : ''}
        {c.costPerMile === null ? 'Cost per mile needs the purchase mileage and a newer reading. ' : ''}
        Totals are what the receipts say, without the purchase itself.
      </p>

      {c.byYear.length > 0 && (
        <section class="section" aria-labelledby="costs-year">
          <div class="section-header"><h3 id="costs-year">Spend per year</h3></div>
          <SpendByYearChart data={c.byYear} title={`Spend per year on the ${v.shortName || v.name}`} />
        </section>
      )}

      <section class="section" aria-labelledby="costs-type">
        <div class="section-header"><h3 id="costs-type">By service type</h3></div>
        <div class="group">
          {c.byServiceType.length
            ? c.byServiceType.map(t => (
              <div class="row" key={t.serviceType}>
                <div class="row-main">
                  <div class="costs-type-line">
                    <span>{t.serviceType}</span>
                    <span class="num secondary">{formatMoneyWhole(t.total)}</span>
                  </div>
                  <div class="share-bar" aria-hidden="true"><span style={{ width: `${Math.max(2, (t.total / typeMax) * 100)}%` }} /></div>
                </div>
              </div>
            ))
            : <p class="row secondary">No line costs recorded yet.</p>}
        </div>
        <p class="section-footer">From the line costs on each receipt. Some receipts combine services on one line.</p>
      </section>
    </Sheet>
  );
}

function Stat(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="stat">
      <div class="stat-label">{props.label}</div>
      <div class="stat-value">{props.value}</div>
    </div>
  );
}
