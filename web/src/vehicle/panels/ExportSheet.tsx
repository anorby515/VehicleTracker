/**
 * Export service history (spec 8.11). The PDF is built ahead of the tap
 * (when the sheet opens and whenever the toggle changes) so the Share
 * button can call navigator.share synchronously inside the tap, which iOS
 * requires. The iOS share sheet offers Print, Save to Files, Mail… because
 * window.print() does nothing in a home-screen app. Where sharing files
 * isn't available (desktop), a download link and Print are offered instead.
 */

import type { JSX } from 'preact';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { Vehicle } from '../../api/types';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { SwitchRow } from '../../ui/Switch';
import { toast } from '../../ui/toast';
import { presentToday } from '../common';
import { buildHistory, buildHistoryPdf, type HistoryDoc } from '../exportPdf';
import './ExportSheet.css';

type PdfState = { s: 'building' } | { s: 'ready'; file: File; url: string; pages: number } | { s: 'failed' };

export function ExportSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const [includeBefore, setIncludeBefore] = useState(false);
  const today = presentToday();
  const history = useMemo(() => buildHistory(v, { includeBefore, today }), [v, includeBefore, today]);
  const [pdf, setPdf] = useState<PdfState>({ s: 'building' });
  const hasBefore = v.visits.some(x => x.beforeOwnership);

  // Build the PDF ahead of the tap; rebuild when the toggle changes.
  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    setPdf({ s: 'building' });
    buildHistoryPdf(history).then(
      r => {
        if (cancelled) return;
        const file = new File([r.bytes as BlobPart], history.fileName, { type: 'application/pdf' });
        url = URL.createObjectURL(file);
        setPdf({ s: 'ready', file, url, pages: r.pageCount });
      },
      () => { if (!cancelled) setPdf({ s: 'failed' }); },
    );
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [history]);

  const canShareFiles = pdf.s === 'ready' && typeof navigator.share === 'function' && typeof navigator.canShare === 'function' && safeCanShare(pdf.file);

  // Synchronous inside the tap: iOS needs the user gesture for share().
  const share = () => {
    if (pdf.s !== 'ready') return;
    navigator.share({ files: [pdf.file], title: history.title }).catch((e: unknown) => {
      if (e instanceof DOMException && e.name === 'AbortError') return;
      toast('Couldn’t open the share sheet. Try again.');
    });
  };

  return (
    <Sheet title="Service history" onClose={props.onClose} class="export-sheet">
      <div class="export-controls">
        <section class="section" aria-label="Options">
          <div class="group">
            <SwitchRow
              label="Include history before we owned it"
              detail={hasBefore ? 'CarFax and other records from before the purchase' : 'There are no records from before the purchase'}
              checked={includeBefore}
              disabled={!hasBefore}
              onChange={setIncludeBefore}
            />
          </div>
        </section>
        <div class="vsheet-actions">
          {pdf.s === 'building' && (
            <button type="button" class="btn btn-primary btn-block" disabled>
              <span class="spinner" aria-hidden="true" /> Preparing PDF…
            </button>
          )}
          {pdf.s === 'failed' && <p class="form-message form-error" role="alert">The PDF couldn’t be made on this phone. You can still print this page from a computer.</p>}
          {pdf.s === 'ready' && canShareFiles && (
            <button type="button" class="btn btn-primary btn-block" onClick={share}>
              <Icon name="share" size={20} /> Share or print PDF
            </button>
          )}
          {pdf.s === 'ready' && !canShareFiles && (
            <>
              <a class="btn btn-primary btn-block" href={pdf.url} download={history.fileName}>
                <Icon name="down" size={20} /> Download PDF
              </a>
              <button type="button" class="btn btn-block" onClick={() => window.print()}>Print this page</button>
            </>
          )}
          {pdf.s === 'ready' && (
            <p class="footnote export-status" role="status">
              {pdf.pages} {pdf.pages === 1 ? 'page' : 'pages'} · {history.visits.length} {history.visits.length === 1 ? 'visit' : 'visits'} · no notes included
            </p>
          )}
        </div>
      </div>
      <HistoryPreview doc={history} />
    </Sheet>
  );
}

function safeCanShare(file: File): boolean {
  try {
    return navigator.canShare({ files: [file] });
  } catch {
    return false;
  }
}

/** The same content as the PDF, laid out for the screen and for desktop printing. */
function HistoryPreview(props: { doc: HistoryDoc }): JSX.Element {
  const d = props.doc;
  return (
    <article class="export-preview" aria-label="Preview">
      <header>
        <h3 class="export-title">{d.vehicleName}</h3>
        <p class="export-subtitle">Service history</p>
      </header>
      <dl class="export-details">
        {d.details.map(x => (
          <div key={x.label}><dt>{x.label}</dt><dd>{x.value}</dd></div>
        ))}
      </dl>
      {d.visits.length
        ? (
          <ol class="export-visits">
            {d.visits.map(x => (
              <li key={x.visitId} class="export-visit">
                <div class="ev-head">
                  <strong>{x.date}</strong>
                  <strong class="num">{x.total}</strong>
                </div>
                <div class="ev-sub">
                  {[x.mileage, x.shop, x.beforeOwnership ? 'Before we owned it' : null, x.sourceTag && x.sourceTag !== 'Purchase' ? `From ${x.sourceTag}` : null].filter(Boolean).join(' · ')}
                </div>
                {x.lines.length > 0 && <ul>{x.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>}
              </li>
            ))}
          </ol>
        )
        : <p class="secondary">No visits recorded yet.</p>}
      {d.omittedBefore > 0 && (
        <p class="footnote">{d.omittedBefore} {d.omittedBefore === 1 ? 'visit' : 'visits'} from before we owned it not included.</p>
      )}
      <p class="footnote export-generated">Generated {d.generatedOn}</p>
    </article>
  );
}
