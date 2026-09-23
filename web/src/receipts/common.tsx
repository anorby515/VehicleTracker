/**
 * Building blocks for the Add Receipt overlay: the full-screen container
 * (portalled to <body>, modal for VoiceOver), the title bar, and an in-app
 * confirmation dialog.
 */

import type { ComponentChildren, JSX } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useRef } from 'preact/hooks';
import type { ScanKind } from '../api/types';

export function Overlay(props: { label: string; dark?: boolean; children: ComponentChildren; onEscape?: () => void }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const app = document.getElementById('app');
    const prev = document.activeElement as HTMLElement | null;
    app?.setAttribute('aria-hidden', 'true');
    app?.setAttribute('inert', '');
    ref.current?.focus();
    return () => {
      app?.removeAttribute('aria-hidden');
      app?.removeAttribute('inert');
      prev?.focus?.();
    };
  }, []);
  useEffect(() => {
    if (!props.onEscape) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') props.onEscape?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [props.onEscape]);
  return createPortal(
    <div ref={ref} class={`ar-overlay${props.dark ? ' ar-dark' : ''}`} role="dialog" aria-modal="true" aria-label={props.label} tabIndex={-1}>
      {props.children}
    </div>,
    document.body,
  ) as unknown as JSX.Element;
}

export function StepBar(props: { title: string; left?: ComponentChildren; right?: ComponentChildren }): JSX.Element {
  return (
    <div class="ar-bar">
      <div class="ar-bar-left">{props.left}</div>
      <h2 class="ar-bar-title">{props.title}</h2>
      <div class="ar-bar-right">{props.right}</div>
    </div>
  );
}

export interface ConfirmRequest {
  title: string;
  message?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
}

export function ConfirmDialog(props: { req: ConfirmRequest; onCancel: () => void }): JSX.Element {
  const titleId = useId();
  const msgId = useId();
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { cancelRef.current?.focus(); }, []);
  const { req } = props;
  return (
    <div class="ar-confirm-backdrop" onClick={props.onCancel}>
      <div
        class="ar-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={req.message ? msgId : undefined}
        onClick={e => e.stopPropagation()}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); props.onCancel(); } }}
      >
        <h3 id={titleId} class="headline ar-confirm-title">{req.title}</h3>
        {req.message && <p id={msgId} class="subhead ar-confirm-msg">{req.message}</p>}
        <div class="ar-confirm-actions">
          <button ref={cancelRef} type="button" class="btn" onClick={props.onCancel}>{req.cancelLabel ?? 'Cancel'}</button>
          <button
            type="button"
            class={`btn ${req.danger ? 'btn-danger' : 'btn-primary'}`}
            onClick={() => { props.onCancel(); req.onConfirm(); }}
          >
            {req.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** "Receipt scan", "Digital receipt", "Owner entry". */
export function kindLabel(kind: ScanKind): string {
  return kind === 'Receipt' ? 'Receipt scan' : kind === 'Upload' ? 'Digital receipt' : 'Owner entry';
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}
