/**
 * One vehicle's card (spec 6.1): photo header, quick actions, attention
 * banner, Upcoming, Service Journal, More. The card is NOT a scroll
 * container: the shell's pager page scrolls it. Every sub-view is a route
 * (#/v/<vehicle>/…) rendered by VehicleRouteSheets.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { AttentionItem, OemApp, UpcomingItem, Vehicle, Visit } from '../api/types';
import { countdown, formatDate, formatMiles, formatMoney, formatMoneyWhole } from '../lib/format';
import { usePhoto } from '../lib/photos';
import { href } from '../state/router';
import { bootstrapFetchedAt } from '../state/store';
import { CoveredBadge, StatusBadge, Tag } from '../ui/Badge';
import { Icon, type IconName } from '../ui/Icon';
import { RouteLink, presentToday } from './common';
import { attentionEntries, dueText, formatWearValue, makeInitial, plateText, registrationDaysText } from './display';
import { launchOemApp } from './oemApp';
import './VehicleCard.css';

export interface VehicleCardProps {
  vehicle: Vehicle;
  /** True for the card currently on screen (others may skip heavy work). */
  active: boolean;
}

/** Journal rows shown before "Show all N visits". */
export const JOURNAL_PREVIEW = 12;

export function VehicleCard(props: VehicleCardProps): JSX.Element {
  const v = props.vehicle;
  return (
    <article class="vcard" aria-label={v.name}>
      <VehicleHeader vehicle={v} />
      <QuickActions vehicle={v} />
      <AttentionBanner vehicle={v} />
      <UpcomingSection vehicle={v} />
      <JournalSection vehicle={v} />
      <MoreSection vehicle={v} />
    </article>
  );
}

// ---------------------------------------------------------------- header

export function VehiclePhoto(props: { vehicle: Vehicle; class?: string }): JSX.Element {
  const v = props.vehicle;
  // Retry a photo that failed to load on each data refresh (pull down, or back to the app).
  const photo = usePhoto(v.photoFileId, bootstrapFetchedAt.value);
  return (
    <div class={`vphoto${props.class ? ' ' + props.class : ''}`}>
      {photo.url
        ? <img class="vphoto-img" src={photo.url} alt={`Photo of the ${v.shortName || v.name}`} decoding="async" />
        : (
          <div class={`vphoto-placeholder${photo.state === 'loading' ? ' is-loading' : ''}`} aria-hidden="true">
            <span class="vphoto-initial">{makeInitial(v)}</span>
          </div>
        )}
    </div>
  );
}

function VehicleHeader(props: { vehicle: Vehicle }): JSX.Element {
  const v = props.vehicle;
  return (
    <header class="vcard-header">
      <VehiclePhoto vehicle={v} />
      <h2 class="vcard-name title2">{v.name}</h2>
      <p class="vcard-meta subhead secondary">
        <span class={v.plate ? 'vcard-plate' : undefined}>{plateText(v.plate)}</span>
        {v.primaryDriver && <> · <span>Driver: {v.primaryDriver}</span></>}
      </p>
      {v.estMileage !== null && (
        <p class="vcard-miles">
          <span class="num">~{formatMiles(v.estMileage)}</span> <span class="secondary">(estimated)</span>
        </p>
      )}
    </header>
  );
}

// ---------------------------------------------------------------- quick actions

function QuickActions(props: { vehicle: Vehicle }): JSX.Element {
  const v = props.vehicle;
  const app = v.oemApp;
  const oem = useOemLaunch(app);
  return (
    <div class="vcard-actions">
      <div class="vcard-actions-row">
        <RouteLink href={href.panel(v.name, 'odometer')} class="qa">
          <Icon name="gauge" />
          <span>Update Odometer</span>
        </RouteLink>
        <RouteLink href={href.panel(v.name, 'basics')} class="qa">
          <Icon name="info" />
          <span>Vehicle Basics</span>
        </RouteLink>
        {app && (
          <button type="button" class="qa" onClick={oem.open}>
            <Icon name="external" />
            <span>Open {app.name}</span>
          </button>
        )}
      </div>
      {app && (app.storeLink || oem.failed) && (
        // Same columns as the row above, so the links sit right under the OEM button.
        <div class="vcard-actions-row vcard-actions-sub">
          <span aria-hidden="true" />
          <span aria-hidden="true" />
          <div class="qa-oem-links">
            {app.storeLink && (
              <a
                href={app.storeLink}
                target="_blank"
                rel="noopener"
                class="qa-store"
                aria-label={`Don’t have the ${app.name} app? Get it on the App Store`}
              >
                Don’t have the app?
              </a>
            )}
          </div>
        </div>
      )}
      {app && oem.failed && (
        <p class="qa-failed" role="status">
          {app.storeLink
            ? <a href={app.storeLink} target="_blank" rel="noopener">Didn’t open? Get {app.name} on the App Store</a>
            : <>Didn’t open? The {app.name} app may not be on this phone.</>}
        </p>
      )}
    </div>
  );
}

