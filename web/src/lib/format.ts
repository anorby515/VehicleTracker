/**
 * Display formatting. All calendar dates are "YYYY-MM-DD" strings in
 * America/Chicago (see api/types.ts); they are formatted without ever going
 * through the device's time zone.
 */

import type { YMD } from '../api/types';

export const TZ = 'America/Chicago';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "2026-12-25" → day number (days since 1970-01-01), or null. */
export function ymdToDay(ymd: YMD | null | undefined): number | null {
  if (!ymd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

export function dayToYmd(day: number): YMD {
  const d = new Date(Math.round(day) * 86400000);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function daysBetween(a: YMD | null | undefined, b: YMD | null | undefined): number | null {
  const da = ymdToDay(a), db = ymdToDay(b);
  return da === null || db === null ? null : db - da;
}

export function addDays(ymd: YMD, n: number): YMD {
  return dayToYmd((ymdToDay(ymd) ?? 0) + n);
}

/** Today's date in America/Chicago on this device. */
export function todayYmd(now: Date = new Date()): YMD {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  return p; // en-CA formats as YYYY-MM-DD
}

/** "2026-12-25" → "Dec 25, 2026". Null → fallback. */
export function formatDate(ymd: YMD | null | undefined, fallback = '—'): string {
  if (!ymd) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return fallback;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}, ${m[1]}`;
}

/** "2026-12-25" → "Dec 25" (for compact rows and notifications). */
export function formatDateShort(ymd: YMD | null | undefined, fallback = '—'): string {
  if (!ymd) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(ymd);
  if (!m) return fallback;
  return `${MONTHS[+m[2] - 1]} ${+m[3]}`;
}

/** ISO timestamp → "2:14 PM" in Chicago time. */
export function formatTime(iso: string | number | Date | null | undefined, fallback = ''): string {
  if (iso === null || iso === undefined || iso === '') return fallback;
  const d = iso instanceof Date ? iso : new Date(iso);
  if (isNaN(d.getTime())) return fallback;
  return new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }).format(d);
}

/** ISO timestamp → "Dec 25, 2026, 2:14 PM" in Chicago time. */
export function formatDateTime(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return fallback;
  const ymd = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return `${formatDate(ymd)}, ${formatTime(d)}`;
}

const intFmt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** 40000 → "40,000 mi". */
export function formatMiles(n: number | null | undefined, fallback = '—'): string {
  return n === null || n === undefined || !isFinite(n) ? fallback : `${intFmt.format(Math.round(n))} mi`;
}

export function formatNumber(n: number | null | undefined, fallback = '—'): string {
  return n === null || n === undefined || !isFinite(n) ? fallback : intFmt.format(Math.round(n));
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const moneyWholeFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** 1518.98 → "$1,518.98"; blank → "—". */
export function formatMoney(n: number | null | undefined, fallback = '—'): string {
  return n === null || n === undefined || !isFinite(n) ? fallback : moneyFmt.format(n);
}

/** 1518.98 → "$1,519" (charts and summaries). */
export function formatMoneyWhole(n: number | null | undefined, fallback = '—'): string {
  return n === null || n === undefined || !isFinite(n) ? fallback : moneyWholeFmt.format(n);
}

/** Plain-language time until a date: "today", "tomorrow", "in 5 days", "in ~3 weeks", "3 days ago". */
export function relativeDays(days: number): string {
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  if (days === -1) return 'yesterday';
  const abs = Math.abs(days);
  let text: string;
  if (abs < 14) text = `${abs} days`;
  else if (abs < 60) text = `~${Math.round(abs / 7)} weeks`;
  else if (abs < 365 * 2) text = `~${Math.round(abs / 30.44)} months`;
  else text = `~${Math.round(abs / 365.25)} years`;
  return days > 0 ? `in ${text}` : `${text} ago`;
}

/**
 * The Upcoming countdown: "in ~3 weeks or 1,200 mi", "overdue by 2 weeks",
 * "in 5 days", "in 1,200 mi". Miles remaining use the vehicle's estimate.
 */
export function countdown(
  dueBy: YMD | null,
  dueMiles: number | null,
  estMileage: number | null,
  today: YMD,
): string | null {
  const days = dueBy ? daysBetween(today, dueBy) : null;
  const miles = dueMiles !== null && estMileage !== null ? Math.round(dueMiles - estMileage) : null;
  const parts: string[] = [];
  if (days !== null) {
    if (days < 0) parts.push(`overdue by ${relativeDays(-days).replace(/^in /, '')}`);
    else parts.push(relativeDays(days));
  }
  if (miles !== null) {
    if (miles <= 0) {
      if (days === null || days >= 0) parts.push(`${formatNumber(-miles)} mi past`);
    } else {
      parts.push(`${days === null ? 'in ' : ''}${formatNumber(miles)} mi`);
    }
  }
  if (!parts.length) return null;
  return parts.join(' or ');
}

/** Copies text to the clipboard; resolves false when not allowed. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
