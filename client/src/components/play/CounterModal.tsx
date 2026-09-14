// ---------------------------------------------------------------------------
// CounterModal (Phase 10, Step 10.7) — edit the counters on one of your table
// cards. Five colored circles (blue, red, green, white, black), each with its
// count in the center and +/− buttons on either side. Counts floor at 0 and
// cap at MAX_COUNTERS_PER_COLOR. OK applies the map to the card (all-zero
// clears it); Cancel / backdrop click / Escape close without applying.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import type { CardCounters, CardInstance, CounterColor } from '../../types';
import { COUNTER_COLORS } from '../../types';
import { MAX_COUNTERS_PER_COLOR } from './gameLogic';

interface CounterModalProps {
  card: CardInstance;
  onApply: (counters: CardCounters) => void;
  onClose: () => void;
}

const ZERO_COUNTS: CardCounters = { blue: 0, red: 0, green: 0, white: 0, black: 0 };

export default function CounterModal({ card, onApply, onClose }: CounterModalProps) {
  const [counts, setCounts] = useState<CardCounters>(() => ({ ...ZERO_COUNTS, ...(card.counters ?? {}) }));

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  function bump(color: CounterColor, delta: number): void {
    setCounts((prev) => ({ ...prev, [color]: Math.min(MAX_COUNTERS_PER_COLOR, Math.max(0, prev[color] + delta)) }));
  }

  return (
    <div className="counter-modal-backdrop" onClick={onClose} role="dialog" aria-label={`Counters for ${card.name}`}>
      <div className="counter-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="counter-modal-title">Counters — {card.name}</h3>
        <div className="counter-rows">
          {COUNTER_COLORS.map((color) => (
            <div className="counter-row" key={color}>
              <button
                type="button"
                className="counter-btn counter-btn-minus"
                aria-label={`Remove a ${color} counter`}
                disabled={counts[color] === 0}
                onClick={() => bump(color, -1)}
              >
                −
              </button>
              <span className={`counter-circle counter-circle-${color}`}>{counts[color]}</span>
              <button
                type="button"
                className="counter-btn counter-btn-plus"
                aria-label={`Add a ${color} counter`}
                disabled={counts[color] === MAX_COUNTERS_PER_COLOR}
                onClick={() => bump(color, 1)}
              >
                +
              </button>
            </div>
          ))}
        </div>
        <div className="counter-modal-actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={() => onApply(counts)}>
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
