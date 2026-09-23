// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { inflateSync } from 'node:zlib';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PAGE_WIDTH_PT, assemblePdf, pageSizeFor } from './assemble';
import { CombineError, MAX_VISIT_BYTES, combineFiles } from './combine';
import { NO_SHOP_LINE, OWNER_TITLE, type OwnerEntryInput, buildOwnerEntryPdf, ownerEntryLines, wrapText } from './ownerEntry';
import { toWinAnsi } from './winansi';

/** A valid 1×1 baseline JPEG. */
const JPEG_1PX = Uint8Array.from(Buffer.from(
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
  'base64',
));

async function samplePdf(pages: number, text = 'Sample invoice'): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) doc.addPage([612, 792]).drawText(`${text} ${i + 1}`, { x: 50, y: 700, size: 14, font });
  return doc.save();
}

/** All text drawn with pdf-lib (hex strings in the inflated content streams). */
function extractText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const out: string[] = [];
  const re = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    let body: string;
    try { body = inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch { body = m[1]; }
    for (const t of body.matchAll(/<([0-9A-Fa-f]+)>\s*Tj/g)) out.push(new TextDecoder('windows-1252').decode(Buffer.from(t[1], 'hex')));
  }
  return out.join('\n');
}

describe('assemblePdf', () => {
  it('makes one page per image, 612 pt wide with the image’s aspect', async () => {
    const bytes = await assemblePdf([
      { jpeg: JPEG_1PX, width: 1000, height: 2000 },
      { jpeg: JPEG_1PX, width: 1500, height: 2000 },
      { jpeg: JPEG_1PX, width: 600, height: 3000 },
    ], { title: 'Receipt scan', createdAt: new Date('2026-09-20T12:00:00Z') });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    const sizes = doc.getPages().map(p => p.getSize());
    expect(sizes[0]).toEqual({ width: PAGE_WIDTH_PT, height: 1224 });
    expect(sizes[1].width).toBe(612);
    expect(sizes[1].height).toBeCloseTo(816, 5);
    expect(sizes[2].height).toBeCloseTo(3060, 5);
    expect(doc.getTitle()).toBe('Receipt scan');
    expect(doc.getCreator()).toBe('Vehicles app');
    expect(Buffer.from(bytes.slice(0, 5)).toString()).toBe('%PDF-');
  });

  it('caps absurdly long pages at the PDF maximum', () => {
    const s = pageSizeFor(100, 5000);
    expect(s.height).toBe(14400);
    expect(s.width).toBeLessThan(612);
  });

  it('refuses an empty scan', async () => {
    await expect(assemblePdf([], { title: 'x' })).rejects.toThrow();
  });
});

describe('combineFiles', () => {
  it('uploads a single PDF byte-for-byte', async () => {
    const original = await samplePdf(2);
    const res = await combineFiles([{ kind: 'pdf', name: 'invoice.pdf', data: original }], { title: 'Upload' });
    expect(res.passthrough).toBe(true);
    expect(res.pages).toBe(2);
    const out = new Uint8Array(await res.pdf.arrayBuffer());
    expect(out.byteLength).toBe(original.byteLength);
    expect(Buffer.compare(Buffer.from(out), Buffer.from(original))).toBe(0);
  });

  it('keeps a single PDF Blob as the very same Blob', async () => {
    const blob = new Blob([await samplePdf(1) as BlobPart], { type: 'application/pdf' });
    const res = await combineFiles([{ kind: 'pdf', name: 'a.pdf', data: blob }], { title: 'Upload' });
    expect(res.pdf).toBe(blob);
  });

  it('merges PDFs and images in order', async () => {
    const res = await combineFiles([
      { kind: 'pdf', name: 'invoice.pdf', data: await samplePdf(3, 'Invoice') },
      { kind: 'image', name: 'slip.jpg', jpeg: JPEG_1PX, width: 800, height: 1200 },
      { kind: 'pdf', name: 'inspection.pdf', data: await samplePdf(1, 'Inspection') },
    ], { title: 'Upload' });
    expect(res.passthrough).toBe(false);
    expect(res.pages).toBe(5);
    const bytes = new Uint8Array(await res.pdf.arrayBuffer());
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(5);
    expect(doc.getPage(3).getSize().height).toBeCloseTo(918, 5);
    const text = extractText(bytes);
    expect(text.indexOf('Invoice 3')).toBeLessThan(text.indexOf('Inspection 1'));
  });

  it('names the file it can’t read', async () => {
    const bad = new TextEncoder().encode('not a pdf at all');
    await expect(combineFiles([
      { kind: 'pdf', name: 'good.pdf', data: await samplePdf(1) },
      { kind: 'pdf', name: 'broken.pdf', data: bad },
    ], { title: 'Upload' })).rejects.toMatchObject({ name: 'CombineError', fileName: 'broken.pdf' });
    await expect(combineFiles([{ kind: 'pdf', name: 'alone.pdf', data: bad }], { title: 'x' }))
      .rejects.toBeInstanceOf(CombineError);
  });

  it('enforces the 25 MB visit limit before building anything', async () => {
    const big = new Uint8Array(MAX_VISIT_BYTES + 1);
    await expect(combineFiles([
      { kind: 'image', name: 'a.jpg', jpeg: big, width: 10, height: 10 },
      { kind: 'image', name: 'b.jpg', jpeg: JPEG_1PX, width: 10, height: 10 },
    ], { title: 'x' })).rejects.toThrow(/25 MB/);
  });
});

