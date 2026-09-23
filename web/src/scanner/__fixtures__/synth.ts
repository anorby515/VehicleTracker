/**
 * Synthetic receipt photos for scanner tests (no real receipts anywhere).
 * A flat "paper" with fake text lines is warped onto a background with a
 * random perspective, so the true corners are known exactly.
 *
 * Kinds:
 * - dark:     plain dark surface (what the coaching card asks for)
 * - busy:     cluttered surface (random rectangles, lines, circles, noise)
 * - shadow:   a soft shadow across the scene, then blur
 * - crumpled: wavy paper edges, blotchy paper, crease lines
 * - faded:    pale paper, faint print, mid-tone surface
 */

import type { CV, Mat } from '../cv';
import { MatScope } from '../cv';
import { type Pt, type Quad, orderCorners } from '../geometry';

export type SynthKind = 'dark' | 'busy' | 'shadow' | 'crumpled' | 'faded';
export const SYNTH_KINDS: SynthKind[] = ['dark', 'busy', 'shadow', 'crumpled', 'faded'];

/** Deterministic PRNG (mulberry32). */
export function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthCase {
  kind: SynthKind;
  /** RGBA image; the caller must delete() it. */
  mat: Mat;
  truth: Quad;
  width: number;
  height: number;
  /** Paper and ink grey levels (for filter tests). */
  paperLevel: number;
  inkLevel: number;
}

const WORDS = ['OIL', 'CHANGE', 'FILTER', 'LABOR', 'TOTAL', 'TAX', 'ROTATE', 'TIRES', 'INSPECT', 'BRAKE', 'FLUID',
  'WIPER', 'BLADE', 'PARTS', 'SUBTOTAL', 'VISA', 'THANK', 'YOU', 'MILES', 'QTY', 'DATE', 'INVOICE', 'SHOP'];

/** Renders the flat paper (RGBA) with fake receipt text. */
export function renderPaper(cv: CV, rng: () => number, pw: number, ph: number, paper: number, ink: number): Mat {
  const m = new cv.Mat(ph, pw, cv.CV_8UC4, new cv.Scalar(paper, paper, paper - 2, 255));
  const inkC = new cv.Scalar(ink, ink, ink + 4, 255);
  const lineH = Math.max(14, Math.round(Math.min(pw, ph * 0.9) / 16));
  const margin = Math.round(pw * 0.08);
  const fontScale = lineH / 30;
  // Header.
  cv.putText(m, 'SAMPLE AUTO', new cv.Point(margin, margin + lineH), cv.FONT_HERSHEY_SIMPLEX, fontScale * 1.3, inkC, 2, cv.LINE_AA);
  for (let y = margin + lineH * 2.6; y < ph - margin; y += lineH * (1.1 + rng() * 0.4)) {
    if (rng() < 0.12) {
      cv.line(m, new cv.Point(margin, Math.round(y - lineH / 3)), new cv.Point(pw - margin, Math.round(y - lineH / 3)), inkC, 1);
      continue;
    }
    let text = '';
    const n = 1 + Math.floor(rng() * 3);
    for (let i = 0; i < n; i++) text += WORDS[Math.floor(rng() * WORDS.length)] + ' ';
    text += (rng() * 200).toFixed(2);
    cv.putText(m, text, new cv.Point(margin, Math.round(y)), cv.FONT_HERSHEY_SIMPLEX, fontScale, inkC, 1, cv.LINE_AA);
  }
  return m;
}

/** Random paper placement: portrait-ish, 1:1–1:4, ±25° rotation, mild perspective, fully in frame. */
function placePaper(rng: () => number, W: number, H: number): { quad: Quad; aspect: number; tall: boolean } {
  const aspect = 1 + rng() * 3;
  // People hold the phone so the receipt's long side runs along the frame's.
  const tall = (H >= W) === (rng() < 0.85);
  const theta = ((rng() * 50 - 25) * Math.PI) / 180;
  for (let attempt = 0; attempt < 60; attempt++) {
    const shrink = Math.pow(0.95, attempt);
    const f = (0.6 + rng() * 0.28) * shrink;
    let ph = (tall ? H : W) * f;
    let pw = ph / aspect;
    if (!tall) [pw, ph] = [ph, pw];
    const cx = W / 2 + (rng() - 0.5) * W * 0.16;
    const cy = H / 2 + (rng() - 0.5) * H * 0.16;
    const jit = 0.06 * Math.min(pw, ph);
    const base: Pt[] = [
      { x: -pw / 2, y: -ph / 2 }, { x: pw / 2, y: -ph / 2 }, { x: pw / 2, y: ph / 2 }, { x: -pw / 2, y: ph / 2 },
    ];
    const pts = base.map(p => ({
      x: cx + p.x * Math.cos(theta) - p.y * Math.sin(theta) + (rng() - 0.5) * 2 * jit,
      y: cy + p.x * Math.sin(theta) + p.y * Math.cos(theta) + (rng() - 0.5) * 2 * jit,
    }));
    const mx = W * 0.03, my = H * 0.03;
    if (pts.every(p => p.x > mx && p.x < W - mx && p.y > my && p.y < H - my)) {
      // Keep the paper's own corner order (tl of the paper = tl of the quad).
      return { quad: { tl: pts[0], tr: pts[1], br: pts[2], bl: pts[3] }, aspect, tall };
    }
  }
  throw new Error('could not place paper');
}

