/**
 * "Upload a digital receipt": the picked files → the one PDF that goes to
 * the Inbox.
 *
 * - A single PDF is uploaded exactly as it is (same bytes).
 * - Several files become one PDF: every page of each PDF is copied in
 *   (pdf-lib copyPages) and each image is placed on its own page.
 * - Images must already be normalized to JPEG by the caller (HEIC and EXIF
 *   orientation are handled in the browser; see scanner/image.ts).
 */

import { PDFDocument } from 'pdf-lib';
import { type PageImage, type PdfMeta, addImagePage, setMeta, toBytes } from './assemble';

/** The App API's limit per visit. */
export const MAX_VISIT_BYTES = 25 * 1024 * 1024;
/** The App API accepts 1–40 pages. */
export const MAX_PAGES = 40;

export type CombineInput =
  | { kind: 'pdf'; name: string; data: Uint8Array | ArrayBuffer | Blob }
  | ({ kind: 'image'; name: string } & PageImage);

export class CombineError extends Error {
  constructor(message: string, readonly fileName?: string) {
    super(message);
    this.name = 'CombineError';
  }
}

export interface CombineResult {
  /** The PDF to upload. */
  pdf: Blob;
  pages: number;
  /** True when a single PDF went through untouched. */
  passthrough: boolean;
}

/** Page count of a PDF, or a friendly CombineError naming the file. */
export async function countPdfPages(data: Uint8Array | ArrayBuffer | Blob, name: string): Promise<number> {
  const doc = await loadPdf(await toBytes(data), name);
  return doc.getPageCount();
}

async function loadPdf(bytes: Uint8Array, name: string): Promise<PDFDocument> {
  try {
    return await PDFDocument.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  } catch {
    throw new CombineError(`We couldn’t open “${name}”. It may be damaged. Try saving it again from Mail, or scan the paper copy instead.`, name);
  }
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(n / 1024))} KB`;
}

export function tooLargeMessage(bytes: number): string {
  return `That’s ${formatBytes(bytes)}, and the limit for one visit is 25 MB. Remove a file or two and try again.`;
}

export async function combineFiles(files: CombineInput[], meta: PdfMeta): Promise<CombineResult> {
  if (!files.length) throw new CombineError('Pick at least one file.');

  // One PDF on its own: upload the original bytes untouched.
  if (files.length === 1 && files[0].kind === 'pdf') {
    const f = files[0];
    const bytes = await toBytes(f.data);
    if (bytes.byteLength > MAX_VISIT_BYTES) throw new CombineError(tooLargeMessage(bytes.byteLength));
    const pages = await countPdfPages(bytes, f.name);
    if (pages > MAX_PAGES) throw new CombineError(`“${f.name}” has ${pages} pages. The limit is ${MAX_PAGES} for one visit.`, f.name);
    const pdf = f.data instanceof Blob ? f.data : new Blob([bytes as BlobPart], { type: 'application/pdf' });
    return { pdf, pages, passthrough: true };
  }

  let total = 0;
  for (const f of files) total += f.kind === 'pdf' ? byteLength(f.data) : byteLength(f.jpeg);
  if (total > MAX_VISIT_BYTES) throw new CombineError(tooLargeMessage(total));

  const out = await PDFDocument.create();
  setMeta(out, meta);
  for (const f of files) {
    if (f.kind === 'image') {
      try {
        await addImagePage(out, f);
      } catch {
        throw new CombineError(`We couldn’t add the picture “${f.name}”. Try a different photo.`, f.name);
      }
      continue;
    }
    const src = await loadPdf(await toBytes(f.data), f.name);
    if (src.isEncrypted) {
      throw new CombineError(`“${f.name}” is password-protected, so it can’t be combined with other files. Upload it on its own.`, f.name);
    }
    try {
      const copied = await out.copyPages(src, src.getPageIndices());
      copied.forEach(p => out.addPage(p));
    } catch {
      throw new CombineError(`We couldn’t copy the pages of “${f.name}”. Try uploading it on its own.`, f.name);
    }
  }
  const pages = out.getPageCount();
  if (pages > MAX_PAGES) throw new CombineError(`That’s ${pages} pages. The limit is ${MAX_PAGES} for one visit.`);
  const bytes = await out.save();
  if (bytes.byteLength > MAX_VISIT_BYTES) throw new CombineError(tooLargeMessage(bytes.byteLength));
  return { pdf: new Blob([bytes as BlobPart], { type: 'application/pdf' }), pages, passthrough: false };
}

function byteLength(d: Uint8Array | ArrayBuffer | Blob): number {
  return d instanceof Blob ? d.size : d.byteLength;
}
