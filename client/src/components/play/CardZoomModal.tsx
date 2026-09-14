// ---------------------------------------------------------------------------
// CardZoomModal (Phase 10) — a large card view for reading details. Opened
// from the right-click context menu on your hand/table cards. Clicking the
// backdrop (outside the dialog) or pressing Escape closes it; clicking the
// card itself does not close it.
// ---------------------------------------------------------------------------

import { useEffect } from 'react';
import CardImage from '../CardImage';
import type { CardInstance } from '../../types';

interface CardZoomModalProps {
  card: CardInstance;
  imageUrls: Record<string, string>;
  onClose: () => void;
}

/** Scryfall "normal" images are 300×421 — swap to the CDN's "large" tier for the zoom view. */
function zoomUrl(url?: string): string | undefined {
  return url ? url.replace('/normal/', '/large/') : url;
}

export default function CardZoomModal({ card, imageUrls, onClose }: CardZoomModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="zoom-modal-backdrop" onClick={onClose} role="dialog" aria-label={`Zoomed card: ${card.name}`}>
      <div className="zoom-modal" onClick={(e) => e.stopPropagation()}>
        <h3 className="zoom-modal-title">{card.name}</h3>
        {card.token ? (
          // Tokens have no image — show an enlarged token face.
          <div className={`gt-token zoom-token${card.token.power && card.token.toughness ? '' : ' gt-token-no-pt'}`}>
            <span className="gt-token-name">{card.name}</span>
            {card.token.power && card.token.toughness && (
              <span className="gt-token-pt">
                {card.token.power}/{card.token.toughness}
              </span>
            )}
          </div>
        ) : (
          <CardImage url={zoomUrl(imageUrls[card.scryfallOracleId])} alt={card.name} manaCost={card.manaCost} />
        )}
      </div>
    </div>
  );
}
