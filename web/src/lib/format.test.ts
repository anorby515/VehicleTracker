import { describe, expect, it } from 'vitest';
import { countdown, daysBetween, formatDate, formatMiles, formatMoney, relativeDays, todayYmd, formatTime } from './format';

describe('format', () => {
  it('formats dates as "Dec 25, 2026" without time-zone drift', () => {
    expect(formatDate('2026-12-25')).toBe('Dec 25, 2026');
    expect(formatDate('2027-01-01')).toBe('Jan 1, 2027');
    expect(formatDate(null)).toBe('—');
  });

  it('formats miles and money', () => {
    expect(formatMiles(40000)).toBe('40,000 mi');
    expect(formatMiles(37747.6)).toBe('37,748 mi');
    expect(formatMiles(null, 'Not set')).toBe('Not set');
    expect(formatMoney(1518.98)).toBe('$1,518.98');
    expect(formatMoney(null)).toBe('—');
  });

  it('computes today in Chicago', () => {
    expect(todayYmd(new Date('2026-12-25T05:30:00Z'))).toBe('2026-12-24');
    expect(todayYmd(new Date('2026-12-25T06:30:00Z'))).toBe('2026-12-25');
  });

  it('formats times in Chicago', () => {
    expect(formatTime('2026-09-22T19:14:00Z')).toBe('2:14 PM');
  });

  it('describes relative days in plain language', () => {
    expect(relativeDays(0)).toBe('today');
    expect(relativeDays(5)).toBe('in 5 days');
    expect(relativeDays(21)).toBe('in ~3 weeks');
    expect(relativeDays(-9)).toBe('9 days ago');
    expect(relativeDays(120)).toBe('in ~4 months');
  });

  it('builds the Upcoming countdown', () => {
    const today = '2026-09-22';
    expect(countdown('2026-10-13', 40000, 38800, today)).toBe('in ~3 weeks or 1,200 mi');
    expect(countdown('2026-09-13', null, null, today)).toBe('overdue by 9 days');
    expect(countdown(null, 40000, 38800, today)).toBe('in 1,200 mi');
    expect(countdown('2026-12-25', 40000, 40100, today)).toBe('in ~3 months or 100 mi past');
    expect(countdown(null, null, null, today)).toBeNull();
    expect(daysBetween(today, '2026-12-25')).toBe(94);
  });
});
