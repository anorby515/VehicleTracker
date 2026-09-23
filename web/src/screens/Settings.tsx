/**
 * Settings (#/settings): who's signed in, notifications (this device + the
 * per-event switches stored on App Users › Notification Prefs), signing in on
 * another device with a code, the install guide, refresh, app version, and
 * sign out (warning first if anything is still waiting to upload).
 */

import type { JSX } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ApiFailure, NetworkError, call } from '../api/client';
import type { PairCreateResult } from '../api/types';
import { APP_VERSION, BUILD_TIME, config } from '../config';
import { formatDateTime, formatTime } from '../lib/format';
import { deviceLabel, standalone } from '../lib/platform';
import { hasPendingWork, pendingUploadCount } from '../receipts';
import { hasPendingOdometer, pendingOdometerCount } from '../state/odometer';
import {
  NOTIFICATION_EVENTS, currentPushEndpoint, disablePush, enablePush, prefOn, pushBusy, pushError, pushPermission,
  pushSubscribed, pushSupport, sendTestPush, setPref,
} from '../state/push';
import { back, go, href } from '../state/router';
import { bootstrapFetchedAt, online, refresh, refreshing, signOut, user } from '../state/store';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { SwitchRow } from '../ui/Switch';
import { toast } from '../ui/toast';
import { openInstallGuide } from './InstallGuide';
import './Settings.css';

export function SettingsScreen(): JSX.Element {
  const u = user.value;
  return (
    <Sheet title="Settings" onClose={() => back(href.home())} class="settings-sheet">
      <section class="section" aria-labelledby="set-account">
        <div class="section-header"><h2 id="set-account">Signed in</h2></div>
        <div class="group">
          <div class="row">
            <span class="settings-avatar" aria-hidden="true">{(u?.name ?? '?').slice(0, 1).toUpperCase()}</span>
            <span class="row-main">
              <span class="row-title">{u?.name ?? 'Not signed in'}</span>
              {u?.email && <span class="row-sub settings-email">{u.email}</span>}
            </span>
          </div>
        </div>
      </section>

      <NotificationsSection />
      <PairSection />

      <section class="section" aria-labelledby="set-app">
        <div class="section-header"><h2 id="set-app">App</h2></div>
        <div class="group">
          {!standalone.value && (
            <button type="button" class="row tappable" onClick={openInstallGuide}>
              <Icon name="share" class="settings-icon" />
              <span class="row-main">How to add to Home Screen</span>
              <Icon name="chevronRight" size={18} class="row-chevron" />
            </button>
          )}
          <RefreshRow />
          <div class="row">
            <Icon name="info" class="settings-icon" />
            <span class="row-main">Version</span>
            <span class="row-value num" data-testid="app-version">{APP_VERSION}</span>
          </div>
          <div class="row">
            <Icon name="calendar" class="settings-icon" />
            <span class="row-main">Built</span>
            <span class="row-value">{formatDateTime(BUILD_TIME)}</span>
          </div>
        </div>
        {standalone.value && (
          <div class="section-footer">
            <button type="button" class="link-btn settings-footer-link" onClick={openInstallGuide}>How to add to Home Screen</button>
          </div>
        )}
      </section>

      <SignOutSection />
    </Sheet>
  );
}

// ---------------------------------------------------------------- notifications

