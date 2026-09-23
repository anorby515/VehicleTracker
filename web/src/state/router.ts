/**
 * Hash router. Hash routes keep GitHub Pages from ever serving a 404 and let
 * push notifications deep-link into the app (docs/API.md › Deep links).
 */

import { signal } from '@preact/signals';

export type Panel = 'basics' | 'odometer' | 'costs' | 'wear' | 'registration' | 'recalls' | 'coverage' | 'export';
export const PANELS: Panel[] = ['basics', 'odometer', 'costs', 'wear', 'registration', 'recalls', 'coverage', 'export'];

export type Route =
  | { name: 'home' }
  | { name: 'vehicle'; vehicle: string; sub?: VehicleSub }
  | { name: 'scans'; scanId?: string }
  | { name: 'search'; q: string }
  | { name: 'settings' };

export type VehicleSub =
  | { kind: 'visit'; visitId: string }
  | { kind: 'upcoming'; itemId: string }
  | { kind: 'panel'; panel: Panel };

export function parseHash(hash: string): Route {
  const h = hash.replace(/^#/, '');
  const [pathPart, query = ''] = h.split('?');
  const parts = pathPart.split('/').filter(Boolean).map(p => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  if (parts[0] === 'v' && parts[1]) {
    const vehicle = parts[1];
    if (parts[2] === 'visit' && parts[3]) return { name: 'vehicle', vehicle, sub: { kind: 'visit', visitId: parts[3] } };
    if (parts[2] === 'upcoming' && parts[3]) return { name: 'vehicle', vehicle, sub: { kind: 'upcoming', itemId: parts[3] } };
    if (parts[2] && (PANELS as string[]).includes(parts[2])) return { name: 'vehicle', vehicle, sub: { kind: 'panel', panel: parts[2] as Panel } };
    return { name: 'vehicle', vehicle };
  }
  if (parts[0] === 'scans') return { name: 'scans', scanId: parts[1] };
  if (parts[0] === 'search') return { name: 'search', q: new URLSearchParams(query).get('q') ?? '' };
  if (parts[0] === 'settings') return { name: 'settings' };
  return { name: 'home' };
}

const enc = encodeURIComponent;
export const href = {
  home: () => '#/',
  vehicle: (v: string) => `#/v/${enc(v)}`,
  visit: (v: string, visitId: string) => `#/v/${enc(v)}/visit/${enc(visitId)}`,
  upcoming: (v: string, itemId: string) => `#/v/${enc(v)}/upcoming/${enc(itemId)}`,
  panel: (v: string, p: Panel) => `#/v/${enc(v)}/${p}`,
  scans: () => '#/scans',
  scan: (id: string) => `#/scans/${enc(id)}`,
  search: (q = '') => (q ? `#/search?q=${enc(q)}` : '#/search'),
  settings: () => '#/settings',
};

export const route = signal<Route>(parseHash(typeof location === 'undefined' ? '' : location.hash));

if (typeof window !== 'undefined') {
  window.addEventListener('hashchange', () => { route.value = parseHash(location.hash); });
}

/** In-app navigation depth, so "close" can go back instead of stacking entries. */
let depth = 0;

/** Navigate. `replace` swaps the current entry (no new history entry). */
export function go(to: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', to);
    route.value = parseHash(to);
  } else {
    depth++;
    location.hash = to.replace(/^#/, '');
  }
}

/**
 * Close a sheet or sub-screen: step back when we got here by in-app
 * navigation, otherwise (deep link from a notification) replace with `fallback`.
 */
export function back(fallback: string): void {
  if (depth > 0) {
    depth--;
    history.back();
  } else {
    go(fallback, true);
  }
}
