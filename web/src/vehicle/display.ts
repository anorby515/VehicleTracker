/**
 * Presentation helpers for the vehicle card and its sheets. Pure functions
 * only: they turn bootstrap values into the words people read. Nothing here
 * recalculates a due date or a mileage estimate (the Sheet owns those).
 */

import type { AttentionItem, CoveragePlan, DocumentRef, Registration, SourceTag, UpcomingItem, Vehicle, WearItem, YMD } from '../api/types';
import { formatDate, formatMiles, formatMoney, formatNumber } from '../lib/format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2028-03-14" → "Mar 2028". */
export function formatMonthYear(ymd: YMD | null | undefined, fallback = '—'): string {
  const m = /^(\d{4})-(\d{2})/.exec(ymd ?? '');
  return m ? `${MONTHS[+m[2] - 1]} ${m[1]}` : fallback;
}

/** Tidy a number for display: whole numbers as is, others to at most 1 decimal. */
function tidy(n: number): string {
  return Number.isInteger(n) ? formatNumber(n) : String(Math.round(n * 10) / 10);
}

/** A wear reading with its unit: 5 + "/32 in" → "5/32 in"; 4 + "mm" → "4 mm". */
export function formatWearValue(value: number | null | undefined, unit: string | null | undefined): string {
  if (value === null || value === undefined || !isFinite(value)) return '—';
  const u = (unit ?? '').trim();
  if (!u) return tidy(value);
  if (u.startsWith('/')) return `${tidy(value)}${u}`;
  return `${tidy(value)} ${u}`;
}

/**
 * The wear projection line: "Replace around 52,000 mi (about Mar 2028)",
 * or the API's note ("One reading so far"), or null.
 */
export function wearProjectionText(item: WearItem, estMileage: number | null): string | null {
  if (item.latest.value <= item.replacementPoint) return 'At or past the replacement point';
  const p = item.projection;
  if (p) {
    const miles = roundProjection(p.mileage);
    if (estMileage !== null && p.mileage <= estMileage) {
      return `Probably at the replacement point now (projected ${formatMiles(miles)})`;
    }
    return p.date
      ? `Replace around ${formatMiles(miles)} (about ${formatMonthYear(p.date)})`
      : `Replace around ${formatMiles(miles)}`;
  }
  return item.note;
}

/** Projections are rough: show them to the nearest 500 mi. */
export function roundProjection(miles: number): number {
  return Math.round(miles / 500) * 500;
}

/** "Replace at 4/32 in" / "Replace at 3 mm". */
export function replacementPointText(item: Pick<WearItem, 'replacementPoint' | 'unit'>): string {
  return `Replace at ${formatWearValue(item.replacementPoint, item.unit)}`;
}

/** "N visits have no total recorded" (null when every visit has one). */
export function visitsWithoutTotalText(n: number): string | null {
  if (!n) return null;
  return n === 1 ? '1 visit has no total recorded' : `${formatNumber(n)} visits have no total recorded`;
}

/** 0.1234 → "$0.12 a mile"; null → "Not enough mileage yet". */
export function costPerMileText(n: number | null): string {
  if (n === null || !isFinite(n)) return 'Not enough mileage yet';
  return `${formatMoney(n)} a mile`;
}

/** Schedule interval: "Every 6 months or 5,000 mi", "Every 12 months", "Every 5,000 mi". */
export function intervalText(months: number | null, miles: number | null): string | null {
  const parts: string[] = [];
  if (months) parts.push(months === 1 ? '1 month' : `${formatNumber(months)} months`);
  if (miles) parts.push(formatMiles(miles));
  if (!parts.length) return null;
  return `Every ${parts.join(' or ')}`;
}

/** "Due by Dec 25, 2026 · at 40,000 mi" (either half may be missing). */
export function dueText(item: Pick<UpcomingItem, 'dueBy' | 'dueMiles'>): string | null {
  const parts: string[] = [];
  if (item.dueBy) parts.push(`Due by ${formatDate(item.dueBy)}`);
  if (item.dueMiles !== null && item.dueMiles !== undefined) parts.push(`at ${formatMiles(item.dueMiles)}`);
  return parts.length ? parts.join(' · ') : null;
}

/** When a warranty or plan ends, whichever limit comes first. */
export function coverageEndText(plan: CoveragePlan): string | null {
  const past = !plan.active;
  if (plan.endsBy === 'miles' && plan.endMiles !== null) {
    const about = plan.endMilesDate ? ` (about ${formatDate(plan.endMilesDate)})` : '';
    return past ? `Ended at ${formatMiles(plan.endMiles)}` : `Ends at ${formatMiles(plan.endMiles)}${about}`;
  }
  if (plan.endDate) return `${past ? 'Ended' : 'Ends'} ${formatDate(plan.endDate)}`;
  if (plan.endMiles !== null) return `${past ? 'Ended' : 'Ends'} at ${formatMiles(plan.endMiles)}`;
  return past ? 'Ended' : 'No end date or mileage';
}