function NotificationsSection(): JSX.Element {
  const support = pushSupport.value;
  const permission = pushPermission.value;
  const on = pushSubscribed.value;
  const prefs = user.value?.prefs;
  const [testing, setTesting] = useState(false);
  const device = deviceLabel();

  let status: JSX.Element;
  if (support === 'not-installed') {
    status = (
      <div class="row settings-explain">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">Add to Home Screen first</span>
          <span class="row-sub">Notifications only work when the app is opened from your Home Screen.</span>
        </span>
      </div>
    );
  } else if (support === 'unsupported') {
    status = (
      <div class="row settings-explain">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">Not available on this {device}</span>
          <span class="row-sub">Notifications need iOS 16.4 or later.</span>
        </span>
      </div>
    );
  } else if (support === 'not-configured') {
    status = (
      <div class="row settings-explain">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">Not set up yet</span>
          <span class="row-sub">The app’s notification key hasn’t been added (see SETUP.md).</span>
        </span>
      </div>
    );
  } else if (permission === 'denied') {
    status = (
      <div class="row settings-explain">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">Turned off in iPhone Settings</span>
          <span class="row-sub">To turn them back on, open iPhone Settings › Notifications › {config.appName || 'Vehicles'}.</span>
        </span>
      </div>
    );
  } else if (on) {
    status = (
      <div class="row">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">On for this {device}</span>
        </span>
        <button type="button" class="btn btn-small" disabled={pushBusy.value} onClick={() => void disablePush().then(() => toast('Notifications are off on this ' + device))}>
          Turn off
        </button>
      </div>
    );
  } else {
    status = (
      <div class="row">
        <Icon name="bell" class="settings-icon" />
        <span class="row-main">
          <span class="row-title">Off on this {device}</span>
        </span>
        <button
          type="button"
          class="btn btn-primary btn-small"
          disabled={pushBusy.value}
          // enablePush() calls pushManager.subscribe() synchronously inside this tap.
          onClick={() => { void enablePush().then(ok => { if (ok) toast('Notifications are on'); }); }}
        >
          Turn on
        </button>
      </div>
    );
  }

  const test = async () => {
    setTesting(true);
    try {
      toast(await sendTestPush(), 3500);
    } finally {
      setTesting(false);
    }
  };

  const toggle = async (key: (typeof NOTIFICATION_EVENTS)[number]['key'], value: boolean) => {
    const err = await setPref(key, value);
    if (err) toast(`Couldn’t save: ${err}`, 3500);
  };

  return (
    <section class="section" aria-labelledby="set-notif">
      <div class="section-header"><h2 id="set-notif">Notifications</h2></div>
      <div class="group">{status}</div>
      {pushError.value && <p class="section-footer settings-error" role="alert">{pushError.value}</p>}

      <div class="section-header settings-subheader"><h3>Tell me about</h3></div>
      <div class="group">
        {NOTIFICATION_EVENTS.map(ev => (
          <SwitchRow
            key={ev.key}
            label={ev.label}
            detail={ev.detail}
            checked={prefOn(prefs, ev.key)}
            onChange={v => void toggle(ev.key, v)}
          />
        ))}
      </div>
      <div class="section-footer">These choices apply to all your devices.</div>

      <div class="group settings-gap">
        <button type="button" class="row tappable" disabled={testing} onClick={() => void test()}>
          <Icon name="bell" class="settings-icon" />
          <span class="row-main settings-action">Send a test notification</span>
          {testing && <span class="spinner" aria-label="Sending" />}
        </button>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- sign in on another device

function PairSection(): JSX.Element {
  const [pair, setPair] = useState<PairCreateResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  const expired = pair ? new Date(pair.expiresAt).getTime() <= Date.now() : false;
  useEffect(() => {
    if (!pair) return;
    const t = setInterval(() => setTick(n => n + 1), 15000);
    return () => clearInterval(t);
  }, [pair]);

  const create = async () => {
    setBusy(true);
    setError(null);
    try {
      setPair(await call('pairCreate', {}));
    } catch (e) {
      setError(e instanceof NetworkError ? 'No connection. Try again when you’re online.' : e instanceof ApiFailure ? e.message : 'Couldn’t make a code.');
    } finally {
      setBusy(false);
    }
  };

  const code = pair?.code ?? '';
  const shown = code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
  return (
    <section class="section" aria-labelledby="set-pair">
      <div class="section-header"><h2 id="set-pair">Other devices</h2></div>
      <div class="group">
        {!pair || expired ? (
          <button type="button" class="row tappable" disabled={busy} onClick={() => void create()}>
            <Icon name="grid" class="settings-icon" />
            <span class="row-main settings-action">{expired ? 'Make a new sign-in code' : 'Sign in on another device'}</span>
            {busy ? <span class="spinner" aria-label="Making a code" /> : <Icon name="chevronRight" size={18} class="row-chevron" />}
          </button>
        ) : (
          <div class="pair-panel">
            <p class="footnote pair-label" id="pair-code-label">Sign-in code</p>
            <p class="pair-code" aria-labelledby="pair-code-label" aria-label={code.split('').join(' ')}>{shown}</p>
            <p class="footnote">Expires at {formatTime(pair.expiresAt)}. Works once.</p>
            <p class="subhead pair-help">
              On the other device, open the app, tap <strong>Use a sign-in code</strong>, and type this code.
            </p>
            <button type="button" class="btn btn-plain btn-small" onClick={() => setPair(null)}>Done</button>
          </div>
        )}
      </div>
      {error && <p class="section-footer settings-error" role="alert">{error}</p>}
      {!pair && !error && (
        <div class="section-footer">
          Use this when Google sign-in won’t finish inside the Home Screen app: sign in here, then enter the code there.
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------- refresh

function RefreshRow(): JSX.Element {
  const at = bootstrapFetchedAt.value;
  const run = async () => {
    if (!online.value) { toast('You’re offline. Showing saved data.'); return; }
    const ok = await refresh();
    toast(ok ? 'Up to date' : 'Couldn’t refresh');
  };
  return (
    <button type="button" class="row tappable" disabled={refreshing.value} onClick={() => void run()}>
      <Icon name="refresh" class="settings-icon" />
      <span class="row-main">
        <span class="row-title settings-action">Refresh data</span>
        {at && <span class="row-sub">Last updated {formatDateTime(new Date(at).toISOString())}</span>}
      </span>
      {refreshing.value && <span class="spinner" aria-label="Refreshing" />}
    </button>
  );
}

// ---------------------------------------------------------------- sign out

function pendingMessage(scans: number, readings: number, unknownScans: boolean): string {
  const parts: string[] = [];
  if (scans > 0) parts.push(`${scans} ${scans === 1 ? 'scan hasn’t' : 'scans haven’t'} uploaded yet`);
  else if (unknownScans) parts.push('A scan hasn’t uploaded yet');
  if (readings > 0) parts.push(`${readings} odometer ${readings === 1 ? 'reading hasn’t' : 'readings haven’t'} been sent yet`);
  const joined = parts.join(' and ');
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} and will be deleted if you sign out.`;
}

function SignOutSection(): JSX.Element {
  const [confirm, setConfirm] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const doSignOut = async () => {
    setBusy(true);
    try {
      await signOut(currentPushEndpoint());
      go(href.home(), true);
    } finally {
      setBusy(false);
    }
  };

  const start = async () => {
    setBusy(true);
    let scansPending = false, odoPending = false;
    try {
      [scansPending, odoPending] = await Promise.all([
        hasPendingWork().catch(() => false),
        hasPendingOdometer().catch(() => false),
      ]);
    } finally {
      setBusy(false);
    }
    if (scansPending || odoPending) {
      setConfirm(pendingMessage(scansPending ? pendingUploadCount.value : 0, odoPending ? pendingOdometerCount.value : 0, scansPending));
      return;
    }
    await doSignOut();
  };

  return (
    <section class="section" aria-label="Sign out">
      {confirm ? (
        <div class="group signout-confirm" role="alertdialog" aria-labelledby="signout-msg">
          <p id="signout-msg" class="signout-msg">{confirm}</p>
          <button type="button" class="row tappable signout-danger" disabled={busy} onClick={() => void doSignOut()}>
            <span class="row-main">Sign out and delete</span>
          </button>
          <button type="button" class="row tappable" onClick={() => setConfirm(null)}>
            <span class="row-main settings-action">Cancel</span>
          </button>
        </div>
      ) : (
        <div class="group">
          <button type="button" class="row tappable signout-danger" disabled={busy} onClick={() => void start()}>
            <Icon name="signOut" class="settings-icon" />
            <span class="row-main">Sign out</span>
            {busy && <span class="spinner" aria-label="Signing out" />}
          </button>
        </div>
      )}
      <div class="section-footer">Signing out removes the app’s saved data from this {deviceLabel()}.</div>
    </section>
  );
}
