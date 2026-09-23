/**
 * Add Receipt overlay state. The flow is driven by this signal, never by the
 * URL: in a home-screen app iOS asks for camera permission again when the
 * hash changes, so the scanner can't be a route.
 */

import { signal } from '@preact/signals';
import { local } from '../lib/db';

export interface FlowRequest {
  /** The vehicle card the person started from (pre-selected under "Which car?"). */
  vehicle: string;
  /** Changes on every open, so the flow starts fresh. */
  id: number;
}

export const flowRequest = signal<FlowRequest | null>(null);

let seq = 0;

export function openFlow(vehicle: string): void {
  seq++;
  flowRequest.value = { vehicle, id: seq };
}

export function closeFlow(): void {
  flowRequest.value = null;
}

// ---------------------------------------------------------------- per-device preferences
// Deliberately not prefixed "vehicles." so they survive sign-out (they're about the phone, not the person).

const COACH_KEY = 'receipts.coachShown';
const MAIL_TIP_KEY = 'receipts.mailTipSeen';
const AUTO_KEY = 'receipts.autoCapture';

/** The full "One visit, one scan" card shows the first three times on a phone. */
export const FULL_COACH_TIMES = 3;

export function coachCount(): number {
  const n = Number(local.get(COACH_KEY));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function bumpCoachCount(): void {
  local.set(COACH_KEY, String(coachCount() + 1));
}

export function mailTipSeen(): boolean {
  return local.get(MAIL_TIP_KEY) === '1';
}

export function markMailTipSeen(): void {
  local.set(MAIL_TIP_KEY, '1');
}

export function autoCaptureOn(): boolean {
  return local.get(AUTO_KEY) !== '0';
}

export function setAutoCapture(on: boolean): void {
  local.set(AUTO_KEY, on ? '1' : '0');
}