/** Which limit ends a plan, in words. */
export function coverageLimitText(plan: CoveragePlan): string | null {
  if (plan.endsBy === 'miles') return 'The mileage limit comes first.';
  if (plan.endsBy === 'date' && plan.endMiles !== null) return 'The date comes before the mileage limit.';
  if (plan.endsBy === 'date') return 'It ends on a date.';
  return null;
}

/** What a plan covers: "Covers everything", "Oil Change, Tire Rotation", or null when not listed. */
export function coversText(plan: Pick<CoveragePlan, 'covers'>): string | null {
  if (!plan.covers.length) return null;
  if (plan.covers.some(c => c.toLowerCase() === 'all')) return 'Covers everything';
  return `Covers ${plan.covers.join(', ')}`;
}

/** "190 days left", "Expires today", "Expired 22 days ago". */
export function registrationDaysText(reg: Pick<Registration, 'daysLeft'>): string | null {
  const d = reg.daysLeft;
  if (d === null) return null;
  if (d === 0) return 'Expires today';
  if (d === 1) return '1 day left';
  if (d > 0) return `${formatNumber(d)} days left`;
  return d === -1 ? 'Expired yesterday' : `Expired ${formatNumber(-d)} days ago`;
}

/** Friendly label for a Recommendations › Status value. */
export function recommendationStatusText(status: string | null): string {
  switch ((status ?? '').toLowerCase()) {
    case 'open': return 'Declined';
    case 'watch': return 'Keep an eye on';
    case 'done': return 'Done';
    default: return status ?? '';
  }
}

/** Tag text for a visit's source ("CarFax", "Owner", "Purchase"). */
export function sourceTagText(tag: SourceTag): string | null {
  return tag;
}

/** The make's initial for the photo placeholder ("T" for Toyota). */
export function makeInitial(v: Pick<Vehicle, 'make' | 'name'>): string {
  const src = (v.make || v.name.replace(/^\d{4}\s+/, '') || '?').trim();
  return (src.charAt(0) || '?').toUpperCase();
}

/** Any Sheet value as display text; blanks → null (numbers from the Sheet become strings). */
export function valueText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
}

/** "Plate SAMPLE4 · Leo drives it" style second line pieces. */
export function plateText(plate: string | null): string {
  return plate ? plate : 'No plate on file';
}

const DOC_ORDER: Record<DocumentRef['kind'], number> = { pdf: 0, image: 1, other: 2 };

/**
 * A visit's documents with PDFs first (a merged PDF before its page images),
 * then images, then anything else; otherwise in the API's (Documents tab) order.
 */
export function sortDocuments(docs: DocumentRef[]): DocumentRef[] {
  return docs
    .map((d, i) => ({ d, i }))
    .sort((a, b) => (DOC_ORDER[a.d.kind] ?? 2) - (DOC_ORDER[b.d.kind] ?? 2) || a.i - b.i)
    .map(x => x.d);
}

const isNewRecall = (status: string | null) => (status ?? '').toLowerCase() === 'new';

/** One attention banner row. `strong` is a bold first line for safety warnings. */
export interface AttentionEntry extends AttentionItem {
  tone: 'normal' | 'danger' | 'warn';
  strong: string | null;
}

/**
 * The attention banner's rows. A New recall with NHTSA's "park it" flag gets
 * a strong "Do not drive until repaired" line (and "park outside" a fire-risk
 * line). Safety warnings show for everyone looking at the vehicle, so one is
 * added when the API's per-person list has no recall row.
 */
export function attentionEntries(v: Pick<Vehicle, 'name' | 'shortName' | 'attention' | 'recalls'>, recallsHref: string): AttentionEntry[] {
  const open = v.recalls.filter(r => isNewRecall(r.status));
  const parkIt = open.some(r => r.parkIt);
  const parkOutside = open.some(r => r.parkOutside);
  const recallTone = (): Pick<AttentionEntry, 'tone' | 'strong'> =>
    parkIt ? { tone: 'danger', strong: 'Do not drive until repaired' }
      : parkOutside ? { tone: 'warn', strong: 'Park outside, away from buildings' }
        : { tone: 'normal', strong: null };
  const out: AttentionEntry[] = v.attention.map(a => (a.kind === 'recall' ? { ...a, ...recallTone() } : { ...a, tone: 'normal', strong: null }));
  if ((parkIt || parkOutside) && !v.attention.some(a => a.kind === 'recall')) {
    out.unshift({
      kind: 'recall',
      text: `Open recall on the ${v.shortName || v.name}`,
      href: recallsHref,
      ...recallTone(),
    });
  }
  // Safety first: the most serious row leads.
  const rank = { danger: 0, warn: 1, normal: 2 } as const;
  return out.map((e, i) => ({ e, i })).sort((a, b) => rank[a.e.tone] - rank[b.e.tone] || a.i - b.i).map(x => x.e);
}