describe('owner entry', () => {
  const entry: OwnerEntryInput = {
    vehicleName: '2023 Sample Trailrunner',
    vin: 'TESTVIN0000000009',
    plate: 'SAMPLE9',
    date: '2026-09-20',
    dateApprox: true,
    mileage: 37748,
    mileageApprox: false,
    services: ['Wiper Blades', 'Cabin Air Filter'],
    otherWork: 'Also topped up washer fluid — “blue” kind ✓',
    partsCost: 42.5,
    notes: 'Bought at the parts store.\nOld blades were streaking.',
    who: 'Robert',
    enteredAt: new Date('2026-09-23T19:14:00Z'),
    photoCount: 0,
  };

  it('lists every required fact', () => {
    const t = ownerEntryLines(entry);
    const all = [t.title, t.subtitle, ...t.rows.map(r => `${r.label}: ${r.value}`)].join('\n');
    expect(t.title).toBe(OWNER_TITLE);
    for (const s of [
      'Vehicle: 2023 Sample Trailrunner', 'VIN: TESTVIN0000000009', 'Plate: SAMPLE9',
      'Date: Sep 20, 2026 (2026-09-20) (approximate)', 'Date is approximate: Yes',
      'Mileage: 37,748 mi', 'Mileage is approximate: No', 'Services: Wiper Blades, Cabin Air Filter',
      'Also topped up washer fluid', 'Parts cost: $42.50', 'Old blades were streaking', 'Done by: Robert',
      NO_SHOP_LINE, 'Entered: Sep 23, 2026, 2:14 PM',
    ]) expect(all).toContain(s);
  });

  it('builds a Letter PDF whose first page carries the record, then one page per photo', async () => {
    const bytes = await buildOwnerEntryPdf(entry, [
      { jpeg: JPEG_1PX, width: 1200, height: 1600 },
      { jpeg: JPEG_1PX, width: 1600, height: 1200 },
    ]);
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect(doc.getPage(0).getSize()).toEqual({ width: 612, height: 792 });
    expect(doc.getCreator()).toBe('Vehicles app');
    const text = extractText(bytes);
    for (const s of [OWNER_TITLE, NO_SHOP_LINE, '2023 Sample Trailrunner', 'TESTVIN0000000009', 'SAMPLE9', 'Robert', '$42.50', '37,748 mi', '(approximate)']) {
      expect(text).toContain(s);
    }
    // Non-WinAnsi characters were replaced rather than crashing pdf-lib.
    expect(text.replace(/\n/g, ' ')).toContain('“blue” kind v');
  });

  it('paginates very long notes', async () => {
    const bytes = await buildOwnerEntryPdf({ ...entry, notes: 'Lorem ipsum dolor sit amet. '.repeat(400) });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBeGreaterThan(1);
  });

  it('wraps and breaks long words', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const lines = wrapText('short ' + 'X'.repeat(300), font, 11, 200);
    expect(lines.length).toBeGreaterThan(3);
    for (const l of lines) expect(font.widthOfTextAtSize(l, 11)).toBeLessThanOrEqual(200);
  });
});

describe('toWinAnsi', () => {
  it('keeps WinAnsi, strips accents it lacks and replaces the rest', () => {
    expect(toWinAnsi('Café – “quoted” €5 • ok')).toBe('Café – “quoted” €5 • ok');
    expect(toWinAnsi('Škoda Łódź')).toBe('Škoda Lódz');
    expect(toWinAnsi('≈ 5 → 6\t😀')).toBe('~ 5 -> 6 ?');
  });
});
