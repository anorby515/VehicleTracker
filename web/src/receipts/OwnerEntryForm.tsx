/**
 * Spec 8.5: "Work I did myself". What was done (Service Types + free text),
 * date and mileage (each with "Approximately"), parts cost, notes, and
 * optional photos of the parts receipt or packaging (through the scanner or
 * the photo picker). pdf/ownerEntry.ts turns it into the one-page record.
 */

import type { JSX } from 'preact';
import { useId } from 'preact/hooks';
import type { Vehicle } from '../api/types';
import { formatMiles, todayYmd } from '../lib/format';
import type { ScannedPage } from '../scanner/pipeline';
import { MAX_SCAN_PAGES } from '../scanner/pipeline';
import { Icon } from '../ui/Icon';

export interface OwnerForm {
  services: string[];
  otherWork: string;
  date: string;
  dateApprox: boolean;
  mileage: string;
  mileageApprox: boolean;
  partsCost: string;
  notes: string;
}

export function emptyOwnerForm(): OwnerForm {
  return { services: [], otherWork: '', date: todayYmd(), dateApprox: false, mileage: '', mileageApprox: false, partsCost: '', notes: '' };
}

export function ownerFormDirty(f: OwnerForm): boolean {
  return !!(f.services.length || f.otherWork.trim() || f.mileage.trim() || f.partsCost.trim() || f.notes.trim());
}

