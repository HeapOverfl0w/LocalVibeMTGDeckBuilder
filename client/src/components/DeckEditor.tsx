import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { api } from '../api';
import type { CardResult, Deck, DeckCard } from '../types';
import { getCardImageUrl } from '../cardImage';
import ManaCost from './ManaCost';
import CardImage from './CardImage';
import Navbar from './Navbar';
import DeckStats from './DeckStats';
import RandomHand from './RandomHand';

interface Draft {
  id?: string;
  name: string;
  cards: DeckCard[];
  commander?: string;
}

interface HoverState {
  card: DeckCard | CardResult;
  x: number;
  y: number;
}

export default function DeckEditor({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [draft, setDraft] = useState<Draft>({ name: 'My Deck', cards: [] });
  const [dirty, setDirty] = useState(false);
  const [view, setView] = useState<'text' | 'image'>('text');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<CardResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);
  const [tooltipUrls, setTooltipUrls] = useState<Record<string, string>>({});
  const [deckImageUrls, setDeckImageUrls] = useState<Record<string, string>>({});
  const [commanderUrl, setCommanderUrl] = useState<string | null>(null);
  const [showRandomHand, setShowRandomHand] = useState(false);

  useEffect(() => {
    // Fetch image URLs for deck cards (in parallel, with a module-level cache)
    let cancelled = false;
    const fetchDeckImageUrls = async () => {
      const urls: Record<string, string> = {};
      await Promise.all(
        draft.cards.map(async (card) => {
          const imageUrl = await getCardImageUrl(card.scryfallOracleId);
          urls[card.scryfallOracleId] = imageUrl;
        }),
      );
      if (!cancelled) setDeckImageUrls(urls);
    };

    fetchDeckImageUrls();
    return () => {
      cancelled = true;
    };
  }, [draft.cards]);

  useEffect(() => {
    // Fetch the commander's image URL for the toolbar hover preview.
    const commanderCard = draft.cards.find((c) => c.name === draft.commander);
    if (!commanderCard) {
      setCommanderUrl(null);
      return;
    }
    let cancelled = false;
    setCommanderUrl(null);
    getCardImageUrl(commanderCard.scryfallOracleId).then((imageUrl) => {
      if (!cancelled) setCommanderUrl(imageUrl);
    });
    return () => {
      cancelled = true;
    };
  }, [draft.commander, draft.cards]);

  useEffect(() => {
    api.getDecks()
      .then((list) => setDecks([...list].sort((a, b) => a.name.localeCompare(b.name))))
      .catch((err) => {
        if (err instanceof Error && err.message === 'Unauthorized') onLogout();
      });
  }, [onLogout]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchCards(q)
        .then(setResults)
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query]);

  const total = useMemo(() => draft.cards.reduce((sum, c) => sum + c.count, 0), [draft.cards]);

  function addCard(card: CardResult) {
    setDirty(true);
    setDraft((d) => {
      const existing = d.cards.find((c) => c.name === card.name);
      const cards = existing
        ? d.cards.map((c) => (c.name === card.name ? { ...c, count: c.count + 1 } : c))
        : [...d.cards, { name: card.name, scryfallOracleId: card.scryfallOracleId, manaCost: card.manaCost, manaValue: card.manaValue, type: card.type, count: 1 }].sort(
            (a, b) => a.name.localeCompare(b.name),
          );
      return { ...d, cards };
    });
  }

  function removeCard(name: string) {
    setDirty(true);
    setDraft((d) => {
      const cards = d.cards
        .map((c) => (c.name === name ? { ...c, count: c.count - 1 } : c))
        .filter((c) => c.count > 0)
        .sort((a, b) => a.name.localeCompare(b.name));
      // If the commander card is removed from the deck, clear the commander.
      const commander = d.commander && cards.some((c) => c.name === d.commander) ? d.commander : undefined;
      return { ...d, cards, commander };
    });
  }

  function incrementCard(name: string) {
    setDirty(true);
    setDraft((d) => {
      const cards = d.cards
        .map((c) => (c.name === name ? { ...c, count: c.count + 1 } : c))
        .sort((a, b) => a.name.localeCompare(b.name));
      return { ...d, cards };
    });
  }

  function selectDeck(deck: Deck) {
    setDraft({ id: deck.id, name: deck.name, cards: deck.cards.map((c) => ({ ...c })), commander: deck.commander });
    setDirty(false);
  }

  function startNewDeck() {
    setDraft({ name: 'New Deck', cards: [], commander: undefined });
    setDirty(false);
  }

  function isLegendaryCreature(card: DeckCard | CardResult): boolean {
    return card.type?.includes('Legendary Creature') ?? false;
  }

  function showCommanderToggle(card: DeckCard | CardResult): boolean {
    // Only show the commander button on the selected commander, or on all
    // legendary creatures when no commander is currently selected.
    return isLegendaryCreature(card) && (!draft.commander || draft.commander === card.name);
  }

  function toggleCommander(name: string) {
    setDirty(true);
    setDraft((d) => ({ ...d, commander: d.commander === name ? undefined : name }));
  }

  async function saveDeck() {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDeck({ id: draft.id, name: draft.name, cards: draft.cards, commander: draft.commander });
      setDraft((d) => ({ ...d, id: saved.id }));
      setDirty(false);
      setDecks((prev) => {
        const next = prev.map((d) => (d.id === saved.id ? saved : d));
        if (!next.some((d) => d.id === saved.id)) next.push(saved);
        return next.sort((a, b) => a.name.localeCompare(b.name));
      });
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') {
        onLogout();
        return;
      }
      setError(err instanceof Error ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function deleteDeck(id: string) {
    try {
      await api.deleteDeck(id);
      setDecks((prev) => prev.filter((d) => d.id !== id));
      if (draft.id === id) startNewDeck();
    } catch (err) {
      if (err instanceof Error && err.message === 'Unauthorized') onLogout();
      else setError(err instanceof Error ? err.message : 'Delete failed');
    }
  }

  function handleRowHover(e: MouseEvent<HTMLDivElement>, card: DeckCard | CardResult) {
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipW = 210;
    const tooltipH = 320;
    let top = rect.bottom + 6;
    if (top + tooltipH > window.innerHeight) top = Math.max(8, rect.top - tooltipH - 6);
    const left = Math.min(rect.left, window.innerWidth - tooltipW - 8);
    setHover({ card, x: left, y: top });

    // Fetch the image URL (cached per card so repeat hovers are instant)
    if (!tooltipUrls[card.scryfallOracleId]) {
      getCardImageUrl(card.scryfallOracleId).then((imageUrl) => {
        setTooltipUrls((prev) => ({ ...prev, [card.scryfallOracleId]: imageUrl }));
      });
    }
  }

  const inDeckCount = (name: string) => draft.cards.find((c) => c.name === name)?.count ?? 0;

  return (
    <div className="app">
      <Navbar username={username} onLogout={onLogout} />

      <div className="toolbar">
        <select
          className="deck-select"
          value={draft.id ?? ''}
          onChange={(e) => {
            const deck = decks.find((d) => d.id === e.target.value);
            if (deck) selectDeck(deck);
            else startNewDeck();
          }}
        >
          <option value="">New Deck</option>
          {decks.map((d) => (
            <option key={d.id} value={d.id}>{d.name}</option>
          ))}
        </select>
        <input
          className="deck-name"
          value={draft.name}
          onChange={(e) => {
            setDraft((d) => ({ ...d, name: e.target.value }));
            setDirty(true);
          }}
          placeholder="Deck name"
        />
        <span className="total-badge">Total: {total} cards</span>
        <button
          className="btn hand-btn"
          onClick={() => setShowRandomHand(true)}
          disabled={total === 0}
          title="Generate a random hand"
        >
          🎲
        </button>
        <div className="view-toggle">
          <button className={view === 'text' ? 'active' : ''} onClick={() => setView('text')}>Text</button>
          <button className={view === 'image' ? 'active' : ''} onClick={() => setView('image')}>Images</button>
        </div>
        {draft.commander && (
          <span className="commander-chip" title={draft.commander}>
            <span className="commander-label">Commander:</span>
            <span className="commander-name">{draft.commander}</span>
            <button
              className="commander-clear"
              onClick={() => toggleCommander(draft.commander!)}
              title="Deselect commander"
            >
              ×
            </button>
            <span className="commander-preview">
              {commanderUrl ? (
                <img src={commanderUrl} alt={draft.commander} />
              ) : (
                <span className="commander-preview-loading">…</span>
              )}
            </span>
          </span>
        )}
        <button className="btn primary" onClick={saveDeck} disabled={saving}>
          {saving ? 'Saving…' : dirty ? 'Save Deck' : 'Saved'}
        </button>
        {draft.id && (
          <button
            className="btn danger"
            onClick={() => {
              const id = draft.id;
              if (id && window.confirm('Delete this deck?')) deleteDeck(id);
            }}
          >
            Delete
          </button>
        )}
      </div>

      {error && <div className="error-banner">{error}</div>}

      <div className="main">
        <aside className="search-panel">
          <input
            className="search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search cards (min 3 chars)…"
          />
          <div className="results">
            {searching && <div className="muted">Searching…</div>}
            {!searching && query.trim().length >= 3 && results.length === 0 && (
              <div className="muted">No cards found.</div>
            )}
            {results.map((r) => (
              <div
                key={r.scryfallOracleId}
                className="result-row"
                onMouseEnter={(e) => handleRowHover(e, r)}
                onMouseLeave={() => setHover(null)}
              >
                <span className="result-name">{r.name}</span>
                <span className="result-meta">
                  {inDeckCount(r.name) > 0 ? `×${inDeckCount(r.name)} in deck` : ''}
                  {r.manaCost && <span className="result-mana"><ManaCost cost={r.manaCost} /></span>}
                  <button className="btn plus" onClick={() => addCard(r)} title="Add to deck">+</button>
                </span>
              </div>
            ))}
          </div>
        </aside>

        <section className="deck-panel">
          <div className="deck-card-list">
            {view === 'text' ? (
              draft.cards.length === 0 ? (
                <div className="empty">Your deck is empty. Search for cards and add them with the + button.</div>
              ) : (
                <div className="text-list">
                  {draft.cards.map((c) => (
                    <div
                      key={c.name}
                      className="deck-row"
                      onMouseEnter={(e) => handleRowHover(e, c)}
                      onMouseLeave={() => setHover(null)}
                    >
                      <span className="row-count">{c.count}</span>
                      <span className="row-name">{c.name}</span>
                      {c.manaCost && <span className="row-mana"><ManaCost cost={c.manaCost} /></span>}
                      {showCommanderToggle(c) && (
                        <button
                          className={`btn commander-toggle${draft.commander === c.name ? ' active' : ''}`}
                          onClick={() => toggleCommander(c.name)}
                          title={draft.commander === c.name ? 'Remove as commander' : 'Set as commander'}
                        >
                          {draft.commander === c.name ? '✓' : 'C'}
                        </button>
                      )}
                      <button className="btn minus" onClick={() => removeCard(c.name)} title="Remove one copy">−</button>
                      <button className="btn plus" onClick={() => incrementCard(c.name)} title="Add one copy">+</button>
                    </div>
                  ))}
                </div>
              )
            ) : draft.cards.length === 0 ? (
              <div className="empty">Your deck is empty. Search for cards and add them with the + button.</div>
            ) : (
              <div className="image-grid">
                {draft.cards.map((c) => (
                  <div key={c.name} className="image-card">
                    <CardImage url={deckImageUrls[c.scryfallOracleId]} alt={c.name} />
                    <span className="badge">{c.count}</span>
                    <div className="image-card-controls">
                      {showCommanderToggle(c) && (
                        <button
                          className={`btn commander-toggle${draft.commander === c.name ? ' active' : ''}`}
                          onClick={() => toggleCommander(c.name)}
                          title={draft.commander === c.name ? 'Remove as commander' : 'Set as commander'}
                        >
                          {draft.commander === c.name ? '✓' : 'C'}
                        </button>
                      )}
                      <button className="btn minus" onClick={() => removeCard(c.name)} title="Remove one copy">−</button>
                      <button className="btn plus" onClick={() => incrementCard(c.name)} title="Add one copy">+</button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <DeckStats cards={draft.cards} hearts={decks.find((d) => d.id === draft.id)?.hearts ?? 0} />
        </section>
      </div>

      {hover && (
        <div className="card-tooltip" style={{ left: hover.x, top: hover.y }}>
          <CardImage
            url={tooltipUrls[hover.card.scryfallOracleId] || deckImageUrls[hover.card.scryfallOracleId]}
            alt={hover.card.name}
          />
        </div>
      )}

      {showRandomHand && (
        <RandomHand
          cards={draft.cards}
          deckImageUrls={deckImageUrls}
          commander={draft.commander}
          onClose={() => setShowRandomHand(false)}
        />
      )}
    </div>
  );
}