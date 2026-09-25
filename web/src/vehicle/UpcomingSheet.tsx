/**
 * Detail for one Upcoming row (spec 6.2): why it's due and where the numbers
 * come from. Dates and miles are the Sheet's own values, never recalculated,
 * so the app, the Sheet and Todoist always agree.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { UpcomingItem, Vehicle } from '../api/types';
import { countdown, formatDate, formatMiles, formatMoney } from '../lib/format';
import { href } from '../state/router';
import { StatusBadge } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { RouteLink, ValueRow, ownerName, presentToday } from './common';
import { DocumentViewerSheet } from './DocumentViewer';
import { coverageEndText, coverageLimitText, coversText, dueText, intervalText, registrationDaysText } from './display';
import { RecallCard, VinCheckLink } from './RecallCard';

export function UpcomingSheet(props: { vehicle: Vehicle; item: UpcomingItem; onClose: () => void }): JSX.Element {
  const { vehicle: v, item } = props;
  const today = presentToday();
  const due = dueText(item);
  const cd = item.dueBy || item.dueMiles !== null ? countdown(item.dueBy, item.dueMiles, v.estMileage, today) : null;
  const [viewRegistration, setViewRegistration] = useState(false);

  // The document viewer is a sibling, not inside this sheet's portal (see VisitSheet).
  return (
    <>
      <Sheet title={item.title} onClose={props.onClose} class="upcoming-sheet">
        <div class="vsheet-hero">
          <h3 class="title2">{item.title}</h3>
          <p class="secondary">{v.name}</p>
          <div class="badges"><StatusBadge status={item.status} /></div>
          {item.subtitle && <p class="up-sheet-subtitle">{item.subtitle}</p>}
          {due && <p class="num">{due}</p>}
          {cd && <p class="secondary">{cd[0].toUpperCase() + cd.slice(1)}</p>}
        </div>

        {item.coveredBy.map(plan => (
          <div class="callout callout-covered" key={plan}>
            <Icon name="shield" />
            <div>
              <p><strong>Covered: {plan}</strong></p>
              <p>This may already be paid for. Mention it to the shop before you pay.</p>
            </div>
          </div>
        ))}

        {item.kind === 'schedule' && <ScheduleDetails vehicle={v} item={item} />}
        {item.kind === 'dealer' && <DealerDetails vehicle={v} item={item} />}
        {item.kind === 'recommendation' && <RecommendationDetails vehicle={v} item={item} />}
        {item.kind === 'warranty' && <WarrantyDetails vehicle={v} item={item} />}
        {item.kind === 'registration' && <RegistrationDetails vehicle={v} onOpen={() => setViewRegistration(true)} />}
        {item.kind === 'recall' && <RecallDetails vehicle={v} item={item} />}
      </Sheet>
      {viewRegistration && v.registration.fileId && (
        <DocumentViewerSheet fileId={v.registration.fileId} title="Scanned registration" onClose={() => setViewRegistration(false)} />
      )}
    </>
  );
}

function ScheduleDetails(props: { vehicle: Vehicle; item: UpcomingItem }): JSX.Element {
  const { vehicle: v, item } = props;
  const s = item.schedule;
  if (!s) return <p class="empty">No schedule details for this item.</p>;
  const lastDone = s.lastDoneDate || s.lastDoneMiles !== null
    ? [s.lastDoneDate ? formatDate(s.lastDoneDate) : null, s.lastDoneMiles !== null ? formatMiles(s.lastDoneMiles) : null].filter(Boolean).join(' · ')
    : null;
  const lastVisit = s.lastDoneVisitId ? v.visits.find(x => x.visitId === s.lastDoneVisitId) : null;
  return (
    <>
        <section class="section" aria-labelledby="sched-interval">
          <div class="section-header"><h3 id="sched-interval">Interval</h3></div>
          <div class="group">
            <ValueRow label="How often" value={intervalText(s.intervalMonths, s.intervalMiles)} />
            <div class="row">
              <div class="row-main stack">
                <span class="row-title">Where this interval comes from</span>
                <span class="row-sub">{s.intervalSource || 'Not recorded in the Sheet'}</span>
              </div>
            </div>
          </div>
        </section>

        <section class="section" aria-labelledby="sched-last">
          <div class="section-header"><h3 id="sched-last">Last done</h3></div>
          <div class="group">
            <div class="row">
              <div class="row-main">{lastDone ?? 'No record yet'}</div>
            </div>
            {s.lastDoneVisitId && (
              <RouteLink href={href.visit(v.name, s.lastDoneVisitId)} class="row tappable">
                <span class="row-main stack">
                  <span class="row-title link-text">See that visit</span>
                  {lastVisit && <span class="row-sub">{[formatDate(lastVisit.date, ''), lastVisit.location].filter(Boolean).join(' · ')}</span>}
                </span>
                <Icon name="chevronRight" class="row-chevron" size={18} />
              </RouteLink>
            )}
          </div>
        </section>

        <section class="section" aria-labelledby="sched-next">
          <div class="section-header"><h3 id="sched-next">Next due</h3></div>
          <div class="group">
            <ValueRow label="Date" value={s.nextDueDate ? formatDate(s.nextDueDate) : null} />
            <ValueRow label="Mileage" value={s.nextDueMiles !== null ? formatMiles(s.nextDueMiles) : null} />
            {s.estDateForMiles && s.nextDueMiles !== null && (
              <ValueRow label="Mileage reached (est.)" value={formatDate(s.estDateForMiles)} />
            )}
            <ValueRow label="Due by" value={item.dueBy ? formatDate(item.dueBy) : null} />
            <ValueRow label="Status in the Sheet" value={s.sheetStatus} />
          </div>
          <p class="section-footer">
            Due by is whichever comes first. These dates come straight from the Sheet, so they match the Sheet and the reminders.
          </p>
        </section>
    </>
  );
}

function DealerDetails(props: { vehicle: Vehicle; item: UpcomingItem }): JSX.Element {
  const { vehicle: v, item } = props;
  // The newest visit whose receipt carried this suggestion, when there is one.
  const source = v.visits.find(x =>
    (x.dealerNextDueDate || x.dealerNextDueMiles !== null) && x.dealerNextDueMiles === item.dueMiles);
  return (
    <section class="section" aria-labelledby="dealer-when">
      <div class="section-header"><h3 id="dealer-when">When</h3></div>
      <div class="group">
        <ValueRow label="Due by" value={item.dueBy ? formatDate(item.dueBy) : null} />
        <ValueRow label="At mileage" value={item.dueMiles !== null ? formatMiles(item.dueMiles) : null} />
        <ValueRow label="Estimated now" value={v.estMileage !== null ? `~${formatMiles(v.estMileage)}` : null} />
        {source && (
          <RouteLink href={href.visit(v.name, source.visitId)} class="row tappable">
            <span class="row-main stack">
              <span class="row-title link-text">Suggested at the visit on {formatDate(source.date)}</span>
              {source.location && <span class="row-sub">{source.location}</span>}
            </span>
            <Icon name="chevronRight" class="row-chevron" size={18} />
          </RouteLink>
        )}
      </div>
      <p class="section-footer">Due by is whichever comes first: the shop’s date, or when the estimated mileage reaches its number.</p>
    </section>
  );
}

function RecommendationDetails(props: { vehicle: Vehicle; item: UpcomingItem }): JSX.Element {
  const { vehicle: v, item } = props;
  const r = item.recommendation;
  const visit = r?.visitId ? v.visits.find(x => x.visitId === r.visitId) : null;
  const declined = r?.status === 'Open';
  return (
    <>
        <section class="section" aria-labelledby="rec-details">
          <div class="section-header"><h3 id="rec-details">From the shop</h3></div>
          <div class="group">
            <ValueRow label="Estimate" value={r?.estimate !== null && r?.estimate !== undefined ? formatMoney(r.estimate) : null} />
            <ValueRow label="Recommended" value={r?.date ? `${formatDate(r.date)}${r.mileage !== null ? ` · ${formatMiles(r.mileage)}` : ''}` : null} />
            {r?.visitId && (
              <RouteLink href={href.visit(v.name, r.visitId)} class="row tappable">
                <span class="row-main stack">
                  <span class="row-title link-text">See that visit</span>
                  {visit && <span class="row-sub">{[formatDate(visit.date, ''), visit.location].filter(Boolean).join(' · ')}</span>}
                </span>
                <Icon name="chevronRight" class="row-chevron" size={18} />
              </RouteLink>
            )}
          </div>
        </section>
        <div class="callout callout-info">
          <Icon name="info" />
          <div>
            {declined
              ? <p><strong>Declined</strong> means the shop recommended this and it wasn’t done at that visit. It stays here until a later visit takes care of it.</p>
              : <p><strong>Watch</strong> (keep an eye on) means the shop noticed it but nothing is needed yet. Ask about it at the next visit.</p>}
          </div>
        </div>
    </>
  );
}

function WarrantyDetails(props: { vehicle: Vehicle; item: UpcomingItem }): JSX.Element {
  const { vehicle: v, item } = props;
  const plan = v.coverage.find(p => p.name === item.warranty?.name);
  if (!plan) return <p class="empty">This plan isn’t in the Warranties tab any more.</p>;
  return (
    <section class="section" aria-labelledby="warranty-plan">
      <div class="section-header"><h3 id="warranty-plan">{plan.name}</h3></div>
      <div class="group">
        <ValueRow label="Type" value={plan.type} />
        <ValueRow label="Ends" value={coverageEndText(plan)} />
        <ValueRow label="End date" value={plan.endDate ? formatDate(plan.endDate) : null} />
        <ValueRow label="End mileage" value={plan.endMiles !== null ? formatMiles(plan.endMiles) : null} />
        <ValueRow label="Covers" value={coversText(plan)?.replace(/^Covers /, '') ?? null} />
      </div>
      {coverageLimitText(plan) && <p class="section-footer">{coverageLimitText(plan)} Book anything it covers before then.</p>}
    </section>
  );
}

function RegistrationDetails(props: { vehicle: Vehicle; onOpen: () => void }): JSX.Element {
  const v = props.vehicle;
  const reg = v.registration;
  return (
    <>
        <section class="section" aria-label="Registration">
          <div class="group">
            <ValueRow label="Expires" value={reg.expires ? formatDate(reg.expires) : null} />
            <ValueRow label="Time left" value={registrationDaysText(reg)} />
          </div>
          {!reg.expires && <p class="section-footer">{ownerName()} adds this in the Sheet.</p>}
        </section>
        {reg.fileId && (
          <div class="vsheet-actions">
            <button type="button" class="btn btn-block" onClick={props.onOpen}>
              <Icon name="doc" size={20} /> Open registration
            </button>
          </div>
        )}
    </>
  );
}

function RecallDetails(props: { vehicle: Vehicle; item: UpcomingItem }): JSX.Element {
  const { vehicle: v, item } = props;
  const recall = v.recalls.find(r => r.campaignNumber === item.recall?.campaignNumber);
  return (
    <>
        <p class="vsheet-text secondary">May apply to this model. Recall lookups are by model, not your exact vehicle, so check the VIN.</p>
        {recall ? <div class="section"><RecallCard recall={recall} vehicle={v} /></div> : <p class="empty">This recall isn’t listed any more.</p>}
        <div class="vsheet-actions"><VinCheckLink vehicle={v} /></div>
    </>
  );
}
