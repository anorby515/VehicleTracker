/**
 * Lazy pdf.js loader shared by the document viewer and the upload review tray.
 * The LEGACY build is required: the modern build of pdfjs-dist 6 calls APIs
 * (Math.sumPrecise, Promise.try…) that iOS Safari lacks. The worker is a
 * separate file fetched on first use (and cached by the service worker).
 * Never show PDFs in <iframe>/<embed>: iOS renders only page 1 there.
 */

import type * as PdfJs from 'pdfjs-dist';

let pdfjsPromise: Promise<typeof PdfJs> | null = null;

export function loadPdfJs(): Promise<typeof PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const [lib, worker] = await Promise.all([
        import('pdfjs-dist/legacy/build/pdf.min.mjs') as Promise<typeof PdfJs>,
        import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
      ]);
      lib.GlobalWorkerOptions.workerSrc = (worker as { default: string }).default;
      return lib;
    })();
    pdfjsPromise.catch(() => { pdfjsPromise = null; });
  }
  return pdfjsPromise;
}

/** Opens a PDF from bytes. The caller must call `destroy()` when done. */
export async function openPdf(data: ArrayBuffer | Uint8Array): Promise<PdfJs.PDFDocumentProxy> {
  const pdfjs = await loadPdfJs();
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  return pdfjs.getDocument({ data: bytes }).promise;
}

/** Renders one page (1-based) to a canvas scaled to `width` CSS px at the device pixel ratio. */
export async function renderPage(
  doc: PdfJs.PDFDocumentProxy,
  pageNumber: number,
  width: number,
  canvas: HTMLCanvasElement = document.createElement('canvas'),
): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(pageNumber);
  const base = page.getViewport({ scale: 1 });
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const viewport = page.getViewport({ scale: (width / base.width) * dpr });
  canvas.width = Math.floor(viewport.width);
  canvas.height = Math.floor(viewport.height);
  canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
  canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
  await page.render({ canvas, viewport }).promise;
  page.cleanup();
  return canvas;
}
