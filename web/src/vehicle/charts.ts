/**
 * Geometry for the small SVG charts (Costs: spend per year; Wear: readings
 * against mileage). Pure functions so the scaling is unit-tested; the
 * components only draw what these return.
 */

/** Maps a domain [d0, d1] linearly onto a range [r0, r1]. A zero-width domain maps to the range's middle. */
export function linearScale(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => (r0 + r1) / 2;
  const k = (r1 - r0) / (d1 - d0);
  return v => r0 + (v - d0) * k;
}

/** The smallest "nice" number (1, 2, 2.5, 5 × 10^k) at or above `n`. */
export function niceCeil(n: number): number {
  if (!(n > 0) || !isFinite(n)) return 0;
  const exp = Math.floor(Math.log10(n));
  const base = 10 ** exp;
  for (const m of [1, 2, 2.5, 5, 10]) {
    const v = m * base;
    if (v >= n - base * 1e-9) return Number(v.toPrecision(12));
  }
  return 10 * base;
}

/**
 * Evenly spaced round ticks from 0 to a nice maximum covering `max`
 * (about `count` intervals). [0] when max is 0.
 */
export function niceTicks(max: number, count = 4): number[] {
  if (!(max > 0) || !isFinite(max)) return [0];
  const step = niceCeil(max / count);
  const top = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let v = 0; v <= top + step * 1e-9; v += step) ticks.push(Number(v.toPrecision(12)));
  return ticks;
}

/** The nearest "nice" step (1, 2, 5 × 10^k) to `n`, for ticks inside a range. */
export function niceStep(n: number): number {
  if (!(n > 0) || !isFinite(n)) return 1;
  const base = 10 ** Math.floor(Math.log10(n));
  const f = n / base;
  const m = f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10;
  return m * base;
}

