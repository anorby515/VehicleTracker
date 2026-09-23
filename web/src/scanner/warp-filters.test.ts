// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import type { CV, Mat } from './cv';
import { liveScopedMats } from './cv';
import { outputSize, warpQuad } from './warp';
import { applyFilter } from './filters';
import type { Quad } from './geometry';
import { loadCvForNode, makeRng, renderPaper } from './__fixtures__/synth';

let cv: CV;
beforeAll(async () => { cv = await loadCvForNode(); }, 60_000);

function meanWhere(img: Mat, mask: Uint8Array, want: boolean): number {
  let sum = 0, n = 0;
  const ch = img.channels();
  for (let i = 0; i < mask.length; i++) {
    if ((mask[i] > 0) === want) { sum += img.data[i * ch]; n++; }
  }
  return n ? sum / n : NaN;
}

describe('warpQuad', () => {
  it('sizes the page from the quad edges with the long edge ≈ 2000 px', () => {
    const q: Quad = { tl: { x: 100, y: 50 }, tr: { x: 500, y: 60 }, br: { x: 520, y: 1260 }, bl: { x: 90, y: 1250 } };
    const { width, height } = outputSize(q);
    expect(height).toBeGreaterThan(width);
    expect(height / width).toBeCloseTo(1210 / 430, 1);
    // Aspect ≈ 2.8 → a little more than 2,000 px for a long receipt.
    expect(height).toBeGreaterThanOrEqual(2000);
    expect(height).toBeLessThanOrEqual(3500);
    const letter: Quad = { tl: { x: 0, y: 0 }, tr: { x: 850, y: 0 }, br: { x: 850, y: 1100 }, bl: { x: 0, y: 1100 } };
    expect(outputSize(letter).height).toBe(2000);
    expect(outputSize(letter).width * outputSize(letter).height).toBeLessThan(16_777_216);
  });

  it('flattens a tilted page upright, keeping top-left at top-left', () => {
    // A flat page with a black square in its top-left quarter…
    const pw = 400, ph = 600;
    const flat = new cv.Mat(ph, pw, cv.CV_8UC4, new cv.Scalar(240, 240, 240, 255));
    cv.rectangle(flat, new cv.Point(20, 20), new cv.Point(140, 140), new cv.Scalar(0, 0, 0, 255), -1);
    // …placed in a frame with perspective.
    const q: Quad = { tl: { x: 210, y: 120 }, tr: { x: 560, y: 180 }, br: { x: 500, y: 760 }, bl: { x: 140, y: 700 } };
    const srcPts = cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, pw, 0, pw, ph, 0, ph]);
    const dstPts = cv.matFromArray(4, 1, cv.CV_32FC2, [q.tl.x, q.tl.y, q.tr.x, q.tr.y, q.br.x, q.br.y, q.bl.x, q.bl.y]);
    const M = cv.getPerspectiveTransform(srcPts, dstPts);
    const frame = new cv.Mat();
    cv.warpPerspective(flat, frame, M, new cv.Size(720, 900), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(30, 30, 30, 255));
    const out = warpQuad(cv, frame, q);
    try {
      expect(out.rows).toBeGreaterThan(out.cols);
      expect(Math.max(out.rows, out.cols)).toBeGreaterThanOrEqual(1000);
      const at = (fx: number, fy: number) => out.data[(Math.floor(out.rows * fy) * out.cols + Math.floor(out.cols * fx)) * 4];
      expect(at(0.2, 0.13)).toBeLessThan(60);   // the square, top-left
      expect(at(0.8, 0.13)).toBeGreaterThan(200); // top-right is paper
      expect(at(0.2, 0.87)).toBeGreaterThan(200); // bottom-left is paper
    } finally {
      [flat, srcPts, dstPts, M, frame, out].forEach(m => m.delete());
    }
    expect(liveScopedMats()).toBe(0);
  });
});

