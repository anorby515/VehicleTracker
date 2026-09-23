/**
 * Top bar: settings, the current vehicle's name with page dots, and search.
 * Drawn under the status bar (black-translucent), so it pads itself with the
 * safe-area inset.
 */

import type { JSX } from 'preact';
import type { Vehicle } from '../api/types';
import { href, go } from '../state/router';
import { Icon } from '../ui/Icon';
import './TopBar.css';

export interface TopBarProps {
  vehicles: Vehicle[];
  current: number;
  title: string;
  onDot: (index: number) => void;
}

export function TopBar(props: TopBarProps): JSX.Element {
  const n = props.vehicles.length;
  const density = n <= 6 ? '' : n <= 8 ? ' dots-mid' : ' dots-many';
  return (
    <header class="topbar">
      <div class="topbar-row">
        <button type="button" class="icon-btn" aria-label="Settings" onClick={() => go(href.settings())}>
          <Icon name="gear" />
        </button>
        <div class="topbar-center">
          <h1 class="topbar-title ellipsis" aria-live="polite">{props.title}</h1>
          {props.vehicles.length > 1 && (
            <div class={`dots${density}`} role="group" aria-label="Choose a vehicle">
              {props.vehicles.map((v, i) => (
                <button
                  type="button"
                  key={v.name}
                  class="dot"
                  aria-label={`Show ${v.name}`}
                  aria-current={i === props.current ? 'true' : undefined}
                  onClick={() => props.onDot(i)}
                >
                  <span class="dot-mark" aria-hidden="true" />
                </button>
              ))}
            </div>
          )}
        </div>
        <button type="button" class="icon-btn" aria-label="Search all vehicles" onClick={() => go(href.search())}>
          <Icon name="search" />
        </button>
      </div>
    </header>
  );
}
