// ---------------------------------------------------------------------------
// PlaceCardModal (Phase 10, Step 10.10) — "Place Card..." dialog for one of
// your own table cards. Radio options decide where the card goes:
//   • On Top of Deck
//   • On Bottom of Deck
//   • Graveyard
//   • X from the Top of the Deck — a numeric field (1..deckCount+1) that
//     inserts the card into the deck at that depth (1 = on top).
// Place sends the move; Cancel / backdrop click / Escape close without moving.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';

export type PlaceDestination = 'top' | 'bottom' | 'graveyard' | { depth: number };

interface PlaceCardModalProps {
  /** Name of the card being placed (shown in the title). */
  cardName: string;
  /** Current deck size — bounds the depth field (max = size + 1). */
  deckCount: number;
  onPlace: (destination: PlaceDestination) => void;
  onClose: () => void;
}

export default function PlaceCardModal({ cardName, deckCount, onPlace, onClose }: PlaceCardModalProps) {
  const [choice, setChoice] = useState<'top' | 'bottom' | 'graveyard' | 'depth'>('top');
  const [depthText, setDepthText] = useState('1');

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const maxDepth = deckCount + 1;
  const depth = Number.parseInt(depthText, 10);
  const depthValid = Number.isInteger(depth) && depth >= 1 && depth <= maxDepth;
  const valid = choice !== 'depth' || depthValid;

  function submit(): void {
    if (!valid) return;
    onPlace(choice === 'depth' ? { depth } : (choice as Exclude<PlaceDestination, { depth: number }>));
  }

  return (
    <div className="place-modal-backdrop" onClick={onClose} role="dialog" aria-label={`Place ${cardName}`}>
      <div className="place-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="place-modal-title">Place Card...</h3>
        <p className="place-modal-subtitle">{cardName}</p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <label className="place-option">
            <input type="radio" name="place-dest" value="top" checked={choice === 'top'} onChange={() => setChoice('top')} />
            <span>On Top of Deck</span>
          </label>
          <label className="place-option">
            <input type="radio" name="place-dest" value="bottom" checked={choice === 'bottom'} onChange={() => setChoice('bottom')} />
            <span>On Bottom of Deck</span>
          </label>
          <label className="place-option">
            <input type="radio" name="place-dest" value="graveyard" checked={choice === 'graveyard'} onChange={() => setChoice('graveyard')} />
            <span>Graveyard</span>
          </label>
          <label className="place-option">
            <input type="radio" name="place-dest" value="depth" checked={choice === 'depth'} onChange={() => setChoice('depth')} />
            <span>
              X from the Top of the Deck{' '}
              <input
                className="place-depth-input"
                type="number"
                min={1}
                max={maxDepth}
                step={1}
                value={depthText}
                disabled={choice !== 'depth'}
                onChange={(e) => setDepthText(e.target.value)}
              />
            </span>
          </label>
          <p className="place-hint">Depth 1 = on top; max {maxDepth} (behind all {deckCount} deck cards).</p>
          <div className="place-modal-actions">
            <button type="button" className="btn" onClick={onClose}>
              Cancel
            </button>
            <button type="submit" className="btn primary" disabled={!valid}>
              Place
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
