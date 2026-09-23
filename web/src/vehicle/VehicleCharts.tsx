/**
 * Small accessible SVG charts. Each has a <title>/<desc>, a visually hidden
 * data table for VoiceOver, round axis ticks, and tap-to-read values (the
 * touch version of a hover tooltip). Marks use the tint; text uses text
 * tokens, never the mark colour.
 */

import type { JSX } from 'preact';
import { useId, useState } from 'preact/hooks';
import type { WearItem } from '../api/types';
import { formatDate, formatMiles, formatMoney } from '../lib/format';
import { barLayout, compactMiles, compactMoney, roundedTopBarPath, wearLayout, type ChartBox } from './charts';
import { formatWearValue } from './display';

const W = 340;

// ---------------------------------------------------------------- spend per year

export function SpendByYearChart(props: { data: { year: number; total: number }[]; title: string }): JSX.Element {
  const id = useId();
  const data = props.data;
  const lastSpent = data.reduce((last, d, i) => (d.total > 0 ? i : last), data.length - 1);
  const [sel, setSel] = useState<number>(Math.max(0, lastSpent));
  const [touched, setTouched] = useState(false);
  const box: ChartBox = { width: W, height: 170, top: 12, right: 6, bottom: 24, left: 44 };
  const layout = barLayout(data.map(d => ({ label: String(d.year), value: d.total })), box);
  // Label years sparsely when there are many bars.
  const every = data.length > 8 ? Math.ceil(data.length / 6) : 1;
  const picked = data[sel];
  const total = data.reduce((s, d) => s + d.total, 0);
  const max = data.reduce((m, d) => (d.total > m.total ? d : m), data[0] ?? { year: 0, total: 0 });

  return (
    <figure class="chart chart-card" aria-labelledby={`${id}-cap`}>
      <p class="chart-readout" aria-hidden="true">
        {picked ? <><strong>{formatMoney(picked.total)}</strong> <span class="secondary">in {picked.year}</span></> : null}
      </p>
      <svg viewBox={`0 0 ${W} ${box.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{props.title}</title>
        <desc id={`${id}-d`}>
          {data.length
            ? `${data.length} years from ${data[0].year} to ${data[data.length - 1].year}, ${formatMoney(total)} in all. Highest: ${max.year} at ${formatMoney(max.total)}.`
            : 'No spending recorded.'}
        </desc>
        {layout.ticks.map(t => (
          <g key={t.value}>
            <line class="grid" x1={box.left} x2={W - box.right} y1={t.y} y2={t.y} />
            <text class="axis-text" x={box.left - 6} y={t.y + 4} text-anchor="end">{compactMoney(t.value)}</text>
          </g>
        ))}
        {layout.bars.map(b => (
          <g key={b.label} onClick={() => { setSel(b.index); setTouched(true); }}>
            <path class={!touched || b.index === sel ? 'mark' : 'mark-dim'} d={roundedTopBarPath(b)} />
            {(b.index % every === 0 || b.index === data.length - 1) && (
              <text class="axis-text" x={b.x + b.width / 2} y={layout.baseline + 16} text-anchor="middle">
                {every > 1 ? `’${b.label.slice(2)}` : b.label}
              </text>
            )}
            {/* Hit target taller and wider than the bar. */}
            <rect class="hit" x={b.x - 4} y={box.top} width={b.width + 8} height={layout.baseline - box.top + 20}>
              <title>{`${b.label}: ${formatMoney(b.value)}`}</title>
            </rect>
          </g>
        ))}
      </svg>
      <figcaption id={`${id}-cap`} class="visually-hidden">{props.title}</figcaption>
      <table class="visually-hidden">
        <caption>{props.title}</caption>
        <thead><tr><th scope="col">Year</th><th scope="col">Spend</th></tr></thead>
        <tbody>{data.map(d => <tr key={d.year}><th scope="row">{d.year}</th><td>{formatMoney(d.total)}</td></tr>)}</tbody>
      </table>
    </figure>
  );
}

// ---------------------------------------------------------------- wear over mileage

export function WearChart(props: { item: WearItem }): JSX.Element | null {
  const id = useId();
  const item = props.item;
  const readings = item.readings.filter((r): r is typeof r & { mileage: number } => r.mileage !== null);
  const [sel, setSel] = useState<number>(readings.length - 1);
  if (!readings.length) return null;
  const box: ChartBox = { width: W, height: 150, top: 10, right: 12, bottom: 24, left: 34 };
  const proj = item.projection && item.projection.mileage > readings[readings.length - 1].mileage ? item.projection.mileage : null;
  const l = wearLayout(readings.map(r => ({ mileage: r.mileage, value: r.value })), item.replacementPoint, box, proj);
  const path = l.points.map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const picked = readings[sel];
  const title = `${item.label} readings by mileage`;

  return (
    <figure class="chart chart-card" aria-labelledby={`${id}-cap`}>
      <p class="chart-readout" aria-hidden="true">
        {picked && <><strong>{formatWearValue(picked.value, item.unit)}</strong> <span class="secondary">at {formatMiles(picked.mileage)}{picked.date ? `, ${formatDate(picked.date)}` : ''}</span></>}
      </p>
      <svg viewBox={`0 0 ${W} ${box.height}`} role="img" aria-labelledby={`${id}-t ${id}-d`}>
        <title id={`${id}-t`}>{title}</title>
        <desc id={`${id}-d`}>
          {`${readings.length} ${readings.length === 1 ? 'reading' : 'readings'}, latest ${formatWearValue(readings[readings.length - 1].value, item.unit)}. Replacement point ${formatWearValue(item.replacementPoint, item.unit)}.`}
          {proj !== null ? ` Projected to reach it around ${formatMiles(proj)}.` : ''}
        </desc>
        {l.yTicks.map(t => (
          <g key={t.value}>
            <line class="grid" x1={box.left} x2={W - box.right} y1={t.y} y2={t.y} />
            <text class="axis-text" x={box.left - 6} y={t.y + 4} text-anchor="end">{t.value}</text>
          </g>
        ))}
        {l.xTicks.map(t => (
          <text key={t.value} class="axis-text" x={t.x} y={box.height - 6} text-anchor="middle">{compactMiles(t.value)}</text>
        ))}
        <line class="threshold" x1={box.left} x2={W - box.right} y1={l.replaceY} y2={l.replaceY} />
        {l.projection && <line class="projection" x1={l.projection.x1} y1={l.projection.y1} x2={l.projection.x2} y2={l.projection.y2} />}
        {l.points.length > 1 && <path class="line" d={path} />}
        {l.points.map((p, i) => (
          <g key={i} onClick={() => setSel(i)}>
            <circle class="dot" cx={p.x} cy={p.y} r={i === sel ? 6 : 4.5} />
            <circle class="hit" cx={p.x} cy={p.y} r={16}>
              <title>{`${formatWearValue(p.value, item.unit)} at ${formatMiles(p.mileage)}`}</title>
            </circle>
          </g>
        ))}
      </svg>
      <div class="chart-legend" aria-hidden="true">
        <span><i class="key key-line" />Readings</span>
        <span><i class="key key-threshold" />Replace at {formatWearValue(item.replacementPoint, item.unit)}</span>
        {l.projection && <span><i class="key key-projection" />Projection</span>}
      </div>
      <figcaption id={`${id}-cap`} class="visually-hidden">{title}</figcaption>
      <table class="visually-hidden">
        <caption>{title}</caption>
        <thead><tr><th scope="col">Date</th><th scope="col">Mileage</th><th scope="col">Reading</th></tr></thead>
        <tbody>
          {readings.map((r, i) => (
            <tr key={i}><td>{formatDate(r.date)}</td><td>{formatMiles(r.mileage)}</td><td>{formatWearValue(r.value, item.unit)}</td></tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}