/** Ticks between lo and hi (any start), at a nice step, including both ends when they land on the step. */
export function niceRangeTicks(lo: number, hi: number, count = 4): number[] {
  if (!isFinite(lo) || !isFinite(hi)) return [];
  if (hi <= lo) return [lo];
  const step = niceStep((hi - lo) / count);
  const start = Math.ceil(lo / step - 1e-9) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

export interface ChartBox {
  width: number;
  height: number;
  /** Plot insets for axis labels. */
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface Bar {
  index: number;
  label: string;
  value: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BarLayout {
  bars: Bar[];
  ticks: { value: number; y: number }[];
  baseline: number;
  max: number;
}

/**
 * Column chart layout: one bar per value from a shared zero baseline, bar
 * thickness capped (leftover band is air), y ticks at round numbers.
 */
export function barLayout(
  data: { label: string; value: number }[],
  box: ChartBox,
  opts: { maxBarWidth?: number; gap?: number; tickCount?: number } = {},
): BarLayout {
  const maxBar = opts.maxBarWidth ?? 24;
  const gap = opts.gap ?? 2;
  const plotW = Math.max(0, box.width - box.left - box.right);
  const plotH = Math.max(0, box.height - box.top - box.bottom);
  const baseline = box.top + plotH;
  const values = data.map(d => (isFinite(d.value) && d.value > 0 ? d.value : 0));
  const ticksV = niceTicks(Math.max(0, ...values), opts.tickCount ?? 4);
  const max = ticksV[ticksV.length - 1] || 1;
  const y = linearScale([0, max], [baseline, box.top]);
  const band = data.length ? plotW / data.length : 0;
  const width = Math.max(1, Math.min(maxBar, band - gap));
  const bars = data.map((d, i) => {
    const v = values[i];
    const top = y(v);
    return {
      index: i,
      label: d.label,
      value: d.value,
      x: box.left + band * i + (band - width) / 2,
      y: top,
      width,
      height: baseline - top,
    };
  });
  return { bars, ticks: ticksV.map(v => ({ value: v, y: y(v) })), baseline, max };
}

/**
 * SVG path for a column with a rounded data end (radius r, clamped to the
 * bar) and a square foot on the baseline. Zero-height bars draw nothing.
 */
export function roundedTopBarPath(b: Pick<Bar, 'x' | 'y' | 'width' | 'height'>, r = 4): string {
  if (b.height <= 0 || b.width <= 0) return '';
  const rr = Math.max(0, Math.min(r, b.width / 2, b.height));
  const x0 = b.x, x1 = b.x + b.width, y0 = b.y, y1 = b.y + b.height;
  const f = (n: number) => Number(n.toFixed(2));
  return [
    `M${f(x0)},${f(y1)}`,
    `V${f(y0 + rr)}`,
    `Q${f(x0)},${f(y0)} ${f(x0 + rr)},${f(y0)}`,
    `H${f(x1 - rr)}`,
    `Q${f(x1)},${f(y0)} ${f(x1)},${f(y0 + rr)}`,
    `V${f(y1)}`,
    'Z',
  ].join(' ');
}

export interface WearPoint { mileage: number; value: number }

export interface WearLayout {
  points: { x: number; y: number; mileage: number; value: number }[];
  /** y of the replacement point line. */
  replaceY: number;
  /** Projection segment from the last reading to the replacement point, when given. */
  projection: { x1: number; y1: number; x2: number; y2: number } | null;
  xTicks: { value: number; x: number }[];
  yTicks: { value: number; y: number }[];
  x: (m: number) => number;
  y: (v: number) => number;
}

/**
 * Readings against mileage with the replacement line. The y axis starts at 0
 * and covers the highest reading and the replacement point; the x axis
 * covers the readings and, when given, the projected replacement mileage.
 */
export function wearLayout(
  readings: WearPoint[],
  replacementPoint: number,
  box: ChartBox,
  projectionMileage: number | null = null,
): WearLayout {
  const pts = readings.filter(p => isFinite(p.mileage) && isFinite(p.value));
  const miles = pts.map(p => p.mileage);
  if (projectionMileage !== null && isFinite(projectionMileage)) miles.push(projectionMileage);
  let lo = miles.length ? Math.min(...miles) : 0;
  let hi = miles.length ? Math.max(...miles) : 1;
  if (hi === lo) { lo = Math.max(0, lo - 1000); hi = hi + 1000; }
  const pad = (hi - lo) * 0.04;
  const xDomain: [number, number] = [lo - pad, hi + pad];
  const yMax = niceTicks(Math.max(replacementPoint, ...pts.map(p => p.value)), 4);
  const top = yMax[yMax.length - 1] || 1;
  const x = linearScale(xDomain, [box.left, box.width - box.right]);
  const y = linearScale([0, top], [box.height - box.bottom, box.top]);
  const points = pts.map(p => ({ x: x(p.mileage), y: y(p.value), mileage: p.mileage, value: p.value }));
  const last = points[points.length - 1];
  const projection = projectionMileage !== null && last && isFinite(projectionMileage)
    ? { x1: last.x, y1: last.y, x2: x(projectionMileage), y2: y(replacementPoint) }
    : null;
  return {
    points,
    replaceY: y(replacementPoint),
    projection,
    xTicks: niceRangeTicks(lo, hi, 3).map(v => ({ value: v, x: x(v) })),
    yTicks: yMax.map(v => ({ value: v, y: y(v) })),
    x,
    y,
  };
}

/** Compact mileage for axis ticks: 52000 → "52k", 1500 → "1.5k", 800 → "800". */
export function compactMiles(n: number): string {
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return `${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
  }
  return String(Math.round(n));
}

/** Compact dollars for axis ticks: 1500 → "$1.5k", 250 → "$250". */
export function compactMoney(n: number): string {
  if (Math.abs(n) >= 1000) {
    const k = n / 1000;
    return `$${Number.isInteger(k) ? k : Math.round(k * 10) / 10}k`;
  }
  return `$${Math.round(n)}`;
}
