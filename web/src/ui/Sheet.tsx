/**
 * iOS-style page sheet: slides up, grabber, title bar with Close/Done, its own
 * scroll area. Accessible as a modal dialog (focus moves in, Escape closes,
 * background marked inert).
 */

import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { createPortal } from 'preact/compat';

/** Open sheets (sheets can stack); the app behind is hidden from VoiceOver while any is open. */
let openCount = 0;
/** Stack of open sheets' ids, so Escape closes only the top one. */
const stack: number[] = [];
let nextId = 0;

export interface SheetProps {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
  /** Left bar button (defaults to none). */
  left?: ComponentChildren;
  /** Right bar button (defaults to a "Done" button that closes). */
  right?: ComponentChildren | false;
  /** Size to content instead of near-full height. */
  auto?: boolean;
  /** Hide the visible title (still used as the accessible name). */
  hideTitle?: boolean;
  class?: string;
}

export function Sheet(props: SheetProps): JSX.Element {
  // A module counter, not useId: useId restarts inside each portal, so stacked
  // sheets would share a title id and VoiceOver would read the wrong name.
  const [uid] = useState(() => ++nextId);
  const titleId = `sheet-title-${uid}`;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const app = document.getElementById('app');
    openCount++;
    stack.push(uid);
    app?.setAttribute('aria-hidden', 'true');
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && stack[stack.length - 1] === uid) props.onClose(); };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      openCount--;
      const i = stack.lastIndexOf(uid);
      if (i !== -1) stack.splice(i, 1);
      if (openCount <= 0) { openCount = 0; app?.removeAttribute('aria-hidden'); }
      prev?.focus?.();
    };
  }, []);

  const right = props.right === undefined
    ? <button class="btn btn-plain" onClick={props.onClose}>Done</button>
    : props.right;

  return (
    <SheetPortal>
      <div class="sheet-backdrop" onClick={props.onClose} />
      <div
        ref={ref}
        class={`sheet${props.auto ? ' sheet-auto' : ''}${props.class ? ' ' + props.class : ''}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div class="sheet-grabber" aria-hidden="true" />
        <div class="sheet-bar">
          <div class="sheet-left">{props.left}</div>
          <h2 id={titleId} class={`sheet-title${props.hideTitle ? ' visually-hidden' : ''}`}>{props.title}</h2>
          <div class="sheet-right">{right}</div>
        </div>
        <div class="sheet-body">{props.children}</div>
      </div>
    </SheetPortal>
  );
}

function SheetPortal(props: { children: ComponentChildren }): JSX.Element {
  return createPortal(<>{props.children}</>, document.body) as unknown as JSX.Element;
}
