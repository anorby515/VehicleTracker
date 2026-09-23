/**
 * Service history export (spec 8.11). window.print() does nothing in an
 * iPhone home-screen app, so the history is built as a real PDF on the phone
 * with pdf-lib (loaded only when the Export sheet opens) and handed to the
 * share sheet, which offers Print, Save to Files, Mail and so on.
 *
 * buildHistory() is shared with the on-screen preview so the two always
 * match. The Notes column is never included.
 */

import type { Vehicle, YMD } from '../api/types';
import { formatDate, formatMiles, formatMoney } from '../lib/format';

// ---------------------------------------------------------------- content

export interface HistoryVisit {
  visitId: string;
  date: string;
  mileage: string;
  shop: string;
  /** One line per service (as printed), or the visit summary when no services were recorded. */
  lines: string[];
  total: string;
  beforeOwnership: boolean;
  sourceTag: string | null;
}

export interface HistoryDoc {
  vehicleName: string;
  title: string;
  details: { label: string; value: string }[];
  visits: HistoryVisit[];
  includeBefore: boolean;
  /** Visits left out because they're from before the purchase (toggle off). */
  omittedBefore: number;
  generatedOn: string;
  fileName: string;
}

/** The export's content for a vehicle. Visits newest first, like the journal. */
export function buildHistory(v: Vehicle, opts: { includeBefore: boolean; today: YMD }): HistoryDoc {
  const all = v.visits;
  const visits = opts.includeBefore ? all : all.filter(x => !x.beforeOwnership);
  const ymm = [v.year, v.make, v.model].filter(Boolean).join(' ');
  const details: { label: string; value: string }[] = [];
  if (ymm && ymm !== v.name) details.push({ label: 'Vehicle', value: ymm });
  details.push({ label: 'VIN', value: v.vin || 'Not set' });
  details.push({ label: 'Plate', value: v.plate || 'No plate on file' });
  if (v.originalInServiceDate) details.push({ label: 'First in service', value: formatDate(v.originalInServiceDate) });
  details.push({ label: 'Purchased', value: formatDate(v.purchaseDate, 'Not set') });
  details.push({ label: 'Mileage at purchase', value: formatMiles(v.purchaseMileage, 'Not set') });
  if (v.latestOdometer !== null) {
    details.push({
      label: 'Latest odometer',
      value: v.latestOdometerDate ? `${formatMiles(v.latestOdometer)} on ${formatDate(v.latestOdometerDate)}` : formatMiles(v.latestOdometer),
    });
  }
  details.push({
    label: 'Visits listed',
    value: `${visits.length}${opts.includeBefore ? ' (including history before we owned it)' : ' (since we bought it)'}`,
  });

  return {
    vehicleName: v.name,
    title: `${v.name} service history`,
    details,
    visits: visits.map(x => {
      const lines = serviceLines(x.services);
      if (!lines.length && x.summary) lines.push(x.summary);
      return {
        visitId: x.visitId,
        date: formatDate(x.date, 'Date not recorded'),
        mileage: formatMiles(x.mileage, 'Mileage not recorded'),
        shop: x.location || 'Shop not recorded',
        lines,
        total: formatMoney(x.invoiceTotal),
        beforeOwnership: x.beforeOwnership,
        sourceTag: x.sourceTag,
      };
    }),
    includeBefore: opts.includeBefore,
    omittedBefore: opts.includeBefore ? 0 : all.length - visits.length,
    generatedOn: formatDate(opts.today),
    fileName: `${safeFileName(v.name)} service history.pdf`,
  };
}

const norm = (t: string) => t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * One line per service, as printed on the receipt. When a receipt repeats a
 * combined line for a second service ("OIL CHANGE AND TIRE ROTATE" for both
 * the oil change and the rotation), the repeat shows its Service Type instead.
 */
export function serviceLines(services: { serviceType: string | null; description: string | null }[]): string[] {
  const out: string[] = [];
  for (const s of services) {
    const desc = (s.description || '').trim();
    const type = (s.serviceType || '').trim();
    let line = desc || type;
    if (desc && out.some(l => norm(l).includes(norm(desc)))) line = type;
    if (line && !out.some(l => norm(l) === norm(line))) out.push(line);
  }
  return out;
}

