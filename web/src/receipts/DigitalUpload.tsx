/**
 * Spec 7.6: "Upload a digital receipt". Coaching (with a one-time
 * illustrated Mail → Files tip), the iOS file picker, and a review tray
 * with thumbnails (a PDF's first page via pdf.js), page counts, remove,
 * reorder, "Add more", and an optional "Straighten & clean up" for photos.
 *
 * Every picked image is re-encoded as an upright JPEG here (HEIC included:
 * iOS hands over JPEG because the picker never asks for image/heic, and
 * the decoder copes if it doesn't). The PDF is built at upload time by
 * pdf/combine.ts: a single PDF goes up byte-identical.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import { countPdfPages, formatBytes, MAX_VISIT_BYTES } from '../pdf/combine';
import { normalizeImage, thumbnailUrl } from '../scanner/image';
import { openPdf, renderPage } from '../lib/pdfjs';
import { Icon } from '../ui/Icon';
import { markMailTipSeen, mailTipSeen } from './state';
import { plural } from './common';

export interface DigitalFile {
  id: string;
  name: string;
  kind: 'pdf' | 'image';
  /** PDF bytes as picked, or the normalized JPEG. */
  data: Blob | null;
  /** The picked image before any clean-up (for "Straighten & clean up"). */
  original: Blob | null;
  width: number;
  height: number;
  pages: number | null;
  thumb: string | null;
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  cleaned: boolean;
}

let seq = 0;

async function isPdf(file: File): Promise<boolean> {
  if (file.type === 'application/pdf' || /\.pdf$/i.test(file.name)) return true;
  if (file.type.startsWith('image/')) return false;
  try {
    const head = new Uint8Array(await file.slice(0, 5).arrayBuffer());
    return String.fromCharCode(...head) === '%PDF-';
  } catch {
    return false;
  }
}