describe('cleanup filters', () => {
  /** Faint print on pale paper under a strong left-to-right shadow. */
  function shadedPage(): { page: Mat; textMask: Uint8Array } {
    const pw = 600, ph = 900;
    const page = renderPaper(cv, makeRng(42), pw, ph, 222, 190);
    const ref = renderPaper(cv, makeRng(42), pw, ph, 255, 0);
    const textMask = new Uint8Array(pw * ph);
    for (let i = 0; i < textMask.length; i++) textMask[i] = ref.data[i * 4] < 128 ? 1 : 0;
    ref.delete();
    for (let y = 0; y < ph; y++) {
      for (let x = 0; x < pw; x++) {
        const f = 0.5 + 0.5 * (x / pw);
        const i = (y * pw + x) * 4;
        page.data[i] *= f; page.data[i + 1] *= f; page.data[i + 2] *= f;
      }
    }
    return { page, textMask };
  }

  /** Background pixels well away from any print. */
  function backgroundMask(textMask: Uint8Array, w: number, h: number): Uint8Array {
    const m = new Uint8Array(textMask.length);
    for (let y = 6; y < h - 6; y++) {
      for (let x = 6; x < w - 6; x++) {
        let near = false;
        for (let dy = -5; dy <= 5 && !near; dy++) for (let dx = -5; dx <= 5 && !near; dx++) near = textMask[(y + dy) * w + x + dx] === 1;
        m[y * w + x] = near ? 0 : 1;
      }
    }
    return m;
  }

  it('Document: white, evenly lit background with print clearly darker', () => {
    const { page, textMask } = shadedPage();
    const w = page.cols, h = page.rows;
    const bgMask = backgroundMask(textMask, w, h);
    const left = new Uint8Array(bgMask.length), right = new Uint8Array(bgMask.length);
    for (let i = 0; i < bgMask.length; i++) {
      if (!bgMask[i]) continue;
      if (i % w < w * 0.25) left[i] = 1;
      if (i % w > w * 0.75) right[i] = 1;
    }
    const beforeGap = Math.abs(meanWhere(page, left, true) - meanWhere(page, right, true));
    const out = applyFilter(cv, page, 'document');
    try {
      expect(out.channels()).toBe(4);
      expect(out.rows).toBe(h);
      const bg = meanWhere(out, bgMask, true);
      const text = meanWhere(out, textMask, true);
      expect(bg).toBeGreaterThan(235);
      expect(text).toBeLessThan(bg - 70);
      // Lighting evened out.
      const afterGap = Math.abs(meanWhere(out, left, true) - meanWhere(out, right, true));
      expect(beforeGap).toBeGreaterThan(60);
      expect(afterGap).toBeLessThan(12);
      // Not hard-binarized: intermediate grey levels survive (anti-aliased strokes).
      const levels = new Set<number>();
      for (let i = 0; i < out.data.length; i += 4) levels.add(out.data[i]);
      expect(levels.size).toBeGreaterThan(40);
    } finally {
      page.delete();
      out.delete();
    }
    expect(liveScopedMats()).toBe(0);
  });

  it('Photo: keeps colour and stretches levels a little', () => {
    const m = new cv.Mat(100, 100, cv.CV_8UC4, new cv.Scalar(120, 90, 60, 255));
    cv.rectangle(m, new cv.Point(0, 0), new cv.Point(49, 99), new cv.Scalar(170, 140, 110, 255), -1);
    const out = applyFilter(cv, m, 'photo');
    try {
      const px = (x: number, y: number) => Array.from(out.data.slice((y * 100 + x) * 4, (y * 100 + x) * 4 + 4));
      const [r1, g1, b1, a1] = px(20, 50);
      const [r2, , b2] = px(80, 50);
      expect(a1).toBe(255);
      expect(r1).toBeGreaterThan(b1); // still warm
      expect(r1 - r2).toBeGreaterThan(50); // more contrast than before
      expect(g1).toBeGreaterThan(0);
      expect(b2).toBeLessThan(60);
    } finally {
      m.delete();
      out.delete();
    }
  });
});
