/**
 * App state (Preact signals). One bootstrap payload drives every screen; it is
 * cached on the device with its timestamp so the app opens instantly and works
 * offline ("Offline: showing data from 2:14 PM").
 */

import { computed, signal } from '@preact/signals';
import { ApiFailure, NetworkError, call, onUnauthorized, setSessionProvider } from '../api/client';
import type { Bootstrap, User } from '../api/types';
import { clearAll, kvGet, kvSet, local } from '../lib/db';
import { consumeRedirect } from '../lib/auth';
import { go } from './router';

const SESSION_KEY = 'vehicles.session';
const BOOTSTRAP_KEY = 'bootstrap';

export type AuthState = 'loading' | 'signedOut' | 'notFamily' | 'signedIn';

export const session = signal<string | null>(local.get(SESSION_KEY));
export const authState = signal<AuthState>('loading');
export const bootstrap = signal<Bootstrap | null>(null);
/** When the current bootstrap was fetched from the server (epoch ms). */
export const bootstrapFetchedAt = signal<number | null>(null);
export const online = signal<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine !== false);
export const refreshing = signal(false);
/** Last refresh error shown quietly (not for offline). */
export const refreshError = signal<string | null>(null);
/** The message to show on the sign-in screen after a failure. */
export const signInMessage = signal<string | null>(null);

export const user = computed<User | null>(() => bootstrap.value?.user ?? null);
export const vehicles = computed(() => bootstrap.value?.vehicles ?? []);
/** The vehicle on screen in the main pager, by name (set by screens/Main.tsx). */
export const currentVehicleName = signal<string | null>(null);

setSessionProvider(() => session.value);
onUnauthorized(e => {
  if (e.code === 'not_family') {
    void resetDevice().then(() => { authState.value = 'notFamily'; });
  } else {
    signInMessage.value = 'Please sign in again.';
    setSession(null);
    authState.value = 'signedOut';
  }
});

function setSession(token: string | null): void {
  session.value = token;
  if (token) local.set(SESSION_KEY, token);
  else local.remove(SESSION_KEY);
}

/** Called once at startup: show cached data immediately, then refresh. */
export async function boot(): Promise<void> {
  if (typeof window !== 'undefined') {
    window.addEventListener('online', () => { online.value = true; void refresh(); });
    window.addEventListener('offline', () => { online.value = false; });
  }
  // Returning from Google's sign-in page? (lib/auth.ts)
  const ret = consumeRedirect();
  if (ret.kind !== 'none') {
    go(ret.returnTo, true);
    if (ret.kind === 'error') {
      signInMessage.value = ret.message;
    } else {
      await signInWithGoogle(ret.idToken, ret.nonce);
      return;
    }
  }
  if (!session.value) {
    authState.value = 'signedOut';
    return;
  }
  const cached = await kvGet<{ data: Bootstrap; at: number }>(BOOTSTRAP_KEY);
  if (cached?.data) {
    bootstrap.value = cached.data;
    bootstrapFetchedAt.value = cached.at;
    authState.value = 'signedIn';
  }
  await refresh();
  if (authState.value === 'loading') authState.value = bootstrap.value ? 'signedIn' : 'signedOut';
}

/**
 * After a refresh can't reach the server, try again on its own a few times.
 * iOS often drops the first request after a home-screen app wakes up, and
 * the 'online' event never fires because the phone was online all along.
 */
const RETRY_DELAYS_MS = [3000, 10000, 30000];
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryAttempt = 0;
let autoRetrying = false;

function scheduleRetry(): void {
  if (retryTimer !== undefined || retryAttempt >= RETRY_DELAYS_MS.length) return;
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    // In the background: coming back to the app refreshes anyway.
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
    autoRetrying = true;
    void refresh().finally(() => { autoRetrying = false; });
  }, RETRY_DELAYS_MS[retryAttempt++]);
}

function cancelRetry(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  retryAttempt = 0;
}

/** Fetches a fresh bootstrap. Offline → keeps cached data, marks offline, retries shortly. */
export async function refresh(): Promise<boolean> {
  if (!session.value || refreshing.value) return false;
  // A refresh someone asked for (pull down, back to the app) starts the retries over.
  if (!autoRetrying) retryAttempt = 0;
  refreshing.value = true;
  try {
    const res = await call('bootstrap', {});
    if (res.session) setSession(res.session);
    bootstrap.value = res.bootstrap;
    const at = Date.now();
    bootstrapFetchedAt.value = at;
    await kvSet(BOOTSTRAP_KEY, { data: res.bootstrap, at });
    online.value = true;
    refreshError.value = null;
    authState.value = 'signedIn';
    cancelRetry();
    return true;
  } catch (e) {
    if (e instanceof NetworkError) {
      online.value = false;
      scheduleRetry();
    } else if (e instanceof ApiFailure) {
      if (e.status !== 401 && e.code !== 'not_family') refreshError.value = e.message;
    } else {
      refreshError.value = String(e);
    }
    return false;
  } finally {
    refreshing.value = false;
  }
}

/** Exchange a Google ID token (or, in mock mode, an email) for an app session. */
export async function signInWithGoogle(idToken: string, nonce = ''): Promise<void> {
  await completeSignIn(() => call('signIn', { idToken, nonce }));
}

/** Exchange a one-time code from another signed-in device for a session. */
export async function signInWithCode(code: string): Promise<void> {
  await completeSignIn(() => call('pairRedeem', { code: code.trim().toUpperCase() }));
}

async function completeSignIn(fn: () => Promise<{ session: string }>): Promise<void> {
  signInMessage.value = null;
  try {
    const res = await fn();
    setSession(res.session);
    authState.value = 'loading';
    await refresh();
    authState.value = bootstrap.value ? 'signedIn' : 'signedOut';
  } catch (e) {
    if (e instanceof ApiFailure && e.code === 'not_family') {
      authState.value = 'notFamily';
    } else if (e instanceof NetworkError) {
      signInMessage.value = 'No connection. Try again when you’re online.';
    } else {
      signInMessage.value = e instanceof Error ? e.message : 'Sign-in failed.';
    }
  }
}

/** Clears everything on the device. Callers warn first if uploads are pending. */
export async function resetDevice(): Promise<void> {
  cancelRetry();
  setSession(null);
  bootstrap.value = null;
  bootstrapFetchedAt.value = null;
  currentVehicleName.value = null;
  refreshError.value = null;
  await clearAll();
  try {
    const keys = Object.keys(localStorage).filter(k => k.startsWith('vehicles.'));
    keys.forEach(k => localStorage.removeItem(k));
  } catch {
    /* ignore */
  }
}

/** Sign out: tell the API (best effort, deactivates this phone's push), then wipe local data. */
export async function signOut(pushEndpoint?: string): Promise<void> {
  try {
    if (session.value) await call('signOut', pushEndpoint ? { endpoint: pushEndpoint } : {}, { timeoutMs: 8000 });
  } catch {
    /* offline: the token simply stops being used */
  }
  await resetDevice();
  authState.value = 'signedOut';
}
