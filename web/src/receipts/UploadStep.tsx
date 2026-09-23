/**
 * Spec 7.1 steps 7–8: build the PDF on the phone, save it to the upload
 * queue (IndexedDB first, so nothing is lost), show progress, then the
 * "Got it!" confirmation. Offline, the confirmation still shows: the scan is
 * on the phone and uploads by itself later.
 */

import type { JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { ScanKind } from '../api/types';
import { deleteUpload, enqueueUpload, uploadItems, uploadStatus } from '../uploads/queue';
import { Icon } from '../ui/Icon';

export interface BuiltPdf { pdf: Blob; pages: number }

export interface UploadStepProps {
  kind: ScanKind;
  vehicle: string;
  build: () => Promise<BuiltPdf>;
  /** Called once the PDF is safely on the phone (the flow no longer needs its pages). */
  onSaved: () => void;
  onBack: () => void;
  onSeeScans: () => void;
  onDone: () => void;
}

type Phase =
  | { s: 'building' }
  | { s: 'buildError'; message: string }
  | { s: 'sending'; scanId: string }
  | { s: 'confirmed'; scanId: string };

export function UploadStep(props: UploadStepProps): JSX.Element {
  const [phase, setPhase] = useState<Phase>({ s: 'building' });
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      let built: BuiltPdf;
      try {
        // Let the spinner paint before the heavy work.
        await new Promise(r => setTimeout(r, 30));
        built = await props.build();
      } catch (e) {
        setPhase({ s: 'buildError', message: e instanceof Error ? e.message : 'Couldn’t make the PDF.' });
        return;
      }
      const scanId = await enqueueUpload({ kind: props.kind, vehicleHint: props.vehicle, pdf: built.pdf, pages: built.pages });
      props.onSaved();
      setPhase({ s: 'sending', scanId });
    })();
  }, []);

  // Subscribe to the queue while sending.
  void uploadItems.value;
  const status = phase.s === 'sending' || phase.s === 'confirmed' ? uploadStatus(phase.scanId) : null;

  useEffect(() => {
    if (phase.s !== 'sending' || !status) return;
    if (status.phase === 'done' || status.phase === 'retrying' || status.phase === 'paused') {
      setPhase({ s: 'confirmed', scanId: phase.scanId });
    }
  }, [phase.s, status?.phase]);

  if (phase.s === 'building') {
    return (
      <div class="ar-body ar-center" role="status">
        <span class="spinner" aria-hidden="true" />
        <p>Making the PDF…</p>
      </div>
    );
  }

  if (phase.s === 'buildError') {
    return (
      <div class="ar-body">
        <div class="ar-card" role="alert">
          <h3 class="title3">That didn’t work</h3>
          <p>{phase.message}</p>
        </div>
        <div class="ar-actions">
          <button type="button" class="btn btn-primary btn-block" onClick={props.onBack}>Go back</button>
        </div>
      </div>
    );
  }

  if (phase.s === 'sending' && status?.phase === 'failed') {
    return (
      <div class="ar-body">
        <div class="ar-card" role="alert">
          <h3 class="title3">Couldn’t upload</h3>
          <p>{status.error}</p>
          <p class="footnote">It’s kept on this phone for now. You’ll find it in My scans.</p>
        </div>
        <div class="ar-actions">
          <button type="button" class="btn btn-danger btn-block" onClick={() => { void deleteUpload(phase.scanId).then(props.onDone); }}>Delete it</button>
          <button type="button" class="btn btn-block" onClick={props.onSeeScans}>See my scans</button>
        </div>
      </div>
    );
  }

  if (phase.s === 'sending') {
    const pct = Math.round((status?.progress ?? 0) * 100);
    return (
      <div class="ar-body ar-center">
        <div class="ar-progress-wrap">
          <p class="headline" id="up-label">{status?.phase === 'queued' ? 'Waiting to upload…' : `Uploading ${pct}%`}</p>
          <div class="ar-progress" role="progressbar" aria-labelledby="up-label" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
            <div class="ar-progress-bar" style={{ width: `${pct}%` }} />
          </div>
          <p class="footnote">It’s saved on this phone, so it’s safe to leave. It keeps uploading while the app is open.</p>
        </div>
        <button type="button" class="btn btn-plain" onClick={() => setPhase({ s: 'confirmed', scanId: phase.scanId })}>Finish in the background</button>
      </div>
    );
  }

  // Confirmed.
  const waiting = status && status.phase !== 'done';
  const owner = props.kind === 'Owner entry';
  return (
    <div class="ar-body ar-done">
      <div class="ar-done-icon" aria-hidden="true"><Icon name="check" size={40} strokeWidth={2.6} /></div>
      <h2 class="title1">Got it!</h2>
      {owner ? (
        <p class="ar-done-text">Your entry is in the pile. It’s usually filed within a few hours. You’ll see it in the journal.</p>
      ) : (
        <p class="ar-done-text">
          Your receipt is in the pile. It’s usually filed within a few hours. You’ll see it in the journal, and we’ll let you
          know if a page needs rescanning.
        </p>
      )}
      {waiting && (
        <p class="banner banner-info ar-done-note" role="status">
          <Icon name="upload" size={18} />
          <span>
            {status?.phase === 'paused'
              ? 'It’s saved on this phone and will upload after you sign in again.'
              : 'It’s saved on this phone and will upload by itself when you’re back online.'}
          </span>
        </p>
      )}
      <div class="ar-actions">
        <button type="button" class="btn btn-block" onClick={props.onSeeScans}>See my scans</button>
        <button type="button" class="btn btn-primary btn-block" onClick={props.onDone}>Done</button>
      </div>
    </div>
  );
}
