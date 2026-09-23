/**
 * The floating "Add Receipt" button (spec 6.1): large, bottom centre, above
 * the home indicator, reachable with one thumb. It sits outside the pager so
 * position: fixed isn't affected by the page scrollers.
 */

import type { JSX } from 'preact';
import { Icon } from '../ui/Icon';
import './AddReceiptButton.css';

export function AddReceiptButton(props: { onClick: () => void; vehicleName?: string }): JSX.Element {
  return (
    <button type="button" class="fab" onClick={props.onClick} aria-describedby={props.vehicleName ? 'fab-vehicle' : undefined}>
      <Icon name="camera" size={24} strokeWidth={2} />
      <span>Add Receipt</span>
      {props.vehicleName && <span id="fab-vehicle" class="visually-hidden">for the {props.vehicleName}</span>}
    </button>
  );
}