function gaussian(rng: () => number): number {
  const u = Math.max(1e-9, rng()), v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function addNoise(m: Mat, rng: () => number, sigma: number): void {
  const d = m.data;
  for (let i = 0; i < d.length; i += 4) {
    const n = gaussian(rng) * sigma;
    for (let c = 0; c < 3; c++) {
      const v = d[i + c] + n;
      d[i + c] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
}

export function makeCase(cv: CV, kind: SynthKind, seed: number, size?: { width: number; height: number }): SynthCase {
  const rng = makeRng(seed * 7919 + SYNTH_KINDS.indexOf(kind) * 104729);
  const portrait = rng() < 0.7;
  const W = size?.width ?? (portrait ? 600 : 800);
  const H = size?.height ?? (portrait ? 800 : 600);
  const s = new MatScope(cv);
  try {
    const { quad, aspect, tall } = placePaper(rng, W, H);

    // ---- background
    const bgLevel = kind === 'faded' ? 80 + rng() * 50 : kind === 'busy' ? 90 + rng() * 60 : 20 + rng() * 60;
    const tint = [bgLevel * (0.85 + rng() * 0.3), bgLevel * (0.85 + rng() * 0.3), bgLevel * (0.85 + rng() * 0.3)];
    const bg = new cv.Mat(H, W, cv.CV_8UC4, new cv.Scalar(tint[0], tint[1], tint[2], 255));
    if (kind === 'busy') {
      const col = () => new cv.Scalar(rng() * 190, rng() * 190, rng() * 190, 255);
      for (let i = 0; i < 70; i++) {
        const x = rng() * W, y = rng() * H, w = 10 + rng() * W * 0.3, h = 10 + rng() * H * 0.3;
        cv.rectangle(bg, new cv.Point(x, y), new cv.Point(x + w, y + h), col(), -1);
      }
      for (let i = 0; i < 30; i++) {
        cv.line(bg, new cv.Point(rng() * W, rng() * H), new cv.Point(rng() * W, rng() * H), col(), 1 + Math.floor(rng() * 4));
      }
      for (let i = 0; i < 20; i++) {
        cv.circle(bg, new cv.Point(rng() * W, rng() * H), 5 + rng() * 60, col(), -1);
      }
    } else if (kind === 'crumpled' || kind === 'dark') {
      // A little large-scale texture (wood/cloth-like streaks).
      for (let i = 0; i < 12; i++) {
        const y = rng() * H;
        const c = bgLevel * (0.8 + rng() * 0.4);
        cv.line(bg, new cv.Point(0, y), new cv.Point(W, y + (rng() - 0.5) * 80), new cv.Scalar(c, c * 0.9, c * 0.8, 255), 2 + Math.floor(rng() * 8));
      }
    }

    // ---- paper
    const paperLevel = kind === 'faded' ? 205 + rng() * 25 : 232 + rng() * 18;
    const inkLevel = kind === 'faded' ? paperLevel - (28 + rng() * 14) : 25 + rng() * 40;
    const long = 700;
    const pw = Math.round(tall ? long / aspect : long);
    const ph = Math.round(tall ? long : long / aspect);
    const paper = s.track(renderPaper(cv, rng, pw, ph, paperLevel, inkLevel));
    if (kind === 'crumpled') {
      // Blotchy intensity + creases.
      const low = s.mat(6, 5, cv.CV_8UC4);
      for (let i = 0; i < low.data.length; i += 4) {
        const v = 128 + (rng() - 0.5) * 70;
        low.data[i] = low.data[i + 1] = low.data[i + 2] = v;
        low.data[i + 3] = 128;
      }
      const up = s.mat();
      cv.resize(low, up, new cv.Size(pw, ph), 0, 0, cv.INTER_CUBIC);
      const pd = paper.data, ud = up.data;
      for (let i = 0; i < pd.length; i += 4) {
        const off = ud[i] - 128;
        for (let c = 0; c < 3; c++) pd[i + c] = Math.max(0, Math.min(255, pd[i + c] + off));
      }
      for (let i = 0; i < 4; i++) {
        const c = paperLevel - 25 - rng() * 25;
        cv.line(paper, new cv.Point(rng() * pw, 0), new cv.Point(rng() * pw, ph), new cv.Scalar(c, c, c, 255), 2);
      }
    }

    const srcPts = s.track(cv.matFromArray(4, 1, cv.CV_32FC2, [0, 0, pw, 0, pw, ph, 0, ph]));
    const dstPts = s.track(cv.matFromArray(4, 1, cv.CV_32FC2, [
      quad.tl.x, quad.tl.y, quad.tr.x, quad.tr.y, quad.br.x, quad.br.y, quad.bl.x, quad.bl.y,
    ]));
    const M = s.track(cv.getPerspectiveTransform(srcPts, dstPts));
    const warped = s.mat();
    cv.warpPerspective(paper, warped, M, new cv.Size(W, H), cv.INTER_LINEAR, cv.BORDER_CONSTANT, new cv.Scalar(0, 0, 0, 0));

    const mask = s.mat(H, W, cv.CV_8UC1);
    mask.setTo(new cv.Scalar(0));
    const poly: number[] = [];
    const corners = [quad.tl, quad.tr, quad.br, quad.bl];
    const wavy = kind === 'crumpled';
    const amp = wavy ? 0.004 * Math.hypot(W, H) : 0;
    for (let i = 0; i < 4; i++) {
      const a = corners[i], b = corners[(i + 1) % 4];
      const steps = wavy ? 40 : 1;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len;
      const phase = rng() * Math.PI * 2, freq = 2 + rng() * 3;
      for (let j = 0; j < steps; j++) {
        const t = j / steps;
        const off = wavy ? amp * Math.sin(phase + t * freq * Math.PI * 2) * Math.sin(t * Math.PI) : 0;
        poly.push(a.x + (b.x - a.x) * t + nx * off, a.y + (b.y - a.y) * t + ny * off);
      }
    }
    const polyMat = s.track(cv.matFromArray(poly.length / 2, 1, cv.CV_32SC2, poly.map(Math.round)));
    const pv = s.vec();
    pv.push_back(polyMat);
    cv.fillPoly(mask, pv, new cv.Scalar(255));
    warped.copyTo(bg, mask);

    // ---- lighting and optics
    if (kind === 'shadow') {
      const ang = rng() * Math.PI * 2;
      const dxs = Math.cos(ang), dys = Math.sin(ang);
      const dark = 0.4 + rng() * 0.2;
      const pos = (rng() - 0.5) * 0.4;
      const d = bg.data;
      const diag = Math.hypot(W, H);
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const t = ((x - W / 2) * dxs + (y - H / 2) * dys) / diag - pos;
          const f = dark + (1 - dark) / (1 + Math.exp(-t * 14));
          const i = (y * W + x) * 4;
          d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
        }
      }
      const k = 5 + 2 * Math.floor(rng() * 3);
      cv.GaussianBlur(bg, bg, new cv.Size(k, k), 0, 0, cv.BORDER_DEFAULT);
    } else {
      cv.GaussianBlur(bg, bg, new cv.Size(3, 3), 0, 0, cv.BORDER_DEFAULT);
    }
    addNoise(bg, rng, kind === 'busy' ? 8 : 3);

    return { kind, mat: bg, truth: orderCorners([quad.tl, quad.tr, quad.br, quad.bl]), width: W, height: H, paperLevel, inkLevel };
  } finally {
    s.release();
  }
}

/** Loads OpenCV.js in Node (tests). Resolves once the WASM runtime is ready. */
export async function loadCvForNode(): Promise<CV> {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const mod = require('@techstark/opencv-js') as CV & { then?: unknown };
  return new Promise<CV>(resolve => {
    const m = mod as unknown as { then?: (f: (x: CV) => void) => void; Mat?: unknown };
    if (m.Mat && typeof m.then !== 'function') { resolve(mod); return; }
    m.then!((ready: CV) => {
      // The module is a thenable that resolves to itself; drop `then` so
      // awaiting it doesn't loop forever.
      delete (ready as { then?: unknown }).then;
      resolve(ready);
    });
  });
}
