/**
 * "Tap Share, then Add to Home Screen" (spec 10.1). Shown once, full screen,
 * when the app is opened in Safari instead of from the home screen; sign-in
 * and browsing still work in Safari. Settings can open it again.
 */

import { computed, signal } from '@preact/signals';
import type { JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useRef } from 'preact/hooks';
import { config } from '../config';
import { local } from '../lib/db';
import { isAutomated, isIOS, standalone } from '../lib/platform';
import './InstallGuide.css';

/** Survives sign-out on purpose: it's about the browser, not the person. */
const SEEN_KEY = 'app.installGuideSeen';

const seen = signal(local.get(SEEN_KEY) === '1');
/** Opened from Settings. */
export const installGuideOpen = signal(false);

/** First visit in Safari on an iPhone (automated test browsers skip it). */
export const autoInstallGuide = computed(() => !standalone.value && !seen.value && isIOS() && !isAutomated());

export function openInstallGuide(): void {
  installGuideOpen.value = true;
}

function dismiss(): void {
  installGuideOpen.value = false;
  seen.value = true;
  local.set(SEEN_KEY, '1');
}

/** Rendered once at the app root. */
export function InstallGuideHost(): JSX.Element | null {
  if (!installGuideOpen.value && !autoInstallGuide.value) return null;
  return createPortal(<InstallGuide fromSettings={installGuideOpen.value} onClose={dismiss} />, document.body) as unknown as JSX.Element;
}

export function InstallGuide(props: { fromSettings: boolean; onClose: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onClose(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  const app = config.appName || 'Vehicles';
  return (
    <div ref={ref} class="install-guide" role="dialog" aria-modal="true" aria-labelledby="install-title" tabIndex={-1}>
      <div class="install-inner">
        <img class="install-icon" src={`${import.meta.env.BASE_URL}icons/icon-192.png`} alt="" width={72} height={72} />
        <h1 id="install-title" class="title1">Add {app} to your Home Screen</h1>
        <p class="install-lede">It opens full screen like any other app, works without a signal, and can send you notifications.</p>

        <ol class="install-steps">
          <li class="install-step">
            <span class="install-num" aria-hidden="true">1</span>
            <div class="install-step-main">
              <p class="install-step-text">Tap <strong>Share</strong> in Safari’s toolbar.</p>
              <p class="footnote">On newer iPhones it may be under <strong>•••</strong> first.</p>
              <ShareToolbarIllustration />
            </div>
          </li>
          <li class="install-step">
            <span class="install-num" aria-hidden="true">2</span>
            <div class="install-step-main">
              <p class="install-step-text">Scroll down and tap <strong>Add to Home Screen</strong>.</p>
              <MenuRowIllustration />
            </div>
          </li>
          <li class="install-step">
            <span class="install-num" aria-hidden="true">3</span>
            <div class="install-step-main">
              <p class="install-step-text">Tap <strong>Add</strong>, then open <strong>{app}</strong> from your Home Screen and sign in there.</p>
            </div>
          </li>
        </ol>

        <p class="install-note footnote">
          Notifications only work in the Home Screen app. The Home Screen app keeps its own sign-in, so you’ll sign in once more there.
        </p>

        <button type="button" class="btn btn-primary btn-block" onClick={props.onClose}>
          {props.fromSettings ? 'Done' : 'Continue in Safari'}
        </button>
      </div>
    </div>
  );
}

/** Safari's bottom toolbar with the Share button highlighted. */
function ShareToolbarIllustration(): JSX.Element {
  return (
    <svg class="install-art" viewBox="0 0 280 64" role="img" aria-label="Safari toolbar with the Share button highlighted">
      <rect x="1" y="1" width="278" height="62" rx="14" class="art-bar" />
      <g class="art-muted" stroke-width="2.4" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M34 22l-10 10 10 10" />
        <path d="M76 22l10 10-10 10" />
        <path d="M184 23a9 9 0 1 1 0 18a9 9 0 1 1 0-18z M184 27v10 M179 32h10" />
        <rect x="228" y="23" width="18" height="18" rx="3" />
        <rect x="233" y="18" width="18" height="18" rx="3" />
      </g>
      <circle cx="140" cy="32" r="22" class="art-highlight" />
      <g class="art-tint" stroke-width="2.6" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <path d="M140 18v17 M133 25l7-7 7 7" />
        <path d="M131 30h-3v15h24v-15h-3" />
      </g>
    </svg>
  );
}

/** The share sheet's "Add to Home Screen" row. */
function MenuRowIllustration(): JSX.Element {
  return (
    <svg class="install-art" viewBox="0 0 280 56" role="img" aria-label="Add to Home Screen menu item">
      <rect x="1" y="1" width="278" height="54" rx="12" class="art-bar" />
      <text x="18" y="34" class="art-text">Add to Home Screen</text>
      <g class="art-label" stroke-width="2.2" fill="none" stroke-linecap="round" stroke-linejoin="round">
        <rect x="240" y="17" width="22" height="22" rx="5" />
        <path d="M251 22v12 M245 28h12" />
      </g>
    </svg>
  );
}
