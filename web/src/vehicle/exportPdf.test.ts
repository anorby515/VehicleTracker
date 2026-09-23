import { PDFDocument, StandardFonts } from 'pdf-lib';
import { describe, expect, it } from 'vitest';
import { buildHistory, buildHistoryPdf, isWinAnsi, safeFileName, sanitizeWinAnsi, serviceLines, wrapText } from './exportPdf';
import { makeVehicle, makeVisit } from './testing';

describe('sanitizeWinAnsi', () => {
  it('keeps Latin-1 and WinAnsi punctuation', () => {
    expect(sanitizeWinAnsi('Café – “quoted” … $1,234.50 · 5°')).toBe('Café – “quoted” … $1,234.50 · 5°');
  });

  it('replaces symbols Helvetica cannot draw', () => {
    expect(sanitizeWinAnsi('Tread ≤ 4/32 in → replace')).toBe('Tread <= 4/32 in -> replace');
    expect(sanitizeWinAnsi('−3 mm')).toBe('-3 mm');
  });

  it('drops emoji, joiners and flags, and tidies the spaces they leave', () => {
    expect(sanitizeWinAnsi('All done 👍🏽 thanks 👨‍👩‍👧 🇺🇸!')).toBe('All done thanks !');
  });

  it('strips accents outside Latin-1 and marks the rest with ?', () => {
    expect(sanitizeWinAnsi('Łódź Škoda Hőgyes 北京')).toBe('?ódz Škoda Hogyes ??');
  });

  it('turns newlines, tabs and zero-width characters into plain spacing', () => {
    expect(sanitizeWinAnsi('Line one\nline\ttwo\u200b')).toBe('Line one line two');
    expect(sanitizeWinAnsi(null)).toBe('');
  });

  it('only produces characters the standard font can encode', async () => {
    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const charset = new Set(font.getCharacterSet());
    const nasty = 'Ω≤≥≠≈→←−‐′″⁄✓✔ 🚗 ﬁ ² ½ € Ÿ \u202f 漢字 ÿ';
    const clean = sanitizeWinAnsi(nasty);
    for (const ch of clean) expect(charset.has(ch.codePointAt(0)!), `U+${ch.codePointAt(0)!.toString(16)}`).toBe(true);
    expect(() => font.encodeText(clean)).not.toThrow();
    // The hand-written WinAnsi table agrees with pdf-lib's.
    for (let cp = 0x20; cp <= 0x2122; cp++) {
      if (isWinAnsi(cp)) expect(charset.has(cp), `U+${cp.toString(16)}`).toBe(true);
    }
  });
});

describe('wrapText', () => {
  const measure = (s: string) => s.length; // 1 unit per character

  it('wraps greedily at word boundaries', () => {
    expect(wrapText('one two three four', measure, 9)).toEqual(['one two', 'three', 'four']);
  });

  it('breaks a word longer than the line', () => {
    expect(wrapText('abcdefghij xy', measure, 4)).toEqual(['abcd', 'efgh', 'ij', 'xy']);
  });

  it('returns one empty line for empty text', () => {
    expect(wrapText('', measure, 10)).toEqual(['']);
  });
});

describe('buildHistory', () => {
  const before = makeVisit({ visitId: 'old', date: '2024-01-02', beforeOwnership: true, sourceTag: 'CarFax', services: [], summary: 'Tire rotation' });
  const v = makeVehicle({ visits: [makeVisit(), before] });

  it('leaves out visits from before the purchase unless asked', () => {
    const off = buildHistory(v, { includeBefore: false, today: '2026-09-23' });
    expect(off.visits.map(x => x.visitId)).toEqual(['v-1']);
    expect(off.omittedBefore).toBe(1);
    const on = buildHistory(v, { includeBefore: true, today: '2026-09-23' });
    expect(on.visits.map(x => x.visitId)).toEqual(['v-1', 'old']);
    expect(on.omittedBefore).toBe(0);
  });

  it('formats visits and never includes Notes', () => {
    const h = buildHistory(v, { includeBefore: true, today: '2026-09-23' });
    expect(h.visits[0]).toMatchObject({ date: 'Aug 24, 2026', mileage: '36,410 mi', shop: 'Sample Motors', total: '$158.40' });
    expect(h.visits[0].lines).toEqual(['ENGINE OIL CHANGE (0W-20)', 'TIRE ROTATE']);
    expect(h.visits[1].lines).toEqual(['Tire rotation']); // summary when no services
    expect(JSON.stringify(h)).not.toContain('Technical note');
    expect(h.details).toContainEqual({ label: 'Purchased', value: 'Apr 10, 2026' });
    expect(h.details).toContainEqual({ label: 'Mileage at purchase', value: '28,640 mi' });
    expect(h.fileName).toBe('2023 Sample Roadster service history.pdf');
    expect(h.generatedOn).toBe('Sep 23, 2026');
  });

  it('names a service by its type when the receipt repeats a combined line', () => {
    expect(serviceLines([
      { serviceType: 'Oil Change', description: 'ENGINE OIL CHANGE AND TIRE ROTATE (0W-20)' },
      { serviceType: 'Tire Rotation', description: 'ENGINE OIL CHANGE AND TIRE ROTATE' },
      { serviceType: 'Multi-Point Inspection', description: null },
      { serviceType: 'Multi-Point Inspection', description: null },
    ])).toEqual(['ENGINE OIL CHANGE AND TIRE ROTATE (0W-20)', 'Tire Rotation', 'Multi-Point Inspection']);
  });

  it('makes file names safe', () => {
    expect(safeFileName('A/B: "C"')).toBe('A B C');
  });
});

describe('buildHistoryPdf', () => {
  it('builds a one-page PDF for a short history', async () => {
    const h = buildHistory(makeVehicle(), { includeBefore: false, today: '2026-09-23' });
    const { bytes, pageCount } = await buildHistoryPdf(h);
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-');
    const loaded = await PDFDocument.load(bytes);
    expect(loaded.getPageCount()).toBe(1);
    expect(pageCount).toBe(1);
    expect(loaded.getTitle()).toBe('2023 Sample Roadster service history');
  });

  it('paginates a long history and survives characters Helvetica lacks', async () => {
    const visits = Array.from({ length: 60 }, (_, i) => makeVisit({
      visitId: `v-${i}`,
      summary: 'x',
      location: `Shop ${i} 🚗 ≤ “best”`,
      services: Array.from({ length: 4 }, (_, j) => ({
        serviceType: 'Other',
        description: `Service ${j}: a fairly long description as printed on the receipt, with ≥ symbols and 漢字 that must wrap onto a second line`,
        lineCost: 10,
        notes: null,
      })),
    }));
    const h = buildHistory(makeVehicle({ visits }), { includeBefore: true, today: '2026-09-23' });
    const { bytes, pageCount } = await buildHistoryPdf(h);
    const loaded = await PDFDocument.load(bytes);
    expect(pageCount).toBeGreaterThan(5);
    expect(loaded.getPageCount()).toBe(pageCount);
    for (const p of loaded.getPages()) expect(p.getSize()).toEqual({ width: 612, height: 792 });
  });

  it('handles a vehicle with no visits', async () => {
    const h = buildHistory(makeVehicle({ visits: [] }), { includeBefore: false, today: '2026-09-23' });
    const { pageCount } = await buildHistoryPdf(h);
    expect(pageCount).toBe(1);
  });
});
