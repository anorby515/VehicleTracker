/**
 * Update Odometer (spec 8.4): a number pad, empty by default, with the
 * current estimate as a hint. Lower than the latest reading is blocked;
 * more than 5,000 mi over the estimate asks "Are you sure?". Offline, the
 * reading waits on the phone and sends itself later (state/odometer.ts).
 */

import type { JSX } from 'preact';
import { useId, useRef, useState } from 'preact/hooks';
import type { Vehicle } from '../../api/types';
import { formatDate, formatMiles } from '../../lib/format';
import { submitOdometer } from '../../state/odometer';
import { Sheet } from '../../ui/Sheet';
import { toast } from '../../ui/toast';

type Status =
  | { s: 'idle' }
  | { s: 'saving' }
  | { s: 'below'; mileage: number; date: string | null }
  | { s: 'confirm'; mileage: number; over: number }
  | { s: 'queued' }
  | { s: 'error'; message: string };

/** Digits only ("37,800" → 37800); null when empty or out of range. */
export function parseMileage(text: string): number | null {
  const digits = text.replace(/[^\d]/g, '');
  if (!digits) return null;
  const n = Number(digits);
  return n >= 1 && n <= 999999 ? n : null;
}

export function OdometerSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const [text, setText] = useState('');
  const [status, setStatus] = useState<Status>({ s: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const id = useId();
  const hintId = `${id}-hint`;
  const msgId = `${id}-msg`;

  const save = async (confirmHigh = false) => {
    const mileage = parseMileage(text);
    if (mileage === null) {
      setStatus({ s: 'error', message: 'Enter the miles shown on the odometer, as a whole number.' });
      input.current?.focus();
      return;
    }
    setStatus({ s: 'saving' });
    const out = await submitOdometer({ vehicle: v.name, mileage, confirmHigh });
    switch (out.kind) {
      case 'saved':
        toast(`Odometer saved: ${formatMiles(mileage)}`);
        props.onClose();
        return;
      case 'queued':
        setStatus({ s: 'queued' });
        return;
      case 'below_latest':
        setStatus({ s: 'below', mileage: out.mileage, date: out.date });
        return;
      case 'confirm_high':
        setStatus({ s: 'confirm', mileage, over: Math.max(0, mileage - out.estimate) });
        return;
      default:
        setStatus({ s: 'error', message: out.message });
    }
  };

  const onSubmit = (e: Event) => {
    e.preventDefault();
    if (status.s === 'saving' || status.s === 'below') return;
    void save(false);
  };

  const blocked = status.s === 'below' || status.s === 'saving' || status.s === 'queued';

  return (
    <Sheet title="Update Odometer" onClose={props.onClose} class="odometer-sheet">
      <div class="vsheet-hero">
        <h3 class="title2">{v.name}</h3>
      </div>
      <form class="section" onSubmit={onSubmit} noValidate>
        <label class="field-label" for={id}>Odometer reading (miles)</label>
        <input
          ref={input}
          id={id}
          class="field odo-input"
          type="text"
          inputMode="numeric"
          pattern="[0-9]*"
          autocomplete="off"
          enterKeyHint="done"
          value={text}
          aria-describedby={`${hintId}${status.s !== 'idle' && status.s !== 'saving' ? ` ${msgId}` : ''}`}
          aria-invalid={status.s === 'below' || status.s === 'error' ? 'true' : undefined}
          disabled={status.s === 'queued'}
          onInput={e => {
            setText((e.currentTarget as HTMLInputElement).value);
            if (status.s !== 'saving' && status.s !== 'queued') setStatus({ s: 'idle' });
          }}
        />
        <p class="field-hint" id={hintId}>
          {v.estMileage !== null ? `Estimated ~${formatMiles(v.estMileage)}` : 'No estimate yet'}
          {v.latestOdometer !== null && (
            <><br />Last reading {formatMiles(v.latestOdometer)}{v.latestOdometerDate ? ` on ${formatDate(v.latestOdometerDate)}` : ''}</>
          )}
        </p>

        <div id={msgId} aria-live="polite">
          {status.s === 'below' && (
            <div class="form-message form-error" role="alert">
              That’s lower than the last reading: {formatMiles(status.mileage)}{status.date ? ` on ${formatDate(status.date)}` : ''}.
              {' '}Check the odometer and try again.
            </div>
          )}
          {status.s === 'confirm' && (
            <div class="form-message form-warn" role="alert">
              <div>Are you sure? That’s {formatMiles(status.over)} more than expected.</div>
              <button type="button" class="btn btn-primary" onClick={() => void save(true)}>Confirm {formatMiles(status.mileage)}</button>
              <button type="button" class="btn" onClick={() => { setStatus({ s: 'idle' }); input.current?.focus(); }}>Change it</button>
            </div>
          )}
          {status.s === 'queued' && (
            <div class="form-message form-info" role="status">
              Saved on this phone. It’ll send when you’re back online.
            </div>
          )}
          {status.s === 'error' && <div class="form-message form-error" role="alert">{status.message}</div>}
        </div>

        <div class="odo-actions">
          {status.s === 'queued'
            ? <button type="button" class="btn btn-primary btn-block" onClick={props.onClose}>Done</button>
            : (
              <button type="submit" class="btn btn-primary btn-block" disabled={blocked || status.s === 'confirm'}>
                {status.s === 'saving' ? 'Saving…' : 'Save reading'}
              </button>
            )}
        </div>
      </form>
    </Sheet>
  );
}
