import { signal } from '@preact/signals';
import type { JSX } from 'preact';
import { createPortal } from 'preact/compat';

const message = signal<string | null>(null);
let timer: ReturnType<typeof setTimeout> | undefined;

/** Brief, non-blocking confirmation ("Copied", "Saved"). */
export function toast(text: string, ms = 2200): void {
  message.value = text;
  clearTimeout(timer);
  timer = setTimeout(() => { message.value = null; }, ms);
}

/**
 * Rendered once at the app root. Portalled to <body> so VoiceOver still hears
 * it while a sheet is open (sheets hide #app from assistive tech).
 */
export function ToastHost(): JSX.Element | null {
  if (!message.value) return null;
  return createPortal(
    <div class="toast" role="status" aria-live="polite">{message.value}</div>,
    document.body,
  ) as unknown as JSX.Element;
}
