import { useEffect, useState } from 'react';
import type { CommunityDeckResult } from '../types';
import { getCardImageUrl } from '../cardImage';
import CardImage from './CardImage';

export default function CommunityDeckCard({ deck, onOpen }: { deck: CommunityDeckResult; onOpen: (deck: CommunityDeckResult) => void }) {
  const [commanderUrl, setCommanderUrl] = useState<string | null>(null);

  useEffect(() => {
    if (!deck.commanderOracleId) {
      setCommanderUrl(null);
      return;
    }
    let cancelled = false;
    setCommanderUrl(null);
    getCardImageUrl(deck.commanderOracleId).then((url) => {
      if (!cancelled) setCommanderUrl(url);
    });
    return () => {
      cancelled = true;
    };
  }, [deck.commanderOracleId]);

  return (
    <div className="community-deck-card" onClick={() => onOpen(deck)}>
      <div className="community-deck-header">
        <div className="community-deck-name" title={deck.name}>{deck.name}</div>
        <span className="community-deck-hearts">♥ {deck.hearts}</span>
      </div>
      <div className="community-deck-user">by {deck.username}</div>
      {deck.commander && (
        <div className="community-deck-commander">
          <CardImage url={commanderUrl} alt={deck.commander} />
        </div>
      )}
    </div>
  );
}