/** Parsed numbers, or a list of problems to show. */
export function validateOwnerForm(f: OwnerForm, today = todayYmd()): { errors: string[]; mileage: number | null; partsCost: number | null } {
  const errors: string[] = [];
  if (!f.services.length && !f.otherWork.trim()) errors.push('Pick what you did, or describe it.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(f.date)) errors.push('Enter the date you did the work.');
  else if (f.date > today) errors.push('The date can’t be in the future.');
  let mileage: number | null = null;
  if (f.mileage.trim()) {
    mileage = Math.round(Number(f.mileage.replace(/[,\s]/g, '')));
    if (!Number.isFinite(mileage) || mileage < 1 || mileage > 999_999) { errors.push('Enter the mileage as a whole number.'); mileage = null; }
  }
  let partsCost: number | null = null;
  if (f.partsCost.trim()) {
    partsCost = Number(f.partsCost.replace(/[$,\s]/g, ''));
    if (!Number.isFinite(partsCost) || partsCost < 0 || partsCost > 100_000) { errors.push('Enter the parts cost in dollars, like 24.99.'); partsCost = null; }
    else partsCost = Math.round(partsCost * 100) / 100;
  }
  return { errors, mileage, partsCost };
}

export interface OwnerEntryFormProps {
  vehicles: Vehicle[];
  vehicle: string;
  onVehicle: (name: string) => void;
  serviceTypes: string[];
  form: OwnerForm;
  onChange: (f: OwnerForm) => void;
  photos: ScannedPage[];
  onRemovePhoto: (index: number) => void;
  onScanPhotos: () => void;
  onPickPhotos: (files: File[]) => void;
  pickingPhotos: boolean;
  errors: string[];
  onSubmit: () => void;
}

export function OwnerEntryForm(props: OwnerEntryFormProps): JSX.Element {
  const id = useId();
  const f = props.form;
  const set = (p: Partial<OwnerForm>) => props.onChange({ ...f, ...p });
  const v = props.vehicles.find(x => x.name === props.vehicle);
  const toggle = (s: string, on: boolean) => set({ services: on ? [...f.services, s] : f.services.filter(x => x !== s) });

  const onPick = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    if (picked.length) props.onPickPhotos(picked);
  };

  return (
    <form class="ar-body owner-form" onSubmit={e => { e.preventDefault(); props.onSubmit(); }} noValidate>
      <p class="ar-lead">For work you did yourself, like new wiper blades. We’ll make a one-page record for the journal.</p>

      <section class="section">
        <label class="owner-label owner-label-first" for={`${id}-vehicle`}>Vehicle</label>
        <select id={`${id}-vehicle`} class="field" value={props.vehicle} onChange={e => props.onVehicle(e.currentTarget.value)}>
          {props.vehicles.map(x => <option key={x.name} value={x.name}>{x.name}</option>)}
        </select>
      </section>

      <fieldset class="section owner-fieldset">
        <legend class="section-header">What did you do?</legend>
        <div class="group">
          {props.serviceTypes.map(s => (
            <label key={s} class="row owner-check">
              <input type="checkbox" checked={f.services.includes(s)} onChange={e => toggle(s, e.currentTarget.checked)} />
              <span class="row-main">{s}</span>
            </label>
          ))}
        </div>
        <label class="owner-label" for={`${id}-other`}>Describe the work {f.services.length ? '(optional)' : ''}</label>
        <textarea id={`${id}-other`} class="field" rows={2} value={f.otherWork} placeholder="Replaced both front wiper blades"
          onInput={e => set({ otherWork: e.currentTarget.value })} />
      </fieldset>

      <section class="section">
        <div class="section-header"><h3>When</h3></div>
        <div class="owner-pair">
          <label class="owner-label" for={`${id}-date`}>Date</label>
          <input id={`${id}-date`} class="field" type="date" value={f.date} max={todayYmd()} onInput={e => set({ date: e.currentTarget.value })} />
          <label class="owner-approx">
            <input type="checkbox" checked={f.dateApprox} onChange={e => set({ dateApprox: e.currentTarget.checked })} />
            <span>Approximately</span>
            <span class="visually-hidden"> (the date)</span>
          </label>
        </div>
        <div class="owner-pair">
          <label class="owner-label" for={`${id}-miles`}>Mileage (optional)</label>
          <input id={`${id}-miles`} class="field" type="text" inputMode="numeric" autoComplete="off" value={f.mileage}
            placeholder={v?.estMileage ? `About ${formatMiles(v.estMileage)}` : 'Odometer reading'}
            onInput={e => set({ mileage: e.currentTarget.value })} />
          <label class="owner-approx">
            <input type="checkbox" checked={f.mileageApprox} onChange={e => set({ mileageApprox: e.currentTarget.checked })} />
            <span>Approximately</span>
            <span class="visually-hidden"> (the mileage)</span>
          </label>
        </div>
      </section>

      <section class="section">
        <div class="section-header"><h3>Cost and notes</h3></div>
        <label class="owner-label" for={`${id}-cost`}>Parts cost (optional)</label>
        <div class="owner-money">
          <span aria-hidden="true">$</span>
          <input id={`${id}-cost`} class="field" type="text" inputMode="decimal" autoComplete="off" value={f.partsCost} placeholder="0.00"
            onInput={e => set({ partsCost: e.currentTarget.value })} />
        </div>
        <label class="owner-label" for={`${id}-notes`}>Notes (optional)</label>
        <textarea id={`${id}-notes`} class="field" rows={3} value={f.notes} placeholder="Part numbers, where you bought them…"
          onInput={e => set({ notes: e.currentTarget.value })} />
      </section>

      <section class="section">
        <div class="section-header"><h3>Photos (optional)</h3></div>
        <p class="footnote owner-hint">The parts receipt or the packaging helps later. They’re added after the record.</p>
        {props.photos.length > 0 && (
          <ul class="owner-photos" aria-label="Photos">
            {props.photos.map((p, i) => (
              <li key={p.id} class="owner-photo">
                <img src={p.thumb} alt={`Photo ${i + 1}`} />
                <button type="button" class="owner-photo-remove" aria-label={`Remove photo ${i + 1}`} onClick={() => props.onRemovePhoto(i)}>
                  <Icon name="close" size={16} strokeWidth={2.4} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <div class="owner-photo-actions">
          <button type="button" class="btn" onClick={props.onScanPhotos} disabled={props.photos.length >= MAX_SCAN_PAGES}>
            <Icon name="camera" size={20} /> Scan
          </button>
          <label class={`btn ar-file-btn${props.photos.length >= MAX_SCAN_PAGES ? ' is-disabled' : ''}`}>
            {props.pickingPhotos ? <span class="spinner" aria-hidden="true" /> : <Icon name="photo" size={20} />}
            <span>Choose photos</span>
            <input type="file" multiple accept="image/*" class="visually-hidden" aria-label="Choose photos" onChange={onPick}
              disabled={props.photos.length >= MAX_SCAN_PAGES} />
          </label>
        </div>
      </section>

      {props.errors.length > 0 && (
        <div class="banner banner-alert ar-pad-x" role="alert">
          <Icon name="alert" size={18} />
          <span>{props.errors.join(' ')}</span>
        </div>
      )}

      <div class="ar-actions">
        <button type="submit" class="btn btn-primary btn-block"><Icon name="upload" size={20} /> Upload</button>
      </div>
    </form>
  );
}
