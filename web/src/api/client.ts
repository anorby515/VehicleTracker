/**
 * App API client. Every call is a POST with Content-Type text/plain and a JSON
 * body (Apps Script web apps can't answer CORS preflights, so no custom
 * headers). The session token travels in the body; the caller never adds it.
 *
 * Errors:
 * - NetworkError: offline, DNS, timeout, or a non-JSON reply. Callers queue
 *   and retry (scans, odometer readings) or show cached data.
 * - ApiFailure: the API answered with {ok:false}; `status` behaves like HTTP.
 *   A 401 also fires onUnauthorized so the app can return to sign-in.
 */

import { config, USE_MOCK } from '../config';
import type {
  ApiError, ApiRequest, BootstrapResult, FileResult, OdometerResult, OkResult, PairCreateResult,
  PrefsResult, RecallStatusResult, SignInResult, TestPushResult, UploadChunkResult, UploadStartResult,
} from './types';

/** Result type for each action. */
export interface ResultMap {
  signIn: SignInResult;
  pairCreate: PairCreateResult;
  pairRedeem: SignInResult;
  bootstrap: BootstrapResult;
  getFile: FileResult;
  addOdometer: OdometerResult;
  setRecallStatus: RecallStatusResult;
  uploadStart: UploadStartResult;
  uploadChunk: UploadChunkResult;
  subscribePush: OkResult;
  unsubscribePush: OkResult;
  savePrefs: PrefsResult;
  testPush: TestPushResult;
  signOut: OkResult;
}

type Action = keyof ResultMap;
type ParamsOf<A extends Action> = Omit<Extract<ApiRequest, { action: A }>, 'action' | 'session'>;

export class NetworkError extends Error {
  constructor(message = 'No connection') {
    super(message);
    this.name = 'NetworkError';
  }
}

export class ApiFailure extends Error {
  readonly status: ApiError['status'];
  readonly code: ApiError['error'];
  readonly detail?: Record<string, unknown>;
  constructor(e: ApiError) {
    super(e.message || e.error);
    this.name = 'ApiFailure';
    this.status = e.status;
    this.code = e.error;
    this.detail = e.detail;
  }
}

type Transport = (body: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>;

let sessionProvider: () => string | null = () => null;
let unauthorizedHandler: (e: ApiFailure) => void = () => {};
let transport: Transport = fetchTransport;

/** The store registers how to read the current session token. */
export function setSessionProvider(fn: () => string | null): void {
  sessionProvider = fn;
}

/** Called for 401/403 not_family responses on authenticated calls. */
export function onUnauthorized(fn: (e: ApiFailure) => void): void {
  unauthorizedHandler = fn;
}

/** Tests and mock mode swap the transport. */
export function setTransport(t: Transport): void {
  transport = t;
}

const NO_SESSION: Action[] = ['signIn', 'pairRedeem'];

export async function call<A extends Action>(
  action: A,
  params: ParamsOf<A>,
  opts: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<ResultMap[A]> {
  const body: Record<string, unknown> = { action, ...(params as object) };
  if (!NO_SESSION.includes(action)) body.session = sessionProvider();

  let json: unknown;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 60000);
  if (opts.signal) opts.signal.addEventListener('abort', () => ctrl.abort(), { once: true });
  try {
    json = await transport(body, ctrl.signal);
  } catch (e) {
    if (e instanceof ApiFailure) throw e;
    throw new NetworkError(e instanceof Error ? e.message : String(e));
  } finally {
    clearTimeout(timer);
  }

  if (!json || typeof json !== 'object') throw new NetworkError('Unexpected reply from the server');
  const res = json as { ok?: boolean; status?: number; error?: string; message?: string; detail?: Record<string, unknown> };
  if (res.ok === true) return res as unknown as ResultMap[A];
  const failure = new ApiFailure({
    ok: false,
    status: (res.status ?? 500) as ApiError['status'],
    error: (res.error ?? 'server_error') as ApiError['error'],
    message: res.message ?? 'Something went wrong.',
    detail: res.detail,
  });
  if (!NO_SESSION.includes(action) && (failure.status === 401 || failure.code === 'not_family')) {
    unauthorizedHandler(failure);
  }
  throw failure;
}

async function fetchTransport(body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new NetworkError();
  if (USE_MOCK) {
    const { mockTransport } = await import('./mock');
    return mockTransport(body);
  }
  const res = await fetch(config.apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(body),
    redirect: 'follow',
    credentials: 'omit',
    cache: 'no-store',
    signal,
  });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    // Apps Script returns an HTML error page when the deployment is broken.
    throw new NetworkError(`Server replied with HTTP ${res.status}`);
  }
}

/** Base64 (no data: prefix) → Blob. */
export function base64ToBlob(b64: string, mimeType: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

/** Blob slice → base64 (no data: prefix). */
export async function blobToBase64(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < buf.length; i += step) {
    bin += String.fromCharCode.apply(null, Array.from(buf.subarray(i, i + step)));
  }
  return btoa(bin);
}
