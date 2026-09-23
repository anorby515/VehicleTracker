/**
 * Add Receipt (spec 7, 8.1, 8.5): the public face used by the shell.
 *
 * - AddReceiptHost renders the full-screen flow when openAddReceipt() is
 *   called. The flow itself (scanner, PDF building) is a separate chunk,
 *   loaded on first open.
 * - ScansSheet is "My scans" (#/scans, #/scans/<id>).
 * - The upload queue (uploads/queue.ts) keeps every finished PDF on the phone
 *   until it's uploaded.
 */

import { hasPendingUploads, pendingUploadCount, startUploads } from '../uploads/queue';
import { prefetchScanner } from '../scanner/opencv';
import { openFlow } from './state';

export { AddReceiptHost } from './Host';
export { ScansSheet } from './ScansSheet';
export { pendingUploadCount };

/** Opens the Add Receipt flow, pre-selecting the vehicle the user started from. */
export function openAddReceipt(vehicleName: string): void {
  openFlow(vehicleName);
}

/** Starts the background upload queue (called once after sign-in; safe to call again). */
export function startUploadQueue(): void {
  startUploads();
  prefetchScanner();
}

/** True if anything is queued on the device (sign-out warns first). */
export async function hasPendingWork(): Promise<boolean> {
  return hasPendingUploads();
}