/** Removes characters iOS/Files don't like in a file name. */
export function safeFileName(s: string): string {
  return s.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, ' ').replace(/\s+/g, ' ').trim() || 'Vehicle';
}

// ---------------------------------------------------------------- text for the standard fonts

/** Code points WinAnsiEncoding adds in 0x80–0x9F (Helvetica can draw these). */
const WIN_ANSI_EXTRA = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

export function isWinAnsi(cp: number): boolean {
  return (cp >= 0x20 && cp <= 0x7e) || (cp >= 0xa0 && cp <= 0xff) || WIN_ANSI_EXTRA.has(cp);
}

const REPLACEMENTS: Record<string, string> = {
  '≤': '<=', '≥': '>=', '≠': '!=', '≈': '~', '→': '->', '←': '<-', '↔': '<->', '⇒': '=>',
  '−': '-', '‐': '-', '‑': '-', '‒': '-', '―': '-', '′': "'", '″': '"', '⁄': '/', '∕': '/',
  '✓': 'v', '✔': 'v', '✗': 'x', '✘': 'x', '№': 'No.', '℉': '°F', '℃': '°C', 'Ω': 'ohm',
  '\u2002': ' ', '\u2003': ' ', '\u2007': ' ', '\u2009': ' ', '\u200a': ' ', '\u202f': ' ', '\u205f': ' ', '\u3000': ' ',
};

/** Emoji and their joiners, variation selectors, skin tones, flags and keycaps: dropped. */
const EMOJI = /\p{Extended_Pictographic}|[\u200d\ufe0e\ufe0f\u20e3]|[\u{1f3fb}-\u{1f3ff}]|[\u{1f1e6}-\u{1f1ff}]|[\u{e0020}-\u{e007f}]/gu;

/**
 * Makes text drawable with pdf-lib's standard Helvetica (WinAnsi): known
 * symbols get ASCII stand-ins (≤ → <=), emoji are removed, accents outside
 * Latin-1 are stripped (ő → o), anything else becomes "?". Whitespace and
 * control characters collapse to single spaces.
 */
export function sanitizeWinAnsi(input: string | null | undefined): string {
  if (!input) return '';
  let s = input.replace(EMOJI, '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/[\u200b\u200c\u2060\ufeff]/g, '');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (isWinAnsi(cp)) { out += ch; continue; }
    const rep = REPLACEMENTS[ch];
    if (rep !== undefined) { out += rep; continue; }
    const base = ch.normalize('NFKD').replace(/\p{M}/gu, '');
    if (base && [...base].every(c => isWinAnsi(c.codePointAt(0)!))) { out += base; continue; }
    out += '?';
  }
  s = out.replace(/ {2,}/g, ' ');
  return s.trim();
}

/**
 * Greedy word wrap to `maxWidth` using `measure` (points). Words longer than
 * a line are broken by character. Always returns at least one line.
 */
export function wrapText(text: string, measure: (s: string) => number, maxWidth: number): string[] {
  const words = text.split(' ').filter(Boolean);
  const lines: string[] = [];
  let line = '';
  const pushLong = (word: string) => {
    let chunk = '';
    for (const ch of word) {
      if (chunk && measure(chunk + ch) > maxWidth) { lines.push(chunk); chunk = ''; }
      chunk += ch;
    }
    return chunk;
  };
  for (const w of words) {
    const candidate = line ? `${line} ${w}` : w;
    if (measure(candidate) <= maxWidth) { line = candidate; continue; }
    if (line) lines.push(line);
    line = measure(w) <= maxWidth ? w : pushLong(w);
  }
  if (line || !lines.length) lines.push(line);
  return lines;
}

// ---------------------------------------------------------------- PDF

/** US Letter, points. */
export const PAGE = { width: 612, height: 792, margin: 54 } as const;

export interface HistoryPdf {
  bytes: Uint8Array;
  pageCount: number;
}

