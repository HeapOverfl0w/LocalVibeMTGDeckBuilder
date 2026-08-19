import { useMemo } from 'react';
import type { DeckCard } from '../types';

// Fixed mana-value buckets for the X axis: 1, 2, 3, 4, 5, 6, 7, 8, 9+.
const BUCKETS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

function bucketLabel(index: number): string {
  return index === BUCKETS.length - 1 ? '9+' : String(BUCKETS[index]);
}

// Round a value up to a "nice" number so the Y axis has clean gridlines.
function niceCeil(value: number): number {
  if (value <= 0) return 1;
  const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
  const normalized = value / magnitude;
  let nice: number;
  if (normalized <= 1) nice = 1;
  else if (normalized <= 2) nice = 2;
  else if (normalized <= 5) nice = 5;
  else nice = 10;
  return nice * magnitude;
}

function ManaValueGraph({ values }: { values: number[] }) {
  const width = 320;
  const height = 140;
  const pad = { left: 22, right: 12, top: 10, bottom: 17 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  const yMax = niceCeil(Math.max(...values, 0));

  const xFor = (i: number) =>
    pad.left + (values.length === 1 ? 0 : (i / (values.length - 1)) * plotW);
  const yFor = (v: number) => pad.top + (1 - v / yMax) * plotH;

  const points = values.map((v, i) => ({ x: xFor(i), y: yFor(v), v }));
  const linePath = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(' ');
  const areaPath =
    points.length > 0
      ? `${linePath} L ${points[points.length - 1].x.toFixed(2)} ${(pad.top + plotH).toFixed(2)} L ${points[0].x.toFixed(2)} ${(pad.top + plotH).toFixed(2)} Z`
      : '';

  const gridFractions = [0, 0.25, 0.5, 0.75, 1];

  return (
    <svg
      className="mana-graph"
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Line graph of card count by mana value"
    >
      {/* Horizontal gridlines + Y axis labels (amount of cards) */}
      {gridFractions.map((f) => {
        const y = pad.top + (1 - f) * plotH;
        return (
          <g key={f}>
            <line
              x1={pad.left}
              y1={y}
              x2={pad.left + plotW}
              y2={y}
              className="mana-graph-grid"
            />
            <text
              x={pad.left - 8}
              y={y + 4}
              textAnchor="end"
              className="mana-graph-axis-label"
            >
              {Math.round(f * yMax)}
            </text>
          </g>
        );
      })}

      {/* X axis labels (mana value buckets) */}
      {values.map((_, i) => (
        <text
          key={i}
          x={xFor(i)}
          y={height - pad.bottom + 10}
          textAnchor="middle"
          className="mana-graph-axis-label"
        >
          {bucketLabel(i)}
        </text>
      ))}

      {/* Area fill under the line */}
      <path d={areaPath} className="mana-graph-area" />

      {/* The line */}
      <path d={linePath} className="mana-graph-line" />

      {/* Data points */}
      {points.map((p, i) => (
        <circle key={i} cx={p.x} cy={p.y} r={2.5} className="mana-graph-dot">
          <title>{`${bucketLabel(i)}: ${p.v} card${p.v === 1 ? '' : 's'}`}</title>
        </circle>
      ))}
    </svg>
  );
}

export default function DeckStats({ cards, hearts }: { cards: DeckCard[]; hearts: number }) {
  const bucketValues = useMemo(() => {
    const buckets = new Array(BUCKETS.length).fill(0);
    for (const card of cards) {
      const mv = card.manaValue;
      if (mv === undefined || mv === null || mv < 1) continue;
      const idx = mv >= 9 ? BUCKETS.length - 1 : Math.floor(mv) - 1;
      if (idx >= 0 && idx < BUCKETS.length) {
        buckets[idx] += card.count;
      }
    }
    return buckets;
  }, [cards]);

  return (
    <section className="deck-stats">
      <h2 className="deck-stats-title">Deck Stats</h2>
      <div className="stats-card">
        <div className="stats-card-row">
          <div className="stats-graph">
            <h3 className="stats-card-title">Mana Value Distribution</h3>
            <ManaValueGraph values={bucketValues} />
          </div>
          <div className="stats-hearts-box">
            <h3 className="stats-card-title">Hearts</h3>
            <p className="stats-hearts">{hearts}</p>
          </div>
        </div>
      </div>
    </section>
  );
}
