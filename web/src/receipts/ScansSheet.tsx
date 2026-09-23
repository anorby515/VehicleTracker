/**
 * "My scans" (spec 8.1): #/scans lists the last 30 days — scans still on this
 * phone first (waiting, uploading, couldn't upload), then what the App API
 * knows (bootstrap.myScans plus this session's uploads). #/scans/<id> shows
 * one scan: its status in words, the car it was hinted for and where it was
 * filed, and links to the visit and the PDF.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { Scan, ScanStatus } from '../api/types';
import { formatDateTime, formatNumber } from '../lib/format';
import { back, go, href } from '../state/router';
import { online, vehicles } from '../state/store';
import { type UploadItem, deleteUpload, myScans, retryUpload, uploadItems } from '../uploads/queue';
import { Icon } from '../ui/Icon';
import { Sheet } from '../ui/Sheet';
import { DocumentViewerSheet } from '../vehicle/DocumentViewer';
import { ConfirmDialog, type ConfirmRequest, kindLabel, plural } from './common';
import './ScansSheet.css';

const STATUS_CLASS: Record<ScanStatus, string> = {
  'Waiting': 'badge-ok',
  'Filed': 'badge-covered',
  'Adding to journal': 'badge-covered',
  'Needs attention': 'badge-overdue',
  'Check with owner': 'badge-soon',
};

function shortName(vehicle: string | null): string {
  if (!vehicle) return '';
  return vehicles.value.find(v => v.name === vehicle)?.shortName ?? vehicle;
}

/** The chip for an item still on the phone. */
export function localStatus(item: UploadItem, isOnline: boolean): { label: string; cls: string } {
  switch (item.phase) {
    case 'uploading': return { label: `Uploading ${Math.round(item.progress * 100)}%`, cls: 'badge-ok' };
    case 'failed': return { label: 'Couldn’t upload', cls: 'badge-overdue' };
    case 'paused': return { label: 'Waiting for sign-in', cls: 'badge-soon' };
    case 'retrying': return isOnline ? { label: 'Couldn’t upload — will retry', cls: 'badge-soon' } : { label: 'Waiting to upload', cls: 'badge-soon' };
    default: return { label: 'Waiting to upload', cls: 'badge-soon' };
  }
}

export function ScansSheet(props: { scanId?: string }): JSX.Element {
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);
  const [viewing, setViewing] = useState<Scan | null>(null);
  const local = uploadItems.value;
  const scans = myScans.value;
  const isOnline = online.value;
  const localIds = new Set(local.map(i => i.scanId));
  const server = scans.filter(s => !localIds.has(s.scanId));

  const askDelete = (item: UploadItem) => setConfirm({
    title: 'Delete this scan?',
    message: 'It will be removed from this phone and won’t be uploaded.',
    confirmLabel: 'Delete',
    danger: true,
    onConfirm: () => { void deleteUpload(item.scanId); if (props.scanId) back(href.scans()); },
  });

  let content: JSX.Element;
  let title = 'My scans';
  let left: JSX.Element | undefined;

  if (props.scanId) {
    const item = local.find(i => i.scanId === props.scanId);
    const scan = scans.find(s => s.scanId === props.scanId);
    left = <button type="button" class="btn btn-plain" onClick={() => back(href.scans())}><Icon name="chevronLeft" size={20} />Back</button>;
    title = item ? kindLabel(item.kind) : scan ? kindLabel(scan.kind) : 'Scan';
    content = item
      ? <LocalDetail item={item} isOnline={isOnline} onDelete={() => askDelete(item)} />
      : scan
        ? <ScanDetail scan={scan} onView={() => setViewing(scan)} />
        : <p class="empty">This scan isn’t in the last 30 days, or it hasn’t reached the list yet. Pull down on the main screen to refresh.</p>;
  } else {
    content = (
      <>
        {local.length > 0 && (
          <section class="section" aria-labelledby="scans-local">
            <div class="section-header"><h3 id="scans-local">On this phone</h3></div>
            <div class="group">
              {local.map(i => {
                const st = localStatus(i, isOnline);
                return (
                  <a key={i.scanId} class="row tappable scans-row" href={href.scan(i.scanId)} onClick={e => { e.preventDefault(); go(href.scan(i.scanId)); }}>
                    <span class="row-main">
                      <span class="row-title">{kindLabel(i.kind)} · {shortName(i.vehicleHint)}</span>
                      <span class="row-sub">{formatDateTime(new Date(i.createdAt).toISOString())} · {plural(i.pages, 'page', 'pages')}</span>
                    </span>
                    <span class={`badge ${st.cls}`}>{st.label}</span>
                  </a>
                );
              })}
            </div>
            <p class="section-footer">
              {isOnline ? 'These upload automatically.' : 'You’re offline. These upload automatically when you’re back online.'}
            </p>
          </section>
        )}
        <section class="section" aria-labelledby="scans-server">
          <div class="section-header"><h3 id="scans-server">Last 30 days</h3></div>
          {server.length ? (
            <div class="group">
              {server.map(s => (
                <a key={s.scanId} class="row tappable scans-row" href={href.scan(s.scanId)} onClick={e => { e.preventDefault(); go(href.scan(s.scanId)); }}>
                  <span class="row-main">
                    <span class="row-title">{kindLabel(s.kind)} · {shortName(s.filedVehicle ?? s.vehicleHint)}</span>
                    <span class="row-sub">
                      {s.uploadedAt ? formatDateTime(s.uploadedAt) : 'Uploaded'}{s.pages ? ` · ${plural(s.pages, 'page', 'pages')}` : ''}
                    </span>
                  </span>
                  <span class={`badge ${STATUS_CLASS[s.status] ?? 'badge-ok'}`}>{s.statusLabel}</span>
                </a>
              ))}
            </div>
          ) : (
            <p class="empty scans-empty">No scans in the last 30 days.</p>
          )}
          <p class="section-footer">Scans made with the Google Drive app don’t show here, but they’re still filed.</p>
        </section>
      </>
    );
  }

  return (
    <>
      <Sheet title={title} left={left} right={props.scanId ? false : undefined} onClose={() => back(href.home())} class="scans-sheet">
        {content}
        {confirm && <ConfirmDialog req={confirm} onCancel={() => setConfirm(null)} />}
      </Sheet>
      {viewing?.fileId && (
        <DocumentViewerSheet fileId={viewing.fileId} title={viewing.fileName ?? kindLabel(viewing.kind)} onClose={() => setViewing(null)} />
      )}
    </>
  );
}