async function pdfThumb(blob: Blob): Promise<string | null> {
  try {
    const doc = await openPdf(await blob.arrayBuffer());
    try {
      const canvas = await renderPage(doc, 1, 120);
      try {
        return await thumbnailUrl(canvas, 360);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    } finally {
      void doc.loadingTask.destroy();
    }
  } catch {
    return null;
  }
}

/** Reads one picked file into a tray entry. */
export async function prepareFile(file: File): Promise<DigitalFile> {
  seq++;
  const base: DigitalFile = {
    id: `f${Date.now().toString(36)}${seq}`, name: file.name || 'Photo', kind: 'image', data: null, original: null,
    width: 0, height: 0, pages: null, thumb: null, status: 'loading', error: null, cleaned: false,
  };
  if (await isPdf(file)) {
    try {
      const pages = await countPdfPages(file, base.name);
      const thumb = await pdfThumb(file);
      return { ...base, kind: 'pdf', data: file, pages, thumb, status: 'ready' };
    } catch (e) {
      return { ...base, kind: 'pdf', status: 'error', error: e instanceof Error ? e.message : 'That PDF couldn’t be opened.' };
    }
  }
  try {
    const img = await normalizeImage(file, 2400, 0.85);
    const thumb = await thumbnailUrl(img.jpeg, 360);
    return { ...base, data: img.jpeg, original: file, width: img.width, height: img.height, pages: 1, thumb, status: 'ready' };
  } catch (e) {
    return { ...base, status: 'error', error: e instanceof Error ? e.message : 'That picture couldn’t be opened.' };
  }
}

export function freeFile(f: DigitalFile): void {
  if (f.thumb) URL.revokeObjectURL(f.thumb);
}

export function totals(files: DigitalFile[]): { bytes: number; pages: number } {
  let bytes = 0, pages = 0;
  for (const f of files) {
    if (f.status !== 'ready' || !f.data) continue;
    bytes += f.data.size;
    pages += f.pages ?? 0;
  }
  return { bytes, pages };
}

export interface DigitalUploadProps {
  files: DigitalFile[];
  onAdd: (files: File[]) => void;
  onRemove: (index: number) => void;
  onMove: (index: number, delta: -1 | 1) => void;
  onStraighten: (index: number) => void;
  onNext: () => void;
}

export function DigitalUpload(props: DigitalUploadProps): JSX.Element {
  const [tip, setTip] = useState(() => !mailTipSeen());
  const { files } = props;
  const n = files.length;
  const busy = files.some(f => f.status === 'loading');
  const ready = files.filter(f => f.status === 'ready');
  const { bytes, pages } = totals(files);
  const tooBig = bytes > MAX_VISIT_BYTES;
  const broken = files.some(f => f.status === 'error');

  const onPick = (e: JSX.TargetedEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const picked = Array.from(input.files ?? []);
    input.value = '';
    if (picked.length) props.onAdd(picked);
  };

  const picker = (label: string, primary: boolean) => (
    <label class={`btn btn-block ${primary ? 'btn-primary' : ''} ar-file-btn`}>
      <Icon name={primary ? 'file' : 'plus'} size={20} />
      <span>{label}</span>
      <input type="file" multiple accept="application/pdf,image/*" class="visually-hidden" aria-label={label} onChange={onPick} />
    </label>
  );

  return (
    <div class="ar-body">
      <section class="ar-card">
        <p>
          Got the receipt by email? Save the attachment to your iPhone (in Mail, tap the PDF, then Share, then Save to Files),
          then pick it here. Add every file from this one visit together.
        </p>
      </section>

      {tip && (
        <section class="ar-card ar-tip" aria-labelledby="mail-tip-title">
          <h3 id="mail-tip-title" class="headline">Saving a PDF from Mail</h3>
          <MailTipArt />
          <ol class="ar-tip-steps">
            <li>Open the email in Mail</li>
            <li>Tap the PDF</li>
            <li>Tap Share</li>
            <li>Tap Save to Files</li>
          </ol>
          <button type="button" class="btn btn-small" onClick={() => { markMailTipSeen(); setTip(false); }}>Got it</button>
        </section>
      )}

      {n === 0 ? (
        <div class="ar-actions">{picker('Choose files', true)}</div>
      ) : (
        <>
          <ol class="tray" aria-label="Files to upload">
            {files.map((f, i) => (
              <li key={f.id} class="tray-item">
                {f.thumb
                  ? <img class="tray-thumb" src={f.thumb} alt="" />
                  : <span class="tray-thumb tray-thumb-icon" aria-hidden="true">{f.status === 'loading' ? <span class="spinner" /> : <Icon name="doc" size={28} />}</span>}
                <div class="tray-main">
                  <span class="headline ellipsis tray-name">{f.name}</span>
                  <span class="footnote">
                    {f.status === 'loading' ? 'Getting it ready…'
                      : f.status === 'error' ? <span class="tray-error">{f.error}</span>
                      : `${f.kind === 'pdf' ? 'PDF' : 'Photo'} · ${plural(f.pages ?? 1, 'page', 'pages')}${f.cleaned ? ' · Cleaned up' : ''}`}
                  </span>
                  <div class="tray-buttons">
                    <button type="button" class="icon-btn" aria-label={`Move ${f.name} up`} disabled={i === 0} onClick={() => props.onMove(i, -1)}>
                      <Icon name="up" size={20} />
                    </button>
                    <button type="button" class="icon-btn" aria-label={`Move ${f.name} down`} disabled={i === n - 1} onClick={() => props.onMove(i, 1)}>
                      <Icon name="down" size={20} />
                    </button>
                    <button type="button" class="icon-btn tray-delete" aria-label={`Remove ${f.name}`} onClick={() => props.onRemove(i)}>
                      <Icon name="trash" size={20} />
                    </button>
                  </div>
                  {f.kind === 'image' && f.status === 'ready' && (
                    <button type="button" class="btn btn-small tray-straighten" aria-label={`Straighten & clean up ${f.name}`} onClick={() => props.onStraighten(i)}>
                      Straighten &amp; clean up
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ol>
          <p class={`section-footer ar-pad${tooBig || broken ? ' tray-error' : ''}`} role={tooBig || broken ? 'alert' : undefined}>
            {plural(pages, 'page', 'pages')} · {formatBytes(bytes)}
            {tooBig ? ' — over the 25 MB limit for one visit. Remove a file or two.' : ''}
            {broken && !tooBig ? ' — remove the file that couldn’t be opened to continue.' : ''}
          </p>
          <div class="ar-actions">
            {picker('Add more', false)}
            <button type="button" class="btn btn-primary btn-block" disabled={busy || !ready.length || tooBig || broken} onClick={props.onNext}>
              Next
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Mail → tap the PDF → Share → Save to Files, as four small phone screens. */
function MailTipArt(): JSX.Element {
  const panel = (x: number, content: JSX.Element, label: string) => (
    <g transform={`translate(${x} 0)`}>
      <rect x="2" y="2" width="56" height="92" rx="9" class="tip-phone" />
      {content}
      <text x="30" y="110" text-anchor="middle" class="tip-label">{label}</text>
    </g>
  );
  const arrow = (x: number) => <path d={`M${x} 48h10 m-4-4 4 4-4 4`} class="tip-arrow" />;
  return (
    <svg class="ar-tip-art" viewBox="-6 0 312 116" role="img" aria-label="Mail, then tap the PDF, then Share, then Save to Files">
      {panel(0, <><rect x="12" y="30" width="36" height="26" rx="3" class="tip-ink-fill" /><path d="M12 32l18 14 18-14" class="tip-paper-line" /></>, 'Mail')}
      {arrow(62)}
      {panel(80, <><rect x="16" y="22" width="28" height="36" rx="3" class="tip-red" /><text x="30" y="45" text-anchor="middle" class="tip-pdf">PDF</text><circle cx="38" cy="62" r="7" class="tip-tap" /></>, 'Tap PDF')}
      {arrow(142)}
      {panel(160, <><rect x="19" y="36" width="22" height="22" rx="2" class="tip-stroke" /><path d="M30 26v22 M24 32l6-6 6 6" class="tip-stroke" /></>, 'Share')}
      {arrow(222)}
      {panel(240, <><path d="M12 34h14l4 5h18v21H12z" class="tip-blue" /></>, 'Save to Files')}
    </svg>
  );
}