/** Builds the PDF. pdf-lib is imported here so it stays out of the main bundle. */
export async function buildHistoryPdf(doc: HistoryDoc): Promise<HistoryPdf> {
  const { PDFDocument, StandardFonts, rgb } = await import('pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(doc.title);
  pdf.setSubject('Service history');
  pdf.setCreator('Vehicles');
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  type Font = typeof regular;

  const ink = rgb(0.1, 0.1, 0.12);
  const muted = rgb(0.42, 0.42, 0.45);
  const rule = rgb(0.8, 0.8, 0.83);
  const { width: W, height: H, margin: M } = PAGE;
  const contentW = W - 2 * M;
  const footerH = 28;
  const bottom = M + footerH;

  let page = pdf.addPage([W, H]);
  let y = H - M;

  const newPage = () => {
    page = pdf.addPage([W, H]);
    y = H - M;
  };
  const text = (s: string, x: number, size: number, font: Font, color = ink) => {
    page.drawText(s, { x, y: y - size, size, font, color });
  };
  const wrap = (s: string, font: Font, size: number, width: number) =>
    wrapText(sanitizeWinAnsi(s), t => font.widthOfTextAtSize(t, size), width);

  // Title block.
  const titleLines = wrap(doc.vehicleName, bold, 20, contentW);
  for (const l of titleLines) { text(l, M, 20, bold); y -= 24; }
  text('Service history', M, 12, regular, muted);
  y -= 22;

  // Details: label column + value column.
  const labelW = 130;
  for (const d of doc.details) {
    const lines = wrap(d.value, regular, 10, contentW - labelW);
    if (y - lines.length * 14 < bottom) newPage();
    text(sanitizeWinAnsi(d.label), M, 10, bold, muted);
    for (const l of lines) { text(l, M + labelW, 10, regular); y -= 14; }
  }
  y -= 6;
  page.drawLine({ start: { x: M, y }, end: { x: W - M, y }, thickness: 0.75, color: rule });
  y -= 16;

  if (!doc.visits.length) {
    text('No visits recorded yet.', M, 11, regular, muted);
  }

  // Visits: keep each visit together on one page when it fits.
  const indent = 14;
  for (const v of doc.visits) {
    const totalW = bold.widthOfTextAtSize(sanitizeWinAnsi(v.total), 11);
    const head = wrap(v.date, bold, 11, contentW - totalW - 12);
    const sub = wrap(
      [v.mileage, v.shop, v.beforeOwnership ? 'Before we owned it' : null, v.sourceTag && v.sourceTag !== 'Purchase' ? `From ${v.sourceTag}` : null]
        .filter(Boolean).join(' · '),
      regular, 10, contentW,
    );
    const lines = v.lines.flatMap(l => wrap(l, regular, 10, contentW - indent).map((t, i) => ({ t, first: i === 0 })));
    const blockH = head.length * 15 + sub.length * 13 + lines.length * 13 + 14;
    const pageBody = H - M - bottom;
    if (y - blockH < bottom && blockH <= pageBody) newPage();

    const ensure = (h: number) => { if (y - h < bottom) newPage(); };
    ensure(15);
    page.drawText(sanitizeWinAnsi(v.total), { x: W - M - totalW, y: y - 11, size: 11, font: bold, color: ink });
    for (const l of head) { ensure(15); text(l, M, 11, bold); y -= 15; }
    for (const l of sub) { ensure(13); text(l, M, 10, regular, muted); y -= 13; }
    for (const l of lines) {
      ensure(13);
      if (l.first) text('•', M + 3, 10, regular, muted);
      text(l.t, M + indent, 10, regular);
      y -= 13;
    }
    y -= 14;
  }

  if (doc.omittedBefore > 0) {
    const note = `${doc.omittedBefore} ${doc.omittedBefore === 1 ? 'visit' : 'visits'} from before we owned it not included.`;
    if (y - 14 < bottom) newPage();
    text(sanitizeWinAnsi(note), M, 9, regular, muted);
  }

  // Footers, now that the page count is known.
  const pages = pdf.getPages();
  const left = sanitizeWinAnsi(`${doc.title} · Generated ${doc.generatedOn}`);
  pages.forEach((p, i) => {
    const right = `Page ${i + 1} of ${pages.length}`;
    const leftFit = wrapText(left, t => regular.widthOfTextAtSize(t, 8), contentW - 80)[0];
    p.drawLine({ start: { x: M, y: M + 16 }, end: { x: W - M, y: M + 16 }, thickness: 0.5, color: rule });
    p.drawText(leftFit, { x: M, y: M + 4, size: 8, font: regular, color: muted });
    p.drawText(right, { x: W - M - regular.widthOfTextAtSize(right, 8), y: M + 4, size: 8, font: regular, color: muted });
  });

  const bytes = await pdf.save();
  return { bytes, pageCount: pages.length };
}
