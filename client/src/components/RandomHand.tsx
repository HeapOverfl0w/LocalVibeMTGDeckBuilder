import { useEffect, useState, type MouseEvent } from 'react';
import type { DeckCard } from '../types';
import CardImage from './CardImage';

interface RandomHandProps {
  cards: DeckCard[];
  deckImageUrls: Record<string, string>;
  commander?: string;
  onClose: () => void;
}

/**
 * Draws a random hand of up to 7 cards from the deck. Each card in the deck is
 * weighted by its copy count, so a card with 4 copies is 4x more likely to
 * appear than a card with 1 copy. Cards are drawn without replacement.
 */
function drawHand(cards: DeckCard[], commander?: string): DeckCard[] {
  const pool: DeckCard[] = [];
  for (const card of cards) {
    if (commander && card.name === commander) continue;
    for (let i = 0; i < card.count; i++) pool.push(card);
  }
  const n = Math.min(7, pool.length);
  const hand: DeckCard[] = [];
  const source = [...pool];
  for (let i = 0; i < n; i++) {
    const j = Math.floor(Math.random() * (source.length - i));
    hand.push(source.splice(j, 1)[0]);
  }
  return hand;
}

export default function RandomHand({ cards, deckImageUrls, commander, onClose }: RandomHandProps) {
  const [hand, setHand] = useState<DeckCard[]>(() => drawHand(cards, commander));

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleBackdropClick(e: MouseEvent<HTMLDivElement>) {
    // Only close when the click lands on the backdrop itself, not on the modal.
    if (e.target === e.currentTarget) onClose();
  }

  return (
    <div className="hand-modal-backdrop" onClick={handleBackdropClick}>
      <div className="hand-modal" role="dialog" aria-label="Random hand">
        <h2 className="hand-title">Random Hand</h2>
        <div className="hand-cards">
          {hand.map((card, i) => (
            <div key={i} className="hand-card">
              <CardImage url={deckImageUrls[card.scryfallOracleId]} alt={card.name} />
            </div>
          ))}
        </div>
        <button className="btn primary hand-regenerate" onClick={() => setHand(drawHand(cards, commander))}>
          Generate New Hand
        </button>
      </div>
    </div>
  );
}
