// ---------------------------------------------------------------------------
// Play landing (Phase 5, Step 5.2).
//
// Deck dropdown fed by api.getDecks() (sorted by name, card totals shown —
// same pattern as DeckEditor); play controls disabled until a non-empty deck
// is selected. Two sections: Mock ("▶ Play Mock" → fully local match via
// gameLogic, no socket) and Multiplayer (Host Lobby / Join by code). Server
// errors render in a small banner above the controls.
// ---------------------------------------------------------------------------

import { useEffect, useState } from 'react';
import { api } from '../../api';
import type { Deck } from '../../types';
import { usePlaySession } from './PlaySessionContext';

function deckTotal(deck: Deck): number {
  return deck.cards.reduce((sum, c) => sum + c.count, 0);
}

export default function PlayLanding() {
  const { hostLobby, joinLobby, startMock, banner, toast, dismissBanner } = usePlaySession();
  const [decks, setDecks] = useState<Deck[]>([]);
  const [deckId, setDeckId] = useState('');
  const [code, setCode] = useState('');

  useEffect(() => {
    api
      .getDecks()
      .then((d) => setDecks([...d].sort((a, b) => a.name.localeCompare(b.name))))
      .catch(() => setDecks([]));
  }, []);

  const selectedDeck = decks.find((d) => d.id === deckId);
  const canPlay = Boolean(selectedDeck && deckTotal(selectedDeck) > 0);

  return (
    <div className="play-landing">
      <h2>Play</h2>

      {(banner || toast) && (
        <div className={`play-banner${toast ? ' play-banner-toast' : ''}`}>
          <span>{banner ?? toast}</span>
          {banner && (
            <button className="play-banner-dismiss" onClick={dismissBanner} aria-label="Dismiss">
              ×
            </button>
          )}
        </div>
      )}

      <div className="play-landing-panel">
        <label className="play-field">
          Deck
          <select value={deckId} onChange={(e) => setDeckId(e.target.value)}>
            <option value="">Select a deck…</option>
            {decks.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} — {deckTotal(d)} cards
              </option>
            ))}
          </select>
        </label>

        <div className="play-sections">
          <section className="play-section">
            <h3>Mock Game</h3>
            <p className="play-section-desc">Play against yourself — no connection needed.</p>
            <button className="btn primary" disabled={!canPlay} onClick={() => selectedDeck && startMock(selectedDeck)}>
              ▶ Play Mock
            </button>
          </section>

          <section className="play-section">
            <h3>Multiplayer</h3>
            <p className="play-section-desc">Host a lobby, or join one with its code.</p>
            <div className="play-landing-actions">
              <button className="btn" disabled={!canPlay} onClick={() => hostLobby(deckId)}>
                Host Lobby
              </button>
              <input
                className="lobby-code-input"
                placeholder="Code"
                value={code}
                maxLength={6}
                onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))}
              />
              <button className="btn" disabled={!canPlay || code.length !== 6} onClick={() => joinLobby(code, deckId)}>
                Join Lobby
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
