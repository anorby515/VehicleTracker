/**
 * Small pieces shared by the vehicle card and its sheets: in-app links that
 * keep the router's back-stack right, copy-to-clipboard with long-press, and
 * a label/value row.
 */

import type { ComponentChildren, JSX } from 'preact';
import { useRef } from 'preact/hooks';
import { go } from '../state/router';
import { toast } from '../ui/toast';
import { bootstrap } from '../state/store';
import { todayYmd } from '../lib/format';
import './vehicle.css';

/**
 * A link to an in-app hash route. Uses go() (not a bare hash change) so the
 * router counts the step and Close can go back instead of stacking entries.
 */
export function RouteLink(props: {
  href: string;
  class?: string;
  children: ComponentChildren;
  'aria-label'?: string;
  'aria-describedby'?: string;
}): JSX.Element {
  const onClick = (e: MouseEvent) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    go(props.href);
  };
  return (
    <a
      href={props.href}
      class={props.class}
      onClick={onClick}
      aria-label={props['aria-label']}
      aria-describedby={props['aria-describedby']}
    >
      {props.children}
    </a>
  );
}

/**
 * Copies text. Must run inside a tap/click handler on iOS (transient user
 * activation). Falls back to a hidden textarea + execCommand where the
 * Clipboard API is missing or refuses.
 */
export async function copyToClipboard(text: string): Promise<boolean> {
  // Start the legacy path synchronously too, while the gesture is still active.
  let legacy = false;
  if (!navigator.clipboard?.writeText) legacy = legacyCopy(text);
  if (legacy) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return legacyCopy(text);
  }
}

function legacyCopy(text: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    ta.style.top = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Copy with a toast: "Copied" (or `label`), or a gentle failure. */
export function copyWithToast(text: string, label = 'Copied'): void {
  void copyToClipboard(text).then(ok => toast(ok ? label : 'Couldn’t copy. Touch and hold to select it instead.'));
}

export const LONG_PRESS_MS = 500;

/**
 * Long-press (≈500 ms hold) to copy. iOS only allows clipboard writes inside a
 * user gesture, so the hold "arms" the copy and the copy happens on release
 * (pointerup is a gesture); the contextmenu event (desktop right-click,
 * Android long-press) copies straight away.
 */
export function useLongPressCopy(text: string | null): JSX.HTMLAttributes<HTMLDivElement> {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armed = useRef(false);
  const copied = useRef(false);
  const start = useRef<{ x: number; y: number } | null>(null);
  const el = useRef<HTMLElement | null>(null);

  if (!text) return {};

  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    armed.current = false;
    el.current?.classList.remove('copy-armed');
  };
  const copyOnce = () => {
    if (copied.current) return;
    copied.current = true;
    copyWithToast(text);
  };

  return {
    onPointerDown: (e: PointerEvent) => {
      copied.current = false;
      if (e.button !== 0) return;
      clear();
      el.current = e.currentTarget as HTMLElement;
      start.current = { x: e.clientX, y: e.clientY };
      timer.current = setTimeout(() => {
        armed.current = true;
        el.current?.classList.add('copy-armed');
        navigator.vibrate?.(10);
      }, LONG_PRESS_MS);
    },
    onPointerMove: (e: PointerEvent) => {
      const s = start.current;
      if (s && Math.hypot(e.clientX - s.x, e.clientY - s.y) > 10) clear();
    },
    onPointerUp: () => {
      const wasArmed = armed.current;
      clear();
      if (wasArmed) copyOnce();
    },
    onPointerCancel: clear,
    onPointerLeave: clear,
    onContextMenu: (e: MouseEvent) => {
      // Right-click, or a touch long-press on platforms that fire contextmenu.
      e.preventDefault();
      clear();
      copyOnce();
    },
  };
}

/** A label + value row. Blank values show "Not set". `copy` enables long-press copy. */
export function ValueRow(props: { label: string; value: string | null; copy?: boolean; action?: ComponentChildren }): JSX.Element {
  const press = useLongPressCopy(props.copy ? props.value : null);
  return (
    <div class="row kv-row">
      <div class="row-main kv-label">{props.label}</div>
      {props.value
        ? <div class={`row-value kv-value${props.copy ? ' copyable' : ''}`} {...press}>{props.value}</div>
        : <div class="row-value kv-value kv-unset">Not set</div>}
      {props.action}
    </div>
  );
}

/** Today in Chicago for presentation (countdowns); falls back to the bootstrap's day. */
export function presentToday(): string {
  try {
    return todayYmd();
  } catch {
    return bootstrap.value?.today ?? '';
  }
}

/** Owner's display name for "Andrew adds this in the Sheet" copy. */
export function ownerName(): string {
  return bootstrap.value?.ownerName || 'The owner';
}

/** Friendly not-found body for a sheet. */
export function NotFound(props: { text: string }): JSX.Element {
  return <p class="empty">{props.text}</p>;
}
