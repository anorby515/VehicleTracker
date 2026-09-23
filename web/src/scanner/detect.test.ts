// @vitest-environment node
import { beforeAll, describe, expect, it } from 'vitest';
import type { CV } from './cv';
import { liveScopedMats } from './cv';
import { detectDocument } from './detect';
import { maxCornerDistance, orderCorners, quadPoints } from './geometry';
import { SYNTH_KINDS, loadCvForNode, makeCase, type SynthKind } from './__fixtures__/synth';

let cv: CV;
beforeAll(async () => { cv = await loadCvForNode(); }, 60_000);

const PER_KIND = 8;

describe('detectDocument on synthetic receipts', () => {
  it('finds the corners within 3% of the image diagonal on at least 85% of cases', () => {
    const results: { kind: SynthKind; seed: number; err: number; ok: boolean; conf: number; strategy: string }[] = [];
    for (const kind of SYNTH_KINDS) {
      for (let seed = 1; seed <= PER_KIND; seed++) {
        const c = makeCase(cv, kind, seed);
        try {
          const d = detectDocument(cv, c.mat, { workSize: 800 });
          const err = maxCornerDistance(d.quad, c.truth) / Math.hypot(c.width, c.height);
          results.push({ kind, seed, err, ok: err <= 0.03, conf: d.confidence, strategy: d.strategy });
        } finally {
          c.mat.delete();
        }
      }
    }
    const byKind = SYNTH_KINDS.map(k => {
      const r = results.filter(x => x.kind === k);
      return `${k} ${r.filter(x => x.ok).length}/${r.length}`;
    });
    const passed = results.filter(r => r.ok).length;
    const accuracy = passed / results.length;
    // Reported in the test output (and the build report).
    console.info(`[scanner] detection accuracy ${passed}/${results.length} = ${(accuracy * 100).toFixed(1)}% (${byKind.join(', ')})`);
    for (const r of results.filter(x => !x.ok)) {
      console.info(`[scanner] miss ${r.kind}#${r.seed}: error ${(r.err * 100).toFixed(1)}% conf ${r.conf.toFixed(2)} via ${r.strategy}`);
    }
    expect(results.length).toBeGreaterThanOrEqual(20);
    expect(accuracy).toBeGreaterThanOrEqual(0.85);
    expect(liveScopedMats()).toBe(0);
  }, 120_000);

  it('works at the live-preview working size too', () => {
    let ok = 0, n = 0;
    for (const kind of SYNTH_KINDS) {
      for (let seed = 101; seed <= 104; seed++) {
        const c = makeCase(cv, kind, seed);
        try {
          const d = detectDocument(cv, c.mat, { workSize: 480 });
          const err = maxCornerDistance(d.quad, c.truth) / Math.hypot(c.width, c.height);
          n++;
          if (err <= 0.03) ok++;
        } finally {
          c.mat.delete();
        }
      }
    }
    console.info(`[scanner] preview-size accuracy ${ok}/${n}`);
    expect(ok / n).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it('returns corners in tl, tr, br, bl order in source pixels', () => {
    const c = makeCase(cv, 'dark', 3, { width: 1200, height: 1600 });
    try {
      const d = detectDocument(cv, c.mat);
      expect(d.found).toBe(true);
      expect(orderCorners(quadPoints(d.quad))).toEqual(d.quad);
      expect(maxCornerDistance(d.quad, c.truth) / Math.hypot(1200, 1600)).toBeLessThan(0.03);
    } finally {
      c.mat.delete();
    }
  });

  it('never throws or leaks on blank and degenerate images', () => {
    const makers: [string, () => ReturnType<CV['matFromArray']>][] = [
      ['black', () => new cv.Mat(480, 360, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 255))],
      ['white', () => new cv.Mat(480, 360, cv.CV_8UC4, new cv.Scalar(255, 255, 255, 255))],
      ['grey', () => new cv.Mat(300, 400, cv.CV_8UC1, new cv.Scalar(128))],
      ['rgb', () => new cv.Mat(200, 200, cv.CV_8UC3, new cv.Scalar(40, 80, 120))],
      ['tiny', () => new cv.Mat(3, 2, cv.CV_8UC4, new cv.Scalar(9, 9, 9, 255))],
      ['empty', () => new cv.Mat()],
      ['noise', () => {
        const m = new cv.Mat(600, 450, cv.CV_8UC4);
        for (let i = 0; i < m.data.length; i++) m.data[i] = (i * 2654435761) >>> 24;
        return m;
      }],
      ['gradient', () => {
        const m = new cv.Mat(400, 300, cv.CV_8UC1);
        for (let i = 0; i < m.data.length; i++) m.data[i] = Math.floor((i % 300) * 255 / 300);
        return m;
      }],
    ];
    const heapBefore = (cv as unknown as { HEAP8: Int8Array }).HEAP8.buffer.byteLength;
    for (let round = 0; round < 3; round++) {
      for (const [name, make] of makers) {
        const m = make();
        try {
          const d = detectDocument(cv, m);
          expect(d, name).toBeTruthy();
          expect(d.found, name).toBe(false);
          expect(d.confidence, name).toBeLessThan(0.3);
          if (m.cols > 0) {
            // Default = 8% inset rectangle.
            expect(d.quad.tl.x).toBeCloseTo(m.cols * 0.08, 5);
          }
        } finally {
          m.delete();
        }
      }
    }
    expect(liveScopedMats()).toBe(0);
    // Repeated runs reuse freed memory instead of growing the WASM heap.
    for (let i = 0; i < 20; i++) {
      const c = makeCase(cv, 'busy', 500 + i);
      try { detectDocument(cv, c.mat); } finally { c.mat.delete(); }
    }
    const heapAfter = (cv as unknown as { HEAP8: Int8Array }).HEAP8.buffer.byteLength;
    expect(heapAfter).toBeLessThanOrEqual(heapBefore * 1.5);
    expect(liveScopedMats()).toBe(0);
  }, 120_000);
});
