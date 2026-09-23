/**
 * Spec 7.1 step 5: every page so far, with reorder, delete (confirmed) and
 * retake, plus "Add page" (the same camera stream) and "Done". 20 pages max.
 */

import type { JSX } from 'preact';
import type { ScannedPage } from '../scanner/pipeline';
import { MAX_SCAN_PAGES } from '../scanner/pipeline';
import { Icon } from '../ui/Icon';
import { StepBar } from './common';

export interface PagesTrayProps {
  title: string;
  pages: ScannedPage[];
  /** "Done" label (e.g. "Done" or "Use these photos"). */
  doneLabel: string;
  onMove: (index: number, delta: -1 | 1) => void;
  onDelete: (index: number) => void;
  onRetake: (index: number) => void;
  onAddPage: () => void;
  onDone: () => void;
  onCancel: () => void;
  cancelLabel: string;
}

export function PagesTray(props: PagesTrayProps): JSX.Element {
  const n = props.pages.length;
  const full = n >= MAX_SCAN_PAGES;
  return (
    <>
      <StepBar title={props.title} left={<button type="button" class="btn btn-plain" onClick={props.onCancel}>{props.cancelLabel}</button>} />
      <div class="ar-body">
        {n === 0 ? (
          <p class="empty">No pages yet.</p>
        ) : (
          <ol class="tray" aria-label={props.title}>
            {props.pages.map((p, i) => (
              <li key={p.id} class="tray-item">
                <img class="tray-thumb" src={p.thumb} alt={`Page ${i + 1}`} />
                <div class="tray-main">
                  <span class="headline">Page {i + 1}</span>
                  <div class="tray-buttons">
                    <button type="button" class="icon-btn" aria-label={`Move page ${i + 1} up`} disabled={i === 0} onClick={() => props.onMove(i, -1)}>
                      <Icon name="up" size={20} />
                    </button>
                    <button type="button" class="icon-btn" aria-label={`Move page ${i + 1} down`} disabled={i === n - 1} onClick={() => props.onMove(i, 1)}>
                      <Icon name="down" size={20} />
                    </button>
                    <button type="button" class="icon-btn" aria-label={`Retake page ${i + 1}`} onClick={() => props.onRetake(i)}>
                      <Icon name="refresh" size={20} />
                    </button>
                    <button type="button" class="icon-btn tray-delete" aria-label={`Delete page ${i + 1}`} onClick={() => props.onDelete(i)}>
                      <Icon name="trash" size={20} />
                    </button>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {full && <p class="section-footer ar-pad">That’s the most for one scan ({MAX_SCAN_PAGES} pages). If there are more, scan the rest as another visit.</p>}
        <div class="ar-actions">
          <button type="button" class="btn btn-block" onClick={props.onAddPage} disabled={full}>
            <Icon name="plus" size={20} /> Add page
          </button>
          <button type="button" class="btn btn-primary btn-block" onClick={props.onDone} disabled={n === 0}>{props.doneLabel}</button>
        </div>
      </div>
    </>
  );
}