/**
 * "Open <App>" (spec 8.13). The tap hands off to the app's link; if the page
 * is still on screen ~2 s later the app probably isn't installed, so `failed`
 * turns on and an inline "Didn't open?" App Store link appears (oemApp.ts).
 * The App Store is never opened automatically.
 */
function useOemLaunch(app: OemApp | null): { open: () => void; failed: boolean } {
  const [failed, setFailed] = useState(false);
  const cancel = useRef<(() => void) | null>(null);
  useEffect(() => () => cancel.current?.(), []);
  useEffect(() => { setFailed(false); }, [app?.link]);
  const open = () => {
    if (!app) return;
    cancel.current?.();
    setFailed(false);
    cancel.current = launchOemApp(app.link, { onFail: () => setFailed(true) });
  };
  return { open, failed };
}

// ---------------------------------------------------------------- attention banner

const ATTENTION_ICON: Record<AttentionItem['kind'], IconName> = {
  rescan: 'camera',
  recall: 'alert',
  registration: 'calendar',
  odometer: 'gauge',
};

function AttentionBanner(props: { vehicle: Vehicle }): JSX.Element | null {
  const v = props.vehicle;
  const entries = attentionEntries(v, href.panel(v.name, 'recalls'));
  if (!entries.length) return null;
  return (
    <section class="section vcard-attention" aria-label="Needs attention">
      <div class="group">
        {entries.map(a => (
          <RouteLink key={a.href + a.text} href={a.href} class={`row tappable attn-row${a.tone !== 'normal' ? ` attn-${a.tone}` : ''}`}>
            <span class="attn-icon" aria-hidden="true"><Icon name={ATTENTION_ICON[a.kind] ?? 'info'} /></span>
            <span class="row-main">
              {a.strong && <span class="attn-strong">{a.strong}</span>}
              <span class="attn-text">{a.text}</span>
            </span>
            <Icon name="chevronRight" class="row-chevron" size={18} />
          </RouteLink>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- upcoming

export function UpcomingRow(props: { vehicle: Vehicle; item: UpcomingItem; today: string; compact?: boolean }): JSX.Element {
  const { vehicle: v, item } = props;
  const due = dueText(item);
  const cd = item.dueBy || item.dueMiles !== null ? countdown(item.dueBy, item.dueMiles, v.estMileage, props.today) : null;
  const recall = item.kind === 'recall' ? v.recalls.find(r => r.campaignNumber === item.recall?.campaignNumber) : undefined;
  return (
    <RouteLink href={href.upcoming(v.name, item.id)} class="row tappable up-row">
      <span class="row-main">
        {recall?.parkIt && <span class="attn-strong up-danger">Do not drive until repaired</span>}
        <span class="up-head">
          <span class="row-title up-title">{item.title}</span>
          <StatusBadge status={item.status} />
        </span>
        {due && <span class="row-sub up-due num">{due}</span>}
        {cd && <span class="row-sub up-countdown">{cd}</span>}
        {item.subtitle && <span class="row-sub up-subtitle">{item.subtitle}</span>}
        {item.coveredBy.length > 0 && (
          <span class="up-covered">{item.coveredBy.map(p => <CoveredBadge key={p} plan={p} />)}</span>
        )}
      </span>
      <Icon name="chevronRight" class="row-chevron" size={18} />
    </RouteLink>
  );
}

function UpcomingSection(props: { vehicle: Vehicle }): JSX.Element {
  const v = props.vehicle;
  const today = presentToday();
  const headingId = `up-${slug(v.name)}`;
  return (
    <section class="section vcard-upcoming" aria-labelledby={headingId}>
      <div class="section-header"><h3 id={headingId}>Upcoming</h3></div>
      {v.upcoming.length
        ? <div class="group">{v.upcoming.map(i => <UpcomingRow key={i.id} vehicle={v} item={i} today={today} />)}</div>
        : <div class="group"><p class="row secondary">Nothing coming up right now.</p></div>}
      {v.noHistory.length > 0 && (
        <details class="group nohistory">
          <summary class="row tappable nohistory-summary">
            <span class="row-main">No service record yet ({v.noHistory.length})</span>
            <Icon name="chevronDown" class="row-chevron nohistory-chevron" size={18} />
          </summary>
          {v.noHistory.map(i => (
            <RouteLink key={i.id} href={href.upcoming(v.name, i.id)} class="row tappable up-row">
              <span class="row-main">
                <span class="up-head">
                  <span class="row-title up-title">{i.title}</span>
                  <StatusBadge status={i.status} />
                </span>
                {i.coveredBy.length > 0 && (
                  <span class="up-covered">{i.coveredBy.map(p => <CoveredBadge key={p} plan={p} />)}</span>
                )}
              </span>
              <Icon name="chevronRight" class="row-chevron" size={18} />
            </RouteLink>
          ))}
        </details>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- service journal

export function VisitRow(props: { vehicle: Vehicle; visit: Visit }): JSX.Element {
  const { vehicle: v, visit: x } = props;
  return (
    <RouteLink href={href.visit(v.name, x.visitId)} class="row tappable visit-row">
      <span class="row-main">
        <span class="visit-head">
          <span class="row-title visit-date">{formatDate(x.date, 'Date not recorded')}</span>
          <span class="visit-total num">{formatMoney(x.invoiceTotal)}</span>
        </span>
        <span class="row-sub visit-shop ellipsis">{x.location || 'Shop not recorded'}</span>
        {x.summary && <span class="row-sub visit-summary ellipsis">{x.summary}</span>}
        {(x.sourceTag || x.beforeOwnership) && (
          <span class="visit-tags">
            {x.sourceTag && <Tag>{x.sourceTag}</Tag>}
            {x.beforeOwnership && <Tag>Before we owned it</Tag>}
          </span>
        )}
      </span>
      <Icon name="chevronRight" class="row-chevron" size={18} />
    </RouteLink>
  );
}

function JournalSection(props: { vehicle: Vehicle }): JSX.Element {
  const v = props.vehicle;
  const [all, setAll] = useState(false);
  const visits = all ? v.visits : v.visits.slice(0, JOURNAL_PREVIEW);
  const headingId = `journal-${slug(v.name)}`;
  return (
    <section class="section vcard-journal" aria-labelledby={headingId}>
      <div class="section-header"><h3 id={headingId}>Service Journal</h3></div>
      <div class="group">
        {visits.length
          ? visits.map(x => <VisitRow key={x.visitId} vehicle={v} visit={x} />)
          : <p class="row secondary">No visits yet. Add a receipt to start the journal.</p>}
        {!all && v.visits.length > JOURNAL_PREVIEW && (
          <button type="button" class="row tappable show-all" onClick={() => setAll(true)}>
            <span class="row-main show-all-text">Show all {v.visits.length} visits</span>
          </button>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- more

function MoreRow(props: { href: string; icon: IconName; title: string; value?: string | null }): JSX.Element {
  return (
    <RouteLink href={props.href} class="row tappable more-row">
      <span class="more-icon" aria-hidden="true"><Icon name={props.icon} size={20} /></span>
      <span class="row-title more-title">{props.title}</span>
      {props.value && <span class="row-value more-value">{props.value}</span>}
      <Icon name="chevronRight" class="row-chevron" size={18} />
    </RouteLink>
  );
}

function MoreSection(props: { vehicle: Vehicle }): JSX.Element {
  const v = props.vehicle;
  const headingId = `more-${slug(v.name)}`;
  const newRecalls = v.recalls.filter(r => (r.status ?? '').toLowerCase() === 'new').length;
  const activePlans = v.coverage.filter(p => p.active).length;
  const reg = v.registration.expires
    ? `${v.registration.daysLeft !== null && v.registration.daysLeft < 0 ? 'Expired ' : ''}${formatDate(v.registration.expires)}`
    : 'Not set';
  return (
    <section class="section vcard-more" aria-labelledby={headingId}>
      <div class="section-header"><h3 id={headingId}>More</h3></div>
      <div class="group">
        <MoreRow href={href.panel(v.name, 'costs')} icon="dollar" title="Costs" value={`${formatMoneyWhole(v.costs.thisYear)} this year`} />
        <MoreRow href={href.panel(v.name, 'wear')} icon="tire" title="Wear" value={wearSummary(v)} />
        <MoreRow href={href.panel(v.name, 'registration')} icon="calendar" title="Registration" value={reg} />
        <MoreRow href={href.panel(v.name, 'recalls')} icon="flag" title="Recalls" value={newRecalls ? `${newRecalls} new` : v.recalls.length ? 'None new' : 'None found'} />
        <MoreRow href={href.panel(v.name, 'coverage')} icon="shield" title="Coverage" value={activePlans ? `${activePlans} active` : 'None active'} />
        <MoreRow href={href.panel(v.name, 'export')} icon="share" title="Service history" value="Export" />
      </div>
      {v.registration.daysLeft !== null && v.registration.daysLeft <= 60 && (
        <p class="section-footer">Registration: {registrationDaysText(v.registration)}</p>
      )}
    </section>
  );
}

function wearSummary(v: Vehicle): string {
  const w = v.wear.tread;
  if (w) return `Tread ${formatWearValue(w.latest.value, w.unit)}`;
  const b = v.wear.brakeFront ?? v.wear.brakeRear;
  if (b) return `Pads ${formatWearValue(b.latest.value, b.unit)}`;
  return 'No readings';
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-');
}
