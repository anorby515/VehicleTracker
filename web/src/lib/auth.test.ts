import { beforeEach, describe, expect, it } from 'vitest';
import { buildAuthUrl, consumeRedirect, decodeJwtPayload, redirectUri } from './auth';

function jwt(payload: object): string {
  const b64 = (o: object) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(o)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `${b64({ alg: 'RS256' })}.${b64(payload)}.sig`;
}

function setPending(p: { state: string; nonce: string; returnTo?: string; createdAt?: number }) {
  localStorage.setItem('vehicles.oidc', JSON.stringify({ returnTo: '#/', createdAt: Date.now(), ...p }));
}

describe('OIDC redirect sign-in', () => {
  beforeEach(() => localStorage.clear());

  it('builds an id_token + fragment request with state, nonce and account chooser', () => {
    const url = new URL(buildAuthUrl({ clientId: 'cid.apps.googleusercontent.com', redirect: 'https://x.github.io/VehicleTracker/', state: 's1', nonce: 'n1' }));
    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('response_type')).toBe('id_token');
    expect(url.searchParams.get('response_mode')).toBe('fragment');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('state')).toBe('s1');
    expect(url.searchParams.get('nonce')).toBe('n1');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('redirect_uri')).toBe('https://x.github.io/VehicleTracker/');
  });

  it('redirect URI is the app root', () => {
    expect(redirectUri({ origin: 'https://anorby515.github.io' })).toBe('https://anorby515.github.io' + import.meta.env.BASE_URL);
  });

  it('ignores ordinary hash routes', () => {
    expect(consumeRedirect('#/v/2023%20Toyota%204Runner')).toEqual({ kind: 'none' });
  });

  it('accepts a matching state and nonce and returns the token', () => {
    setPending({ state: 'abc', nonce: 'n-1', returnTo: '#/scans' });
    const token = jwt({ nonce: 'n-1', email: 'a@example.com' });
    const r = consumeRedirect(`#state=abc&id_token=${token}&authuser=0`);
    expect(r).toEqual({ kind: 'token', idToken: token, nonce: 'n-1', returnTo: '#/scans' });
    expect(localStorage.getItem('vehicles.oidc')).toBeNull();
  });

  it('rejects a state mismatch', () => {
    setPending({ state: 'abc', nonce: 'n-1' });
    const r = consumeRedirect(`#state=evil&id_token=${jwt({ nonce: 'n-1' })}`);
    expect(r.kind).toBe('error');
  });

  it('rejects a nonce mismatch', () => {
    setPending({ state: 'abc', nonce: 'n-1' });
    const r = consumeRedirect(`#state=abc&id_token=${jwt({ nonce: 'other' })}`);
    expect(r.kind).toBe('error');
  });

  it('rejects a reply with no pending request or an expired one', () => {
    expect(consumeRedirect(`#state=abc&id_token=${jwt({ nonce: 'n' })}`).kind).toBe('error');
    setPending({ state: 'abc', nonce: 'n', createdAt: Date.now() - 60 * 60 * 1000 });
    expect(consumeRedirect(`#state=abc&id_token=${jwt({ nonce: 'n' })}`).kind).toBe('error');
  });

  it('reports a cancelled sign-in in plain language', () => {
    setPending({ state: 'abc', nonce: 'n' });
    const r = consumeRedirect('#error=access_denied&state=abc');
    expect(r).toMatchObject({ kind: 'error', message: 'Sign-in was cancelled.' });
  });

  it('decodes JWT payloads with UTF-8', () => {
    const t = jwt({ name: 'José' });
    expect(decodeJwtPayload(t)).toEqual({ name: 'José' });
    expect(decodeJwtPayload('garbage')).toBeNull();
  });
});
