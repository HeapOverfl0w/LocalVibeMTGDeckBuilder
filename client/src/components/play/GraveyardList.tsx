// ---------------------------------------------------------------------------
// GraveyardList (Phase 7, Step 7.2) — modal listing every card in a graveyard
// as one text row per instance (duplicates appear as repeated rows), sorted
// by name. Own graveyard: rows are draggable back onto the table (payload
// { instanceId, from: 'graveyard' }). Opponent's graveyard: plain rows plus a
// note — the server enforces ownership regardless. Every row has a magnifying
// glass that opens the shared card zoom modal (Phase 10).
//
// While a row is being dragged, the backdrop passes pointer events through so
// the drop can land on the game table behind the modal.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import type { MouseEvent } from 'react';
import type { CardInstance, PlayerMatchState } from '../../types';
import { setDragPayload } from './playDnd';

interface GraveyardListProps {
  player: PlayerMatchState;
  isOwn: boolean;
  onClose: () => void;
  onZoom?: (card: CardInstance) => void;
}

export default function GraveyardList({ player, isOwn, onClose, onZoom }: GraveyardListProps) {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>) {
    // Only close when the click lands on the backdrop itself, not the modal.
    if (e.target === e.currentTarget) onClose();
  }

  const rows = [...player.graveyard].sort((a, b) => a.name.localeCompare(b.name));

  return (
    <div className={`hand-modal-backdrop${dragging ? ' gt-drag-passthrough' : ''}`} onClick={handleBackdropClick}>
      <div className="hand-modal graveyard-modal" role="dialog" aria-label={`${player.username}'s graveyard`}>
        <h2 className="hand-title">Graveyard — {player.username}</h2>

        {rows.length === 0 ? (
          <p className="muted gy-empty">Empty.</p>
        ) : (
          <ul className="gy-rows">
            {rows.map((card) => (
              <li
                key={card.id}
                className={`gy-row${isOwn ? ' gy-row-draggable' : ''}`}
                draggable={isOwn}
                onDragStart={
                  isOwn
                    ? (e) => {
                        setDragPayload(e, card.id, 'graveyard');
                        setDragging(true);
                      }
                    : undefined
                }
                onDragEnd={isOwn ? () => setDragging(false) : undefined}
              >
                <span className="gy-row-name">{card.name}</span>
                {onZoom && (
                  <button
                    className="gy-zoom-btn"
                    title={`Zoom ${card.name}`}
                    aria-label={`Zoom ${card.name}`}
                    onClick={() => onZoom(card)}
                  >
                    🔍
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}

        {!isOwn && <p className="gy-note">You can't take cards from another player's graveyard.</p>}

        <button className="btn primary gy-close" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}
