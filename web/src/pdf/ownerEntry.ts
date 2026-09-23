/**
 * "Work I did myself" (spec 8.5): a Letter-size record that Cowork can read
 * like any receipt, followed by one page per optional photo (parts receipt,
 * packaging).
 *
 * `ownerEntryLines` is the pure part (what gets printed, in order), so tests
 * can check the wording without parsing a PDF.
 */

import { PDFDocument, type PDFFont, StandardFonts, rgb } from 'pdf-lib';
import { type PageImage, addImagePage, setMeta } from './assemble';
import { toWinAnsi } from './winansi';
import { formatDate, formatDateTime, formatMiles, formatMoney } from '../lib/format';

export const OWNER_TITLE = 'Owner-performed maintenance record';
export const NO_SHOP_LINE = 'No shop receipt: owner-performed work';

export interface OwnerEntryInput {
  /** Vehicles › Vehicle exactly as on the Vehicles tab. */
  vehicleName: string;
  vin: string | null;
  plate: string | null;
  /** YYYY-MM-DD. */
  date: string;
  dateApprox: boolean;
  mileage: number | null;
  mileageApprox: boolean;
  /** Chosen Service Types. */
  services: string[];
  /** Free text ("Replaced both front wiper blades"). */
  otherWork: string;
  partsCost: number | null;
  notes: string;
  /** App Users › Name of the person entering it. */
  who: string;
  enteredAt: Date;
  photoCount: number;
}

export interface OwnerEntryLine { label: string; value: string }

export interface OwnerEntryText {
  title: string;
  subtitle: string;
  rows: OwnerEntryLine[];
}

export function ownerEntryLines(e: OwnerEntryInput): OwnerEntryText {
  const approx = (on: boolean) => (on ? ' (approximate)' : '');
  const work: string[] = [];
  if (e.services.length) work.push(e.services.join(', '));
  if (e.otherWork.trim()) work.push(e.otherWork.trim());
  const rows: OwnerEntryLine[] = [
    { label: 'Vehicle', value: e.vehicleName },
    { label: 'VIN', value: e.vin || 'Not set' },
    { label: 'Plate', value: e.plate || 'Not set' },
    { label: 'Date', value: `${formatDate(e.date, e.date)} (${e.date})${approx(e.dateApprox)}` },
    { label: 'Date is approximate', value: e.dateApprox ? 'Yes' : 'No' },
    { label: 'Mileage', value: e.mileage === null ? 'Not recorded' : `${formatMiles(e.mileage)}${approx(e.mileageApprox)}` },
    { label: 'Mileage is approximate', value: e.mileage === null ? 'Not recorded' : e.mileageApprox ? 'Yes' : 'No' },
    { label: 'Services', value: e.services.length ? e.services.join(', ') : 'None picked' },
    { label: 'Work done', value: work.join('. ') || 'Not described' },
    { label: 'Parts cost', value: e.partsCost === null ? 'Not recorded' : formatMoney(e.partsCost) },
    { label: 'Notes', value: e.notes.trim() || 'None' },
    { label: 'Done by', value: e.who },
    { label: 'Receipt', value: NO_SHOP_LINE },
    { label: 'Entered', value: `${formatDateTime(e.enteredAt.toISOString())} (Central), in the Vehicles app` },
  ];
  if (e.photoCount) rows.push({ label: 'Photos', value: `${e.photoCount} attached on the following page${e.photoCount === 1 ? '' : 's'}` });
  return { title: OWNER_TITLE, subtitle: NO_SHOP_LINE, rows };
}

const PAGE: [number, number] = [612, 792];
const MARGIN = 54;
const LABEL_W = 150;
const SIZE = 11;
const LEADING = 15;

/** Word-wraps to a width, breaking over-long words. */
export function wrapText(text: string, font: PDFFont, size: number, maxWidth: number): string[] {
  const out: string[] = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) { line = candidate; continue; }
      if (line) out.push(line);
      // Break a single long word (a VIN pasted twice, a URL…).
      let rest = word;
      while (font.widthOfTextAtSize(rest, size) > maxWidth) {
        let n = rest.length - 1;
        while (n > 1 && font.widthOfTextAtSize(rest.slice(0, n), size) > maxWidth) n--;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out;
}

export async function buildOwnerEntryPdf(e: OwnerEntryInput, photos: PageImage[] = []): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  setMeta(doc, {
    title: `${OWNER_TITLE} - ${e.vehicleName} - ${e.date}`,
    author: e.who,
    subject: NO_SHOP_LINE,
    createdAt: e.enteredAt,
  });
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const text = ownerEntryLines({ ...e, photoCount: photos.length });
  const ink = rgb(0, 0, 0);
  const grey = rgb(0.35, 0.35, 0.35);

  let page = doc.addPage(PAGE);
  let y = PAGE[1] - MARGIN;
  const newPage = () => {
    page = doc.addPage(PAGE);
    y = PAGE[1] - MARGIN;
    page.drawText(toWinAnsi(`${OWNER_TITLE} (continued)`), { x: MARGIN, y: y - 12, size: 12, font: bold, color: grey });
    y -= 34;
  };
  const ensure = (h: number) => { if (y - h < MARGIN) newPage(); };

  // Title block.
  for (const line of wrapText(toWinAnsi(text.title), bold, 20, PAGE[0] - 2 * MARGIN)) {
    page.drawText(line, { x: MARGIN, y: y - 20, size: 20, font: bold, color: ink });
    y -= 26;
  }
  page.drawText(toWinAnsi(text.subtitle), { x: MARGIN, y: y - 14, size: 13, font: bold, color: ink });
  y -= 26;
  page.drawLine({ start: { x: MARGIN, y }, end: { x: PAGE[0] - MARGIN, y }, thickness: 0.75, color: grey });
  y -= 14;

  const valueW = PAGE[0] - 2 * MARGIN - LABEL_W;
  for (const row of text.rows) {
    const lines = wrapText(toWinAnsi(row.value), regular, SIZE, valueW);
    ensure(LEADING);
    page.drawText(toWinAnsi(`${row.label}:`), { x: MARGIN, y: y - SIZE, size: SIZE, font: bold, color: ink });
    for (let i = 0; i < lines.length; i++) {
      if (i > 0) ensure(LEADING);
      page.drawText(lines[i], { x: MARGIN + LABEL_W, y: y - SIZE, size: SIZE, font: regular, color: ink });
      y -= LEADING;
    }
    y -= 5;
  }

  for (const p of photos) await addImagePage(doc, p);
  return doc.save();
}
