/**
 * Status messages on the main screen:
 * - fixed under the top bar: "New version available" and the offline banner;
 * - at the top of each vehicle page: a quiet refresh error, odometer notices,
 *   "N scans waiting to upload", queued odometer readings, and the
 *   "Turn on notifications" card.
 */

import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import { formatDate, formatDateShort, formatTime, todayYmd } from '../lib/format';
import { pendingUploadCount } from '../receipts';
import { dismissOdometerNotice, flushOdometer, odometerNotice, pendingOdometerCount } from '../state/odometer';
import { dismissPushCard, enablePush, pushBusy, pushError, showPushCard } from '../state/push';
import { href, go } from '../state/router';
import { bootstrapFetchedAt, online, refresh, refreshError, refreshing } from '../state/store';
import { reloadToUpdate, updateAvailable } from '../state/sw-register';
import { Icon } from '../ui/Icon';
import { toast } from '../ui/toast';
import './Banners.css';

/**
 * "Offline: showing data from 2:14 PM" (with the date when it isn't today).
 * When the phone has a connection but the server couldn't be reached, it
 * says "Couldn't connect" instead: the app keeps retrying on its own.
 */
export function offlineText(
  fetchedAt: number | null,
  now: number = Date.now(),
  deviceOnline: boolean = typeof navigator === 'undefined' || navigator.onLine !== false,
): string {
  const label = deviceOnline ? 'Couldn’t connect' : 'Offline';
  if (!fetchedAt) return label;
  const d = new Date(fetchedAt);
  const day = todayYmd(d);
  const today = todayYmd(new Date(now));
  const time = formatTime(d);
  if (day === today) return `${label}: showing data from ${time}`;
  const date = day.slice(0, 4) === today.slice(0, 4) ? formatDateShort(day) : formatDate(day);
  return `${label}: showing data from ${date}, ${time}`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Fixed banners under the top bar. */
export function TopBanners(): JSX.Element | null {
  const showUpdate = updateAvailable.value;
  const offline = !online.value;
  if (!showUpdate && !offline) return null;
  return (
    <div class="top-banners">
      {showUpdate && (
        <button type="button" class="update-prompt" onClick={() => void reloadToUpdate()}>
          <Icon name="refresh" size={18} />
          <span>New version available. Tap to refresh.</span>
        </button>
      )}
      {offline && (
        <div class="offline-banner" role="status">
          <span class="offline-dot" aria-hidden="true" />
          <span>{offlineText(bootstrapFetchedAt.value)}</span>
        </div>
      )}
    </div>
  );
}

/** Notices at the top of every vehicle page. */
export function PageNotices(): JSX.Element | null {
  const err = online.value ? refreshError.value : null;
  const notice = odometerNotice.value;
  const scans = pendingUploadCount.value;
  const odo = pendingOdometerCount.value;
  const card = showPushCard.value;
  if (!err && !notice && !scans && !odo && !card) return null;
  return (
    <div class="page-notices">
      {err && (
        <div class="banner banner-info quiet-error">
          <Icon name="info" size={18} />
          <span class="quiet-error-text">Couldn’t refresh: {err}</span>
          <button type="button" class="btn btn-plain btn-small" disabled={refreshing.value} onClick={() => void refresh()}>
            Try again
          </button>
        </div>
      )}
      {notice && (
        <div class="banner banner-warn odo-notice" role="alert">
          <span class="odo-notice-text">{notice}</span>
          <button type="button" class="btn btn-plain btn-small" onClick={dismissOdometerNotice}>OK</button>
        </div>
      )}
      {(scans > 0 || odo > 0) && (
        <div class="chips">
          {scans > 0 && (
            <button type="button" class="chip" onClick={() => go(href.scans())}>
              <Icon name="upload" size={16} />
              <span>{plural(scans, 'scan', 'scans')} waiting to upload</span>
            </button>
          )}
          {odo > 0 && (
            <button
              type="button"
              class="chip"
              onClick={() => {
                if (!online.value) { toast('It will send when you’re back online'); return; }
                void flushOdometer().then(n => toast(n > 0 ? 'Sent' : 'Still waiting to send'));
              }}
            >
              <Icon name="gauge" size={16} />
              <span>{plural(odo, 'odometer reading', 'odometer readings')} waiting to send</span>
            </button>
          )}
        </div>
      )}
      {card && <PushCard />}
    </div>
  );
}

/** "Turn on notifications" (only in the home-screen app, while permission hasn't been asked). */
function PushCard(): JSX.Element {
  const titleId = useId();
  return (
    <section class="push-card" aria-labelledby={titleId}>
      <div class="push-card-icon" aria-hidden="true"><Icon name="bell" size={26} /></div>
      <div class="push-card-main">
        <h2 id={titleId} class="headline push-card-title">Turn on notifications</h2>
        <p class="subhead push-card-text">
          Get a heads-up when service is coming due on your vehicles or a receipt you scanned is filed.
        </p>
        {pushError.value && <p class="footnote push-card-error" role="alert">{pushError.value}</p>}
        <div class="push-card-actions">
          <button
            type="button"
            class="btn btn-primary btn-small"
            disabled={pushBusy.value}
            // enablePush() calls pushManager.subscribe() synchronously inside this tap.
            onClick={() => { void enablePush().then(ok => { if (ok) toast('Notifications are on'); }); }}
          >
            Turn on
          </button>
          <button type="button" class="btn btn-plain btn-small" onClick={dismissPushCard}>Not now</button>
        </div>
      </div>
    </section>
  );
}
