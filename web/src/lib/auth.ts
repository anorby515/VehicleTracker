/**
 * Google sign-in by full-page OpenID Connect redirect (see docs/DECISIONS.md).
 *
 * Google's popup and One Tap don't survive iPhone home-screen apps, so the app
 * navigates to Google and asks it to come back to the app's own URL with the
 * ID token in the fragment:
 *
 *   https://anorby515.github.io/VehicleTracker/#state=…&id_token=…
 *
 * Because that URL is inside the app's scope, iOS returns to the standalone
 * app (same storage). `state` is checked here; `nonce` is sent to the API,
 * which checks the token echoes it. The ID token is exchanged once for the
 * app's own 60-day session and then discarded.
 */

import { config } from '../config';

const PENDING_KEY = 'vehicles.oidc';
const PENDING_TTL_MS = 15 * 60 * 1000;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

interface Pending {
  state: string;
  nonce: string;
  returnTo: string;
  createdAt: number;
}

export type RedirectResult =
  | { kind: 'none' }
  | { kind: 'token'; idToken: string; nonce: string; returnTo: string }
  | { kind: 'error'; message: string; returnTo: string };

/** The exact redirect URI registered in Google Cloud (app root, trailing slash). */
export function redirectUri(loc: Pick<Location, 'origin'> = location): string {
  return loc.origin + import.meta.env.BASE_URL;
}

export function randomToken(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Builds the Google authorization URL and remembers state/nonce for the return trip. */
export function buildAuthUrl(opts: { clientId: string; redirect: string; state: string; nonce: string; loginHint?: string }): string {
  const p = new URLSearchParams({
    client_id: opts.clientId,
    redirect_uri: opts.redirect,
    response_type: 'id_token',
    response_mode: 'fragment',
    scope: 'openid email profile',
    state: opts.state,
    nonce: opts.nonce,
    prompt: 'select_account',
  });
  if (opts.loginHint) p.set('login_hint', opts.loginHint);
  return `${AUTH_ENDPOINT}?${p.toString()}`;
}

/** Leaves the app for Google's sign-in page. */
export function startGoogleSignIn(returnTo: string = location.hash || '#/'): void {
  if (!config.oauthClientId) throw new Error('Sign-in isn’t set up yet (oauthClientId is empty in app.config.json).');
  const pending: Pending = { state: randomToken(), nonce: randomToken(), returnTo: safeReturn(returnTo), createdAt: Date.now() };
  try {
    localStorage.setItem(PENDING_KEY, JSON.stringify(pending));
  } catch {
    throw new Error('This browser is blocking storage, so sign-in can’t finish. Turn off Private Browsing and try again.');
  }
  location.assign(buildAuthUrl({ clientId: config.oauthClientId, redirect: redirectUri(), state: pending.state, nonce: pending.nonce }));
}

/**
 * Called once at startup. If the URL fragment carries Google's reply, checks
 * `state`, cleans the URL, and returns the token (or the error) for the store.
 */
export function consumeRedirect(hash: string = location.hash, now = Date.now()): RedirectResult {
  const frag = hash.replace(/^#/, '');
  if (!/(^|&)(id_token|error)=/.test(frag)) return { kind: 'none' };
  const params = new URLSearchParams(frag);
  const pending = readPending();
  clearPending();
  const returnTo = pending?.returnTo ?? '#/';
  cleanUrl(returnTo);

  const error = params.get('error');
  if (error) {
    return {
      kind: 'error',
      returnTo,
      message: error === 'access_denied' ? 'Sign-in was cancelled.' : `Google couldn’t sign you in (${error}).`,
    };
  }
  const idToken = params.get('id_token');
  if (!pending || now - pending.createdAt > PENDING_TTL_MS) {
    return { kind: 'error', returnTo, message: 'That sign-in took too long or started somewhere else. Please try again.' };
  }
  if (!idToken || params.get('state') !== pending.state) {
    return { kind: 'error', returnTo, message: 'Sign-in couldn’t be verified. Please try again.' };
  }
  const claims = decodeJwtPayload(idToken);
  if (!claims || claims.nonce !== pending.nonce) {
    return { kind: 'error', returnTo, message: 'Sign-in couldn’t be verified. Please try again.' };
  }
  return { kind: 'token', idToken, nonce: pending.nonce, returnTo };
}

/** Reads a JWT's payload without verifying it (the API verifies). */
export function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split('.')[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    const json = decodeURIComponent(
      Array.from(atob(b64), c => '%' + c.charCodeAt(0).toString(16).padStart(2, '0')).join(''),
    );
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function readPending(): Pending | null {
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    return raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    return null;
  }
}

function clearPending(): void {
  try { localStorage.removeItem(PENDING_KEY); } catch { /* ignore */ }
}

/** Only in-app hash routes are allowed as a return target. */
function safeReturn(hash: string): string {
  return /^#\/[^\s]*$/.test(hash) && !/(id_token|error)=/.test(hash) ? hash : '#/';
}

/** Removes the token from the address bar and history immediately. */
function cleanUrl(returnTo: string): void {
  try {
    history.replaceState(null, '', location.pathname + location.search + returnTo);
  } catch {
    /* ignore */
  }
}
