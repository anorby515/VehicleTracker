import { describe, expect, it } from 'vitest';
import { MAX_CANVAS_PIXELS, canvasScale, clampZoom, driveUrl, nextZoomStep, scrollForZoom } from './viewerMath';

describe('document viewer maths', () => {
  it('clamps zoom between 1× and 4×', () => {
    expect(clampZoom(0.5)).toBe(1);
    expect(clampZoom(2.2)).toBe(2.2);
    expect(clampZoom(9)).toBe(4);
    expect(clampZoom(NaN)).toBe(1);
  });

  it('steps the zoom buttons through fixed levels', () => {
    expect(nextZoomStep(1, 1)).toBe(1.5);
    expect(nextZoomStep(1.7, 1)).toBe(2);
    expect(nextZoomStep(4, 1)).toBe(4);
    expect(nextZoomStep(2, -1)).toBe(1.5);
    expect(nextZoomStep(1, -1)).toBe(1);
  });

  it('keeps the point under the fingers still while zooming', () => {
    // A point 100 px into the viewport, with the content scrolled 50 px, is at content x = 150.
    // At 2× that content point is at 300, so the new scroll is 300 − 100 = 200.
    expect(scrollForZoom({ left: 50, top: 0 }, { x: 100, y: 40 }, 1, 2)).toEqual({ left: 200, top: 40 });
    // Zooming back out never scrolls past the start.
    expect(scrollForZoom({ left: 0, top: 0 }, { x: 100, y: 100 }, 2, 1)).toEqual({ left: 0, top: 0 });
  });

  it('renders pages sharp at the device pixel ratio', () => {
    // A US Letter page (612 × 792 pt) shown 390 px wide on a 3× screen.
    const s = canvasScale(612, 792, 390, 3);
    expect(s).toBeCloseTo((390 * 3) / 612);
  });

  it('keeps canvases under the iOS 16.7 MP limit when zoomed in', () => {
    const s = canvasScale(612, 792, 390 * 4, 3); // 4× zoom on a 3× screen
    const pixels = Math.ceil(612 * s) * Math.ceil(792 * s);
    expect(pixels).toBeLessThanOrEqual(MAX_CANVAS_PIXELS);
    expect(s).toBeLessThan((390 * 4 * 3) / 612);
  });

  it('links to the file in Google Drive', () => {
    expect(driveUrl('abc_123-XYZ')).toBe('https://drive.google.com/file/d/abc_123-XYZ/view');
  });
});
