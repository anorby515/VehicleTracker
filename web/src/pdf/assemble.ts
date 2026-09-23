/**
 * Scanned pages → one PDF (pdf-lib). Each page is a JPEG (about 2,000 px on
 * the long edge, quality ~0.8, roughly 1 MB) placed on a page 612 pt wide —
 * US Letter width — with the image's own aspect, so printed text comes out
 * at a natural size and nothing is cropped or letterboxed.
 */

import { PDFDocument } from 'pdf-lib';
import { toWinAnsi } from './winansi';

export const PAGE_WIDTH_PT = 612;
/** PDF viewers refuse pages taller than 200 inches. */
const MAX_PAGE_PT = 14_400;
export const PDF_CREATOR = 'Vehicles app';

export interface PageImage {
  /** JPEG bytes. */
  jpeg: Uint8Array | ArrayBuffer | Blob;
  width: number;
  height: number;
}

export interface PdfMeta {
  title: string;
  author?: string;
  subject?: string;
  createdAt?: Date;
}

export function pageSizeFor(width: number, height: number): { width: number; height: number } {
  const h = PAGE_WIDTH_PT * (height / Math.max(1, width));
  if (h <= MAX_PAGE_PT) return { width: PAGE_WIDTH_PT, height: h };
  return { width: PAGE_WIDTH_PT * (MAX_PAGE_PT / h), height: MAX_PAGE_PT };
}

export async function toBytes(data: Uint8Array | ArrayBuffer | Blob): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  return new Uint8Array(await data.arrayBuffer());
}

export function setMeta(doc: PDFDocument, meta: PdfMeta): void {
  const at = meta.createdAt ?? new Date();
  doc.setTitle(toWinAnsi(meta.title), { showInWindowTitleBar: true });
  if (meta.author) doc.setAuthor(toWinAnsi(meta.author));
  if (meta.subject) doc.setSubject(toWinAnsi(meta.subject));
  doc.setCreator(PDF_CREATOR);
  doc.setProducer(PDF_CREATOR);
  doc.setCreationDate(at);
  doc.setModificationDate(at);
}

/** Adds one full-page image page (JPEG). */
export async function addImagePage(doc: PDFDocument, img: PageImage): Promise<void> {
  const jpg = await doc.embedJpg(await toBytes(img.jpeg));
  const size = pageSizeFor(img.width || jpg.width, img.height || jpg.height);
  const page = doc.addPage([size.width, size.height]);
  page.drawImage(jpg, { x: 0, y: 0, width: size.width, height: size.height });
}

/** Builds the scan PDF. Throws if there are no pages. */
export async function assemblePdf(pages: PageImage[], meta: PdfMeta): Promise<Uint8Array> {
  if (!pages.length) throw new Error('There are no pages to save.');
  const doc = await PDFDocument.create();
  setMeta(doc, meta);
  for (const p of pages) await addImagePage(doc, p);
  return doc.save();
}
