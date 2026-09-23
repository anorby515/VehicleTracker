/**
 * Spec 7.1 step 6: "Which car?" Pre-selected to the vehicle card the person
 * started from; one tap to change. Only a hint for tracking.
 */

import type { JSX } from 'preact';
import type { Vehicle } from '../api/types';
import { Icon } from '../ui/Icon';

export function VehicleChoice(props: { vehicles: Vehicle[]; value: string; onChange: (name: string) => void; label: string }): JSX.Element {
  return (
    <div class="group" role="radiogroup" aria-label={props.label}>
      {props.vehicles.map(v => {
        const on = v.name === props.value;
        return (
          <button
            key={v.name}
            type="button"
            role="radio"
            aria-checked={on}
            class="row tappable ar-radio"
            onClick={() => props.onChange(v.name)}
          >
            <span class="row-main">
              <span class="row-title">{v.name}</span>
              {v.primaryDriver && <span class="row-sub">{v.primaryDriver}’s</span>}
            </span>
            <span class={`ar-check${on ? ' ar-check-on' : ''}`} aria-hidden="true">{on && <Icon name="check" size={18} strokeWidth={2.6} />}</span>
          </button>
        );
      })}
    </div>
  );
}

export function WhichCarStep(props: { vehicles: Vehicle[]; value: string; onChange: (name: string) => void; onUpload: () => void; summary: string }): JSX.Element {
  return (
    <div class="ar-body">
      <p class="ar-lead">{props.summary}</p>
      <section class="section">
        <VehicleChoice vehicles={props.vehicles} value={props.value} onChange={props.onChange} label="Which car?" />
        <p class="section-footer">This is only a hint to help us track it. The receipt itself decides where it’s filed.</p>
      </section>
      <div class="ar-actions">
        <button type="button" class="btn btn-primary btn-block" onClick={props.onUpload}>
          <Icon name="upload" size={20} /> Upload
        </button>
      </div>
    </div>
  );
}
