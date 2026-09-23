/**
 * pdf-lib's standard fonts (Helvetica) can only draw WinAnsi (Windows-1252)
 * characters and throw on anything else. Everything we draw goes through
 * `toWinAnsi` first: accents are kept when WinAnsi has them, stripped when
 * it doesn't, a few symbols get ASCII stand-ins, and the rest become "?".
 */

/** Unicode code points WinAnsi can encode. */
const WIN_ANSI = new Set<number>([
  ...range(0x20, 0x7e),
  ...range(0xa0, 0xff),
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x017d,
  0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
]);

const REPLACEMENTS: Record<string, string> = {
  '\t': ' ',
  '­': '',
  '‐': '-', '‑': '-', '‒': '-', '―': '-', '−': '-',
  '′': "'", '″': '"', '´': "'",
  '←': '<-', '→': '->', '↔': '<->', '⇒': '=>',
  '≈': '~', '≤': '<=', '≥': '>=', '≠': '!=', '№': 'No.',
  ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '‌': '', '‍': '', '﻿': '',
  '✓': 'v', '✔': 'v', '✕': 'x', '✗': 'x',
  'Ł': 'L', 'ł': 'l', 'Đ': 'D', 'đ': 'd', 'Ħ': 'H', 'ħ': 'h', 'ı': 'i',
};

function range(a: number, b: number): number[] {
  const out: number[] = [];
  for (let i = a; i <= b; i++) out.push(i);
  return out;
}

/** Makes text safe for a standard 14 PDF font. Newlines are kept. */
export function toWinAnsi(text: string): string {
  let out = '';
  for (const ch of text) {
    if (ch === '\n') { out += '\n'; continue; }
    if (ch === '\r') continue;
    const cp = ch.codePointAt(0)!;
    if (WIN_ANSI.has(cp)) { out += ch; continue; }
    if (ch in REPLACEMENTS) { out += REPLACEMENTS[ch]; continue; }
    const stripped = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (stripped && [...stripped].every(c => WIN_ANSI.has(c.codePointAt(0)!))) { out += stripped; continue; }
    if (cp < 0x20) { out += ' '; continue; }
    out += '?';
  }
  return out;
}
