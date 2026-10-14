import { useEffect, useRef, useState } from 'react';
import { usd, usdShort, monthShort, monthLong } from '../api.js';

const HEIGHT = 200;
const PAD = { top: 28, right: 96, bottom: 28, left: 44 };
const BAR = 24; // columns stay thin; the band's leftover is air

function useWidth() {
  const ref = useRef(null);
  const [width, setWidth] = useState(560);
  useEffect(() => {
    const ro = new ResizeObserver(([entry]) => setWidth(Math.max(280, entry.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width];
}

// Clean tick step (1, 2 or 5 x 10^n) giving about 3 gridlines.
function niceMax(maxCents) {
  const raw = maxCents / 3;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= raw);
  return { step, max: Math.ceil(maxCents / step) * step };
}

// Column with a 4px rounded data-end and a square base.
function column(x, y, w, h, r = 4) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

// Monthly spending in one category: past months, this month so far, and the projected
// rest of the month, against the usual month.
export default function SpendingChart({ category, history }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const [asTable, setAsTable] = useState(false);
  const months = history.months;
  const current = months.at(-1);
  const projected = current.cents + (current.projectedRestCents ?? 0);

  const { step, max } = niceMax(Math.max(history.usualCents, projected, ...months.map((m) => m.cents)) * 1.08);
  const innerW = width - PAD.left - PAD.right;
  const innerH = HEIGHT - PAD.top - PAD.bottom;
  const band = innerW / months.length;
  const y = (cents) => PAD.top + innerH - (cents / max) * innerH;
  const ticks = Array.from({ length: Math.round(max / step) + 1 }, (_, i) => i * step);

  return (
    <div className="chart" ref={ref}>
      {asTable ? (
        <table className="data">
          <thead>
            <tr><th>Month</th><th className="num">Spent</th><th className="num">Projected</th></tr>
          </thead>
          <tbody>
            {months.map((m) => (
              <tr key={m.month}>
                <td>{monthLong(m.month)}</td>
                <td className="num">{usd(m.cents)}{m.current ? ' so far' : ''}</td>
                <td className="num">{m.current ? usd(projected) : '–'}</td>
              </tr>
            ))}
            <tr><td>Usual month</td><td className="num">{usd(history.usualCents)}</td><td /></tr>
          </tbody>
        </table>
      ) : (
        <svg width={width} height={HEIGHT} role="img" aria-label={`${category} spending by month. Usual month ${usd(history.usualCents)}; this month projected ${usd(projected)}.`}>
          {ticks.map((t) => (
            <g key={t}>
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? 'var(--axis)' : 'var(--grid)'} strokeWidth="1" />
              <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end">{usdShort(t)}</text>
            </g>
          ))}

          {months.map((m, i) => {
            const cx = PAD.left + band * i + band / 2;
            const x = cx - BAR / 2;
            const spentTop = y(m.cents);
            const restCents = m.projectedRestCents ?? 0;
            // The projected rest sits above "so far", separated by a 2px surface gap.
            const restTop = y(m.cents + restCents);
            const restH = Math.max(0, spentTop - restTop - 2);
            return (
              <g key={m.month}>
                <path d={column(x, spentTop, BAR, y(0) - spentTop, m.current && restH > 0 ? 0 : 4)} fill="var(--series-1)" />
                {m.current && restH > 0 && <path d={column(x, restTop, BAR, restH)} fill="var(--series-1-soft)" />}
                <text x={cx} y={HEIGHT - 8} textAnchor="middle">{monthShort(m.month)}</text>
                {m.current && (
                  <text className="value-label" x={cx} y={restTop - 8} textAnchor="middle">{usd(projected)}</text>
                )}
                <rect
                  x={PAD.left + band * i} y={PAD.top} width={band} height={innerH} fill="transparent"
                  onMouseEnter={() => setHover({ m, cx })} onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover({ m, cx })} onBlur={() => setHover(null)} tabIndex={0}
                  aria-label={`${monthLong(m.month)}: ${usd(m.cents)}${m.current ? ` so far, ${usd(projected)} projected` : ''}`}
                />
              </g>
            );
          })}

          <line x1={PAD.left} x2={width - PAD.right} y1={y(history.usualCents)} y2={y(history.usualCents)} stroke="var(--ink-2)" strokeWidth="1.5" />
          <text className="usual-label" x={width - PAD.right + 8} y={y(history.usualCents) + 4}>Usual {usdShort(history.usualCents)}</text>
        </svg>
      )}

      {hover && !asTable && (
        <div className="tooltip" style={{ left: hover.cx, top: y(hover.m.cents + (hover.m.projectedRestCents ?? 0)) }}>
          <strong>{monthLong(hover.m.month)}</strong>
          {usd(hover.m.cents)} {hover.m.current ? 'so far' : 'spent'}
          {hover.m.current && <><br />{usd(projected)} projected</>}
        </div>
      )}

      <ul className="legend" aria-hidden={asTable}>
        <li><span className="swatch" style={{ background: 'var(--series-1)' }} />Spent</li>
        <li><span className="swatch" style={{ background: 'var(--series-1-soft)' }} />Projected rest of {monthShort(current.month)}</li>
        <li><span className="swatch line" style={{ background: 'var(--ink-2)' }} />Usual month</li>
        <li><button type="button" className="linkish" onClick={() => setAsTable(!asTable)}>{asTable ? 'Show chart' : 'Show as table'}</button></li>
      </ul>
    </div>
  );
}
