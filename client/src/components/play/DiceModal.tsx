// ---------------------------------------------------------------------------
// DiceModal (Phase 10, Step 10.11) — "Roll a die" dialog opened from the 🎲
// button in your play cell. Radio options pick the die (d2/d4/d6/d8/d20);
// Roll sends the roll_dice op and closes — the result appears as a large
// number in the middle of your play area, visible to all players, and stays
// until you perform your next action. Cancel / backdrop click / Escape close
// without rolling.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { DICE_SIDES, type DiceSides } from '../../types';

interface DiceModalProps {
  onRoll: (sides: DiceSides) => void;
  onClose: () => void;
}

export default function DiceModal({ onRoll, onClose }: DiceModalProps) {
  const [sides, setSides] = useState<DiceSides>(6); // d6 is the most common choice

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="dice-modal-backdrop" onClick={onClose} role="dialog" aria-label="Roll a die">
      <div className="dice-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="dice-modal-title">Roll a Die</h3>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onRoll(sides);
          }}
        >
          {DICE_SIDES.map((s) => (
            <label key={s} className="dice-option">
              <input type="radio" name="dice-sides" value={s} checked={sides === s} onChange={() => setSides(s)} />
              <span>{s}-sided die</span>
            </label>
          ))}
          <div className="dice-modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary">
              Roll
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
