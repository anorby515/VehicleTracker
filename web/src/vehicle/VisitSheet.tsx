/**
 * Visit detail (spec 6.3): date, mileage, shop, repair order, totals; the
 * services with line costs; recommendations and inspection readings from
 * that visit; its documents (PDFs first) opening in the stacked document
 * viewer; Notes only inside a collapsed "Details".
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { DocumentRef, Vehicle, Visit } from '../api/types';
import { formatDate, formatMiles, formatMoney, formatNumber } from '../lib/format';
import { Tag } from '../ui/Badge';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { DocumentViewerSheet } from './DocumentViewer';
import { formatWearValue, recommendationStatusText, sortDocuments } from './display';

export function VisitSheet(props: { vehicle: Vehicle; visit: Visit; onClose: () => void }): JSX.Element {
  const { vehicle: v, visit: x } = props;
  const [doc, setDoc] = useState<DocumentRef | null>(null);
  const title = formatDate(x.date, 'Visit');
  const documents = sortDocuments(x.documents);

  // The viewer is a sibling of this sheet, not inside it: ids made by useId
  // inside a portal restart at "P0-0", so a sheet nested in another sheet's
  // portal would share its title id (and VoiceOver would read the wrong name).
  return (
    <>
      <Sheet title={title} onClose={props.onClose} class="visit-sheet">
        <div class="vsheet-hero">
          <h3 class="title2">{x.location || 'Shop not recorded'}</h3>
          <p class="secondary">{v.name}</p>
          {x.summary && <p class="visit-summary-full">{x.summary}</p>}
          {(x.sourceTag || x.beforeOwnership) && (
            <div class="badges">
              {x.sourceTag && <Tag>{x.sourceTag}</Tag>}
              {x.beforeOwnership && <Tag>Before we owned it</Tag>}
            </div>
          )}
        </div>

        <section class="section" aria-label="Visit">
          <div class="group">
            <Row label="Date" value={formatDate(x.date, 'Not recorded')} />
            <Row label="Mileage" value={formatMiles(x.mileage, 'Not recorded')} />
            <Row label="Shop" value={x.location || 'Not recorded'} />
            {x.roNumber && <Row label="Repair order" value={x.roNumber} />}
            <Row label="Total" value={formatMoney(x.invoiceTotal, 'No total recorded')} />
            {x.amountPaid !== null && (
              <Row
                label="Amount paid"
                value={x.cardSurcharge ? `${formatMoney(x.amountPaid)} (includes ${formatMoney(x.cardSurcharge)} card surcharge)` : formatMoney(x.amountPaid)}
              />
            )}
            {x.amountPaid === null && x.cardSurcharge ? <Row label="Card surcharge" value={formatMoney(x.cardSurcharge)} /> : null}
            {(x.dealerNextDueDate || x.dealerNextDueMiles !== null) && (
              <Row
                label="Shop’s next service"
                value={[x.dealerNextDueDate ? formatDate(x.dealerNextDueDate) : null, x.dealerNextDueMiles !== null ? formatMiles(x.dealerNextDueMiles) : null].filter(Boolean).join(' or ')}
              />
            )}
          </div>
        </section>

        <section class="section" aria-labelledby="visit-services">
          <div class="section-header"><h3 id="visit-services">Services</h3></div>
          <div class="group">
            {x.services.length
              ? x.services.map((s, i) => (
                <div class="row" key={i}>
                  <div class="row-main stack">
                    <span class="row-title">{s.serviceType || s.description || 'Service'}</span>
                    {s.description && s.description !== s.serviceType && <span class="row-sub">{s.description}</span>}
                    {s.notes && <span class="row-sub footnote">{s.notes}</span>}
                  </div>
                  <div class="row-value num">{formatMoney(s.lineCost)}</div>
                </div>
              ))
              : <p class="row secondary">No services listed for this visit.</p>}
          </div>
        </section>

        {x.recommendations.length > 0 && (
          <section class="section" aria-labelledby="visit-recs">
            <div class="section-header"><h3 id="visit-recs">Recommended at this visit</h3></div>
            <div class="group">
              {x.recommendations.map(r => (
                <div class="row" key={r.recId}>
                  <div class="row-main stack">
                    <span class="row-title">{r.item || 'Recommendation'}</span>
                    <span class="row-sub">
                      {recommendationStatusText(r.status)}
                      {r.estimate !== null ? ` · estimate ${formatMoney(r.estimate)}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {x.readings.length > 0 && (
          <section class="section" aria-labelledby="visit-readings">
            <div class="section-header"><h3 id="visit-readings">Inspection readings</h3></div>
            <div class="group">
              {x.readings.map((r, i) => (
                <div class="row" key={i}>
                  <div class="row-main">{r.item || 'Reading'}</div>
                  <div class="row-value num">
                    {formatWearValue(r.value, r.unit)}
                    {r.rating && <span class="reading-rating"> · {r.rating}</span>}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        <section class="section" aria-labelledby="visit-docs">
          <div class="section-header"><h3 id="visit-docs">Documents</h3></div>
          <div class="group">
            {documents.length
              ? documents.map(d => (
                <button type="button" class="row tappable doc-row" key={d.fileId} onClick={() => setDoc(d)}>
                  <span class="doc-icon" aria-hidden="true"><Icon name={d.kind === 'image' ? 'photo' : 'doc'} /></span>
                  <span class="row-main">
                    <span class="row-title">{docTitle(d)}</span>
                    <span class="row-sub">
                      {d.kind === 'pdf' ? 'PDF' : d.kind === 'image' ? 'Image' : 'File'}
                      {d.pages ? ` · ${formatNumber(d.pages)} ${d.pages === 1 ? 'page' : 'pages'}` : ''}
                    </span>
                    {d.complete === false && <span class="badge badge-missing">Pages missing</span>}
                  </span>
                  <Icon name="chevronRight" class="row-chevron" size={18} />
                </button>
              ))
              : <p class="row secondary">No documents filed for this visit.</p>}
          </div>
        </section>

        {x.notes && (
          <details class="vdetails">
            <summary><Icon name="chevronDown" size={18} />Details</summary>
            <div class="vdetails-body">{x.notes}</div>
          </details>
        )}

      </Sheet>
      {doc && <DocumentViewerSheet fileId={doc.fileId} title={docTitle(doc)} onClose={() => setDoc(null)} />}
    </>
  );
}

function docTitle(d: DocumentRef): string {
  return d.documentType || d.fileName || 'Document';
}

function Row(props: { label: string; value: string }): JSX.Element {
  return (
    <div class="row kv-row">
      <div class="row-main kv-label">{props.label}</div>
      <div class="row-value kv-value num">{props.value}</div>
    </div>
  );
}