function Fact(props: { label: string; value: string | null | undefined }): JSX.Element | null {
  if (!props.value) return null;
  return (
    <div class="row scans-fact">
      <span class="row-main">{props.label}</span>
      <span class="row-value">{props.value}</span>
    </div>
  );
}

function ScanDetail(props: { scan: Scan; onView: () => void }): JSX.Element {
  const s = props.scan;
  const filedOn = s.filedVehicle ?? null;
  const visitVehicle = s.filedVehicle ?? s.vehicleHint;
  return (
    <>
      <section class="section scans-status">
        <span class={`badge scans-badge ${STATUS_CLASS[s.status] ?? 'badge-ok'}`}>{s.statusLabel}</span>
        {s.statusDetail && <p class="scans-detail">{s.statusDetail}</p>}
      </section>
      <section class="section">
        <div class="group">
          <Fact label="Car you picked" value={s.vehicleHint} />
          <Fact label="Filed under" value={filedOn} />
          <Fact label="Pages" value={s.pages ? formatNumber(s.pages) : null} />
          <Fact label="Uploaded" value={s.uploadedAt ? formatDateTime(s.uploadedAt) : null} />
          <Fact label="Last checked" value={s.lastChecked ? formatDateTime(s.lastChecked) : null} />
        </div>
        {filedOn && s.vehicleHint && filedOn !== s.vehicleHint && (
          <p class="section-footer">It was filed under a different car than the one picked. The receipt decides where it goes.</p>
        )}
        {s.fileName && <p class="section-footer scans-filename">{s.fileName}</p>}
      </section>
      <section class="section">
        <div class="group">
          {s.status === 'Filed' && s.visitId && visitVehicle && (
            <a class="row tappable" href={href.visit(visitVehicle, s.visitId)}>
              <Icon name="wrench" size={20} />
              <span class="row-main row-title">Open the visit</span>
              <Icon name="chevronRight" size={18} class="row-chevron" />
            </a>
          )}
          {s.fileId && (
            <button type="button" class="row tappable" onClick={props.onView}>
              <Icon name="doc" size={20} />
              <span class="row-main row-title scans-link">View PDF</span>
              <Icon name="chevronRight" size={18} class="row-chevron" />
            </button>
          )}
        </div>
      </section>
    </>
  );
}

function LocalDetail(props: { item: UploadItem; isOnline: boolean; onDelete: () => void }): JSX.Element {
  const i = props.item;
  const st = localStatus(i, props.isOnline);
  const explain = i.phase === 'failed'
    ? i.error
    : i.phase === 'paused'
      ? 'It will upload after you sign in again.'
      : props.isOnline
        ? i.phase === 'retrying' ? 'The last try didn’t work. It will try again by itself.' : 'It’s uploading now.'
        : 'It’s saved on this phone and will upload by itself when you’re back online.';
  return (
    <>
      <section class="section scans-status">
        <span class={`badge scans-badge ${st.cls}`}>{st.label}</span>
        {explain && <p class="scans-detail">{explain}</p>}
        {i.volatile && <p class="scans-detail">This phone couldn’t store it, so keep the app open until it uploads.</p>}
      </section>
      <section class="section">
        <div class="group">
          <Fact label="Car you picked" value={i.vehicleHint} />
          <Fact label="Pages" value={formatNumber(i.pages)} />
          <Fact label="Saved" value={formatDateTime(new Date(i.createdAt).toISOString())} />
          <Fact label="Size" value={`${Math.max(1, Math.round(i.size / 1024)).toLocaleString('en-US')} KB`} />
        </div>
      </section>
      {i.phase === 'failed' && (
        <section class="section">
          <div class="group">
            <button type="button" class="row tappable" onClick={() => void retryUpload(i.scanId)}>
              <Icon name="refresh" size={20} />
              <span class="row-main row-title scans-link">Try again</span>
            </button>
            <button type="button" class="row tappable scans-danger" onClick={props.onDelete}>
              <Icon name="trash" size={20} />
              <span class="row-main row-title">Delete from this phone</span>
            </button>
          </div>
        </section>
      )}
    </>
  );
}
