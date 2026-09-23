/**
 * Calendar-date helpers. Pure functions over "YYYY-MM-DD" strings, so the
 * data logic never depends on the server's time zone. Day arithmetic uses
 * UTC day numbers, which have no DST gaps.
 *
 * The only functions that look at the clock or at Date objects from the Sheet
 * are nowParts_() and ymdFromDate_(), which use America/Chicago.
 */

/** "2026-09-22" → day number (days since 1970-01-01), or null. */
function ymdToDay_(ymd) {
  if (!ymd) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd));
  if (!m) return null;
  return Math.floor(Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000);
}

/** Day number → "YYYY-MM-DD". */
function dayToYmd_(day) {
  if (day === null || day === undefined || !isFinite(day)) return null;
  const d = new Date(Math.round(day) * 86400000);
  return d.getUTCFullYear() + '-' + pad2_(d.getUTCMonth() + 1) + '-' + pad2_(d.getUTCDate());
}

function pad2_(n) {
  return (n < 10 ? '0' : '') + n;
}

/** Whole days from a to b (b − a). Null if either is missing. */
function daysBetween_(a, b) {
  const da = ymdToDay_(a), db = ymdToDay_(b);
  return da === null || db === null ? null : db - da;
}

function addDays_(ymd, n) {
  const d = ymdToDay_(ymd);
  return d === null ? null : dayToYmd_(d + n);
}

/** Adds calendar months like Sheets EDATE (clamps to the month's last day). */
function addMonths_(ymd, months) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  const total = (+m[1]) * 12 + (+m[2] - 1) + months;
  const y = Math.floor(total / 12), mo = total % 12;
  const last = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
  return y + '-' + pad2_(mo + 1) + '-' + pad2_(Math.min(+m[3], last));
}

function compareYmd_(a, b) {
  if (a === b) return 0;
  if (!a) return 1;   // nulls sort last
  if (!b) return -1;
  return a < b ? -1 : 1;
}

function yearOf_(ymd) {
  return ymd ? +String(ymd).slice(0, 4) : null;
}

/**
 * A Date (from a Sheet cell) → "YYYY-MM-DD" in America/Chicago.
 * The ingestion script stores dates at local noon, so this never shifts a day.
 */
function ymdFromDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return formatInTz_(d, 'yyyy-MM-dd');
}

/** A Date → ISO 8601 with the Chicago offset, e.g. "2026-09-22T15:29:30-05:00". */
function isoFromDate_(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return formatInTz_(d, "yyyy-MM-dd'T'HH:mm:ssXXX");
}

/** Current Chicago wall-clock parts: {ymd, hour, minute, iso}. */
function nowParts_(now) {
  const d = now || new Date();
  return {
    ymd: formatInTz_(d, 'yyyy-MM-dd'),
    hour: +formatInTz_(d, 'H'),
    minute: +formatInTz_(d, 'm'),
    hhmm: formatInTz_(d, 'HHmm'),
    iso: formatInTz_(d, "yyyy-MM-dd'T'HH:mm:ssXXX"),
  };
}

/** "2026-09-22" → a Date at noon Chicago time (for writing date cells). */
function noonDate_(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd || ''));
  if (!m) return null;
  // Sheets interprets a script Date in the spreadsheet's zone; noon is safe
  // against any zone mismatch (the ingestion script uses the same trick).
  return new Date(+m[1], +m[2] - 1, +m[3], 12, 0, 0);
}

/**
 * Formats a Date in America/Chicago. Uses Utilities.formatDate in Apps Script,
 * and Intl in Node (unit tests). Only the patterns used above are supported.
 */
function formatInTz_(d, pattern) {
  if (typeof Utilities !== 'undefined' && Utilities.formatDate) {
    return Utilities.formatDate(d, TZ, pattern);
  }
  const parts = {};
  new Intl.DateTimeFormat('en-US', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', timeZoneName: 'longOffset',
  }).formatToParts(d).forEach(p => { parts[p.type] = p.value; });
  const off = (parts.timeZoneName || 'GMT-06:00').replace('GMT', '') || '+00:00';
  const map = {
    'yyyy-MM-dd': parts.year + '-' + parts.month + '-' + parts.day,
    'H': String(+parts.hour),
    'm': String(+parts.minute),
    'HHmm': parts.hour + parts.minute,
    "yyyy-MM-dd'T'HH:mm:ssXXX": parts.year + '-' + parts.month + '-' + parts.day + 'T' +
      parts.hour + ':' + parts.minute + ':' + parts.second + off,
  };
  if (!(pattern in map)) throw new Error('formatInTz_: unsupported pattern ' + pattern);
  return map[pattern];
}
