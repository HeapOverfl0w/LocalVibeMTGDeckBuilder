import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { api } from '../api';
import type { CardResult, Deck, DeckCard } from '../types';
import { getCardImageUrl } from '../cardImage';

interface Draft {
  id?: string;
  name: string;
  cards: DeckCard[];
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
  const [tooltipImageUrl, setTooltipImageUrl] = useState<string | null>(null);
  const [deckImageUrls, setDeckImageUrls] = useState<Record<string, string>>({});

  useEffect(() => {
    // Fetch image URLs for deck cards
    const fetchDeckImageUrls = async () => {
      const urls: Record<string, string> = {};
      for (const card of draft.cards) {
        try {
          const imageUrl = await getCardImageUrl(card.scryfallOracleId);
          urls[card.scryfallOracleId] = imageUrl;
        } catch (error) {
          // Fallback to direct CDN URL
          const char1 = card.scryfallOracleId.charAt(0);
          const char2 = card.scryfallOracleId.charAt(1);
          urls[card.scryfallOracleId] = `https://cards.scryfall.io/png/front/${char1}/${char2}/${card.scryfallOracleId}.png`;
        }
      }
      setDeckImageUrls(urls);
    };
    
    fetchDeckImageUrls();
  }, [draft.cards]);

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
        : [...d.cards, { name: card.name, scryfallOracleId: card.scryfallOracleId, count: 1 }].sort((a, b) =>
            a.name.localeCompare(b.name),
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
      return { ...d, cards };
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
    setDraft({ id: deck.id, name: deck.name, cards: deck.cards.map((c) => ({ ...c })) });
    setDirty(false);
  }

  function startNewDeck() {
    setDraft({ name: 'New Deck', cards: [] });
    setDirty(false);
  }

  async function saveDeck() {
    setSaving(true);
    setError('');
    try {
      const saved = await api.saveDeck({ id: draft.id, name: draft.name, cards: draft.cards });
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

  async function handleRowHover(e: MouseEvent<HTMLDivElement>, card: DeckCard | CardResult) {
    const rect = e.currentTarget.getBoundingClientRect();
    const tooltipW = 210;
    const tooltipH = 320;
    let top = rect.bottom + 6;
    if (top + tooltipH > window.innerHeight) top = Math.max(8, rect.top - tooltipH - 6);
    const left = Math.min(rect.left, window.innerWidth - tooltipW - 8);
    setHover({ card, x: left, y: top });
    
    // Fetch the image URL
    const imageUrl = await getCardImageUrl(card.scryfallOracleId);
    setTooltipImageUrl(imageUrl);
  }

  const inDeckCount = (name: string) => draft.cards.find((c) => c.name === name)?.count ?? 0;

  return (
    <div className="app">
      <header className="header">
        <h1>⚔️ MTG Deck Builder</h1>
        <div className="header-right">
          <span className="user-badge">{username}</span>
          <button className="btn" onClick={onLogout}>Log out</button>
        </div>
      </header>

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
        <div className="view-toggle">
          <button className={view === 'text' ? 'active' : ''} onClick={() => setView('text')}>Text</button>
          <button className={view === 'image' ? 'active' : ''} onClick={() => setView('image')}>Images</button>
        </div>
        <button className="btn primary" onClick={saveDeck} disabled={saving}>
          {saving ? 'Saving…' : dirty ? 'Save Deck' : 'Saved'}
        </button>
        {draft.id && (
          <button
            className="btn danger"
            onClick={() => {
              if (window.confirm('Delete this deck?')) deleteDeck(draft.id);
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
                onMouseEnter={async (e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const tooltipW = 210;
                  const tooltipH = 320;
                  let top = rect.bottom + 6;
                  if (top + tooltipH > window.innerHeight) top = Math.max(8, rect.top - tooltipH - 6);
                  const left = Math.min(rect.left, window.innerWidth - tooltipW - 8);
                  setHover({ card: r, x: left, y: top });
                  
                  // Fetch the image URL
                  const imageUrl = await getCardImageUrl(r.scryfallOracleId);
                  setTooltipImageUrl(imageUrl);
                }}
                onMouseLeave={() => {
                  setHover(null);
                  setTooltipImageUrl(null);
                }}
              >
                <span className="result-name">{r.name}</span>
                <span className="result-meta">
                  {inDeckCount(r.name) > 0 ? `×${inDeckCount(r.name)} in deck` : ''}
                  <button className="btn plus" onClick={() => addCard(r)} title="Add to deck">+</button>
                </span>
              </div>
            ))}
          </div>
        </aside>

        <section className="deck-panel">
          {view === 'text' ? (
            draft.cards.length === 0 ? (
              <div className="empty">Your deck is empty. Search for cards and add them with the + button.</div>
            ) : (
              <div className="text-list">
                {draft.cards.map((c) => (
                  <div
                    key={c.name}
                    className="deck-row"
                    onMouseEnter={async (e) => {
                      await handleRowHover(e, c);
                    }}
                    onMouseLeave={() => {
                      setHover(null);
                      setTooltipImageUrl(null);
                    }}
                  >
                    <span className="row-count">{c.count}</span>
                    <span className="row-name">{c.name}</span>
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
                  <img src={deckImageUrls[c.scryfallOracleId]} alt={c.name} loading="lazy" />
                  <span className="badge">{c.count}</span>
                  <span className="image-name">{c.name}</span>
                  <button className="btn plus" onClick={() => incrementCard(c.name)} title="Add one copy">+</button>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      {hover && (
        <div className="card-tooltip" style={{ left: hover.x, top: hover.y }}>
          <img src={tooltipImageUrl || deckImageUrls[hover.card.scryfallOracleId] } alt={hover.card.name} />
        </div>
      )}
    </div>
  );
}