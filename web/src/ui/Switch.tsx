/**
 * iOS-style on/off switch. A real checkbox with role="switch", so VoiceOver
 * reads "<label>, switch, on" and it works with the keyboard.
 */

import type { JSX } from 'preact';
import { useId } from 'preact/hooks';

export interface SwitchProps {
  label: string;
  /** Second line under the label. */
  detail?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (on: boolean) => void;
}

export function SwitchRow(props: SwitchProps): JSX.Element {
  const id = useId();
  return (
    <label class="row switch-row" for={id}>
      <span class="row-main">
        <span class="row-title">{props.label}</span>
        {props.detail && <span class="row-sub switch-detail">{props.detail}</span>}
      </span>
      <input
        id={id}
        type="checkbox"
        role="switch"
        class="switch"
        checked={props.checked}
        disabled={props.disabled}
        aria-checked={props.checked}
        onChange={e => props.onChange((e.currentTarget as HTMLInputElement).checked)}
      />
    </label>
  );
}
