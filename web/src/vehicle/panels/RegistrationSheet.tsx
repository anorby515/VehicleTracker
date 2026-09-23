/**
 * Registration (spec 8.8): expiry date and days left, and the scanned
 * registration in the document viewer. The owner fills both Sheet columns
 * by hand; the app never writes them.
 */

import type { JSX } from 'preact';
import { useState } from 'preact/hooks';
import type { UpcomingStatus, Vehicle } from '../../api/types';
import { formatDate } from '../../lib/format';
import { StatusBadge } from '../../ui/Badge';
import { Icon } from '../../ui/Icon';
import { Sheet } from '../../ui/Sheet';
import { ValueRow, ownerName } from '../common';
import { DocumentViewerSheet } from '../DocumentViewer';
import { registrationDaysText } from '../display';

export function registrationStatus(daysLeft: number | null): UpcomingStatus | null {
  if (daysLeft === null) return null;
  if (daysLeft < 0) return 'Overdue';
  if (daysLeft <= 30) return 'Due soon';
  return 'OK';
}

export function RegistrationSheet(props: { vehicle: Vehicle; onClose: () => void }): JSX.Element {
  const v = props.vehicle;
  const reg = v.registration;
  const [open, setOpen] = useState(false);
  const status = registrationStatus(reg.daysLeft);
  // The viewer is a sibling, not inside this sheet's portal (see VisitSheet).
  return (
    <>
      <Sheet title="Registration" onClose={props.onClose} class="registration-sheet">
        <div class="vsheet-hero">
          <h3 class="title2">{v.name}</h3>
          {status && <div class="badges"><StatusBadge status={status} /></div>}
        </div>
        <section class="section" aria-label="Registration">
          <div class="group">
            <ValueRow label="Expires" value={reg.expires ? formatDate(reg.expires) : null} />
            {reg.expires && <ValueRow label="Time left" value={registrationDaysText(reg)} />}
            <ValueRow label="Plate" value={v.plate} />
          </div>
          {!reg.expires && <p class="section-footer">Not set yet. {ownerName()} adds this in the Sheet.</p>}
        </section>
        <div class="vsheet-actions">
          {reg.fileId
            ? (
              <button type="button" class="btn btn-block" onClick={() => setOpen(true)}>
                <Icon name="doc" size={20} /> Open the scanned registration
              </button>
            )
            : <p class="footnote">No scanned registration on file. {ownerName()} adds it in the Sheet.</p>}
        </div>
      </Sheet>
      {open && reg.fileId && <DocumentViewerSheet fileId={reg.fileId} title="Scanned registration" onClose={() => setOpen(false)} />}
    </>
  );
}
