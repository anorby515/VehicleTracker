import { describe, expect, it } from 'vitest';
import { barLayout, compactMiles, compactMoney, linearScale, niceCeil, niceRangeTicks, niceTicks, roundedTopBarPath, wearLayout } from './charts';

const box = { width: 320, height: 160, top: 10, right: 10, bottom: 30, left: 40 };

describe('scales and ticks', () => {
  it('maps a domain onto a range, including inverted ranges', () => {
    const s = linearScale([0, 100], [200, 0]);
    expect(s(0)).toBe(200);
    expect(s(50)).toBe(100);
    expect(s(100)).toBe(0);
    expect(linearScale([5, 5], [0, 10])(5)).toBe(5);
  });

  it('rounds up to nice numbers', () => {
    expect(niceCeil(0.7)).toBe(1);
    expect(niceCeil(1.3)).toBe(2);
    expect(niceCeil(2.2)).toBe(2.5);
    expect(niceCeil(3)).toBe(5);
    expect(niceCeil(412)).toBe(500);
    expect(niceCeil(1000)).toBe(1000);
    expect(niceCeil(0)).toBe(0);
  });

  it('makes round ticks from zero that cover the maximum', () => {
    expect(niceTicks(1642.1)).toEqual([0, 500, 1000, 1500, 2000]);
    expect(niceTicks(9, 4)).toEqual([0, 2.5, 5, 7.5, 10]);
    expect(niceTicks(0)).toEqual([0]);
  });

  it('makes ticks inside a mileage range', () => {
    expect(niceRangeTicks(101300, 134120, 3)).toEqual([110000, 120000, 130000]);
    expect(niceRangeTicks(5, 5)).toEqual([5]);
  });

  it('compacts axis labels', () => {
    expect(compactMiles(52000)).toBe('52k');
    expect(compactMiles(1500)).toBe('1.5k');
    expect(compactMiles(800)).toBe('800');
    expect(compactMoney(1500)).toBe('$1.5k');
    expect(compactMoney(250)).toBe('$250');
  });
});

describe('barLayout', () => {
  const data = [
    { label: '2024', value: 0 },
    { label: '2025', value: 500 },
    { label: '2026', value: 1000 },
  ];

  it('grows bars from one baseline in proportion to their value', () => {
    const l = barLayout(data, box);
    expect(l.baseline).toBe(130);
    expect(l.max).toBe(1000);
    expect(l.bars[0].height).toBe(0);
    expect(l.bars[2].y).toBeCloseTo(10);
    expect(l.bars[2].height).toBeCloseTo(120);
    expect(l.bars[1].height).toBeCloseTo(60);
    for (const b of l.bars) expect(b.y + b.height).toBeCloseTo(130);
  });

  it('caps bar thickness and centres bars in their band', () => {
    const l = barLayout(data, box);
    const band = (320 - 50) / 3;
    for (const b of l.bars) {
      expect(b.width).toBe(24);
      expect(b.x + b.width / 2).toBeCloseTo(40 + band * b.index + band / 2);
    }
  });

  it('keeps a gap between bars when there are many', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ label: String(i), value: i }));
    const l = barLayout(many, box);
    const band = (320 - 50) / 30;
    expect(l.bars[0].width).toBeCloseTo(band - 2);
    expect(l.bars[1].x - (l.bars[0].x + l.bars[0].width)).toBeCloseTo(2);
  });

  it('puts ticks on the scale', () => {
    const l = barLayout(data, box);
    expect(l.ticks.map(t => t.value)).toEqual([0, 250, 500, 750, 1000]);
    expect(l.ticks[0].y).toBe(130);
    expect(l.ticks[4].y).toBeCloseTo(10);
  });

  it('draws a rounded data end and a square foot', () => {
    expect(roundedTopBarPath({ x: 0, y: 10, width: 20, height: 50 })).toBe('M0,60 V14 Q0,10 4,10 H16 Q20,10 20,14 V60 Z');
    expect(roundedTopBarPath({ x: 0, y: 60, width: 20, height: 0 })).toBe('');
  });
});

describe('wearLayout', () => {
  const readings = [
    { mileage: 30000, value: 8 },
    { mileage: 40000, value: 6 },
  ];

  it('scales readings from a zero floor and draws the replacement line', () => {
    const l = wearLayout(readings, 4, box);
    expect(l.yTicks.map(t => t.value)).toEqual([0, 2, 4, 6, 8]);
    expect(l.replaceY).toBeCloseTo(130 - (4 / 8) * 120);
    expect(l.points[0].y).toBeCloseTo(10);
    expect(l.points[0].x).toBeLessThan(l.points[1].x);
    expect(l.projection).toBeNull();
  });

  it('extends the x axis to the projected replacement mileage', () => {
    const l = wearLayout(readings, 4, box, 50000);
    expect(l.projection).not.toBeNull();
    expect(l.projection!.x2).toBeGreaterThan(l.points[1].x);
    expect(l.projection!.y2).toBeCloseTo(l.replaceY);
    expect(l.projection!.x2).toBeLessThanOrEqual(box.width - box.right);
  });

  it('handles a single reading', () => {
    const l = wearLayout([{ mileage: 30000, value: 7 }], 4, box);
    expect(l.points).toHaveLength(1);
    expect(isFinite(l.points[0].x)).toBe(true);
  });
});
