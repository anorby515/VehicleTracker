/**
 * Browser image helpers for the scanner and the digital-upload tray.
 *
 * - Every picked or captured image is decoded here (createImageBitmap with
 *   EXIF orientation, falling back to <img>), which also turns HEIC from
 *   the iOS picker into pixels; it is re-encoded as JPEG.
 * - iOS limits: a canvas over 16.7 MP is refused and total canvas memory is
 *   ~384 MB, so sizes are capped and canvases are freed (width = height = 0)
 *   as soon as they're done.
 */

import type { CV, Mat } from './cv';

/** Stills are decoded at most this big (a 4K frame is 8.3 MP). */
export const MAX_SOURCE_PIXELS = 12_000_000;

export function freeCanvas(c: HTMLCanvasElement | OffscreenCanvas | null | undefined): void {
  if (!c) return;
  c.width = 0;
  c.height = 0;
}

export function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(width));
  c.height = Math.max(1, Math.round(height));
  return c;
}

export function ctx2d(c: HTMLCanvasElement, willReadFrequently = false): CanvasRenderingContext2D {
  const g = c.getContext('2d', { willReadFrequently });
  if (!g) throw new Error('This phone ran out of memory for the scanner. Close other apps and try again.');
  return g;
}

export function canvasToBlob(c: HTMLCanvasElement, type = 'image/jpeg', quality = 0.85): Promise<Blob> {
  return new Promise((resolve, reject) => {
    c.toBlob(b => (b ? resolve(b) : reject(new Error('Couldn’t save the picture.'))), type, quality);
  });
}

type Drawable = ImageBitmap | HTMLImageElement | HTMLCanvasElement | HTMLVideoElement;

function sizeOf(d: Drawable): { width: number; height: number } {
  if (d instanceof HTMLVideoElement) return { width: d.videoWidth, height: d.videoHeight };
  if (d instanceof HTMLImageElement) return { width: d.naturalWidth, height: d.naturalHeight };
  return { width: d.width, height: d.height };
}

/** Size that fits `maxLong` on the long edge and `maxPixels` in area (never enlarges). */
export function fitSize(width: number, height: number, maxLong = Infinity, maxPixels = MAX_SOURCE_PIXELS): { width: number; height: number } {
  let s = Math.min(1, maxLong / Math.max(width, height, 1));
  if (width * height * s * s > maxPixels) s = Math.sqrt(maxPixels / (width * height));
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

/** Draws anything drawable into a new canvas that fits the limits. */
export function drawScaled(src: Drawable, maxLong = Infinity, maxPixels = MAX_SOURCE_PIXELS): HTMLCanvasElement {
  const n = sizeOf(src);
  const { width, height } = fitSize(n.width, n.height, maxLong, maxPixels);
  const c = makeCanvas(width, height);
  const g = ctx2d(c);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(src, 0, 0, width, height);
  return c;
}

async function decodeWithImg(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The decoded pixels stay usable after revoking.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

/**
 * Decodes an image file (JPEG, PNG, HEIC on iOS 17+) upright into a canvas,
 * at most `maxLong` on the long edge.
 */
export async function decodeToCanvas(blob: Blob, maxLong = Infinity): Promise<HTMLCanvasElement> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
      try {
        return drawScaled(bmp, maxLong);
      } finally {
        bmp.close();
      }
    } catch {
      /* fall back to <img> */
    }
  }
  try {
    return drawScaled(await decodeWithImg(blob), maxLong);
  } catch {
    throw new Error('That picture couldn’t be opened. Try a different photo.');
  }
}

export interface JpegImage { jpeg: Blob; width: number; height: number }

/** Any picked image → an upright JPEG, long edge ≤ `maxLong`. */
export async function normalizeImage(blob: Blob, maxLong = 2400, quality = 0.85): Promise<JpegImage> {
  const c = await decodeToCanvas(blob, maxLong);
  try {
    return { jpeg: await canvasToBlob(c, 'image/jpeg', quality), width: c.width, height: c.height };
  } finally {
    freeCanvas(c);
  }
}

/** A small JPEG object URL for tray thumbnails. The caller revokes it. */
export async function thumbnailUrl(src: HTMLCanvasElement | Blob, maxLong = 320): Promise<string> {
  const c = src instanceof Blob ? await decodeToCanvas(src, maxLong) : drawScaled(src, maxLong);
  try {
    return URL.createObjectURL(await canvasToBlob(c, 'image/jpeg', 0.8));
  } finally {
    freeCanvas(c);
  }
}

/** Canvas pixels → a new RGBA Mat (caller deletes). */
export function matFromCanvas(cv: CV, c: HTMLCanvasElement): Mat {
  const img = ctx2d(c, true).getImageData(0, 0, c.width, c.height);
  return cv.matFromImageData(img);
}

/** Any 8-bit Mat → a new canvas (grey and RGB are expanded to RGBA). */
export function matToCanvas(cv: CV, m: Mat): HTMLCanvasElement {
  let rgba = m;
  let temp: Mat | null = null;
  if (m.channels() !== 4) {
    temp = new cv.Mat();
    cv.cvtColor(m, temp, m.channels() === 1 ? cv.COLOR_GRAY2RGBA : cv.COLOR_RGB2RGBA);
    rgba = temp;
  }
  try {
    const c = makeCanvas(rgba.cols, rgba.rows);
    const img = new ImageData(new Uint8ClampedArray(rgba.data), rgba.cols, rgba.rows);
    ctx2d(c).putImageData(img, 0, 0);
    return c;
  } finally {
    temp?.delete();
  }
}
