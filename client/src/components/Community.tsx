import { useEffect, useState } from 'react';
import { api } from '../api';
import type { CommunityDeckResult } from '../types';
import Navbar from './Navbar';
import CommunityDeckCard from './CommunityDeckCard';
import CommunityDeckModal from './CommunityDeckModal';
import ManaCost from './ManaCost';

type SearchType = 'commander' | 'username' | 'top' | 'colors';

const COLOR_OPTIONS = ['G', 'U', 'B', 'R', 'W'];

export default function Community({ username, onLogout }: { username: string; onLogout: () => void }) {
  const [query, setQuery] = useState('');
  const [type, setType] = useState<SearchType>('commander');
  const [selectedColors, setSelectedColors] = useState<string[]>([]);
  const [results, setResults] = useState<CommunityDeckResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);
  const [topPage, setTopPage] = useState(1);
  const [topTotal, setTopTotal] = useState(0);
  const [topLoadingMore, setTopLoadingMore] = useState(false);
  const [selectedDeck, setSelectedDeck] = useState<CommunityDeckResult | null>(null);

  useEffect(() => {
    if (type === 'top' || type === 'colors') return;
    const q = query.trim();
    if (q.length === 0) {
      setResults([]);
      setSearching(false);
      setSearched(false);
      return;
    }
    setSearching(true);
    const timer = setTimeout(() => {
      api.searchCommunity(q, type)
        .then((list) => {
          setResults(list);
          setSearched(true);
        })
        .catch(() => setResults([]))
        .finally(() => setSearching(false));
    }, 300);
    return () => clearTimeout(timer);
  }, [query, type]);

  useEffect(() => {
    if (type !== 'top') return;
    let cancelled = false;
    setSearching(true);
    setTopPage(1);
    api.getTopDecks(1)
      .then((res) => {
        if (cancelled) return;
        setResults(res.decks);
        setTopTotal(res.total);
        setSearched(true);
      })
      .catch(() => {
        if (!cancelled) {
          setResults([]);
          setTopTotal(0);
          setSearched(true);
        }
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type]);

  useEffect(() => {
    if (type !== 'colors') return;
    if (selectedColors.length === 0) {
      setResults([]);
      setSearching(false);
      setSearched(false);
      return;
    }
    let cancelled = false;
    setSearching(true);
    api.searchCommunityByColors(selectedColors)
      .then((list) => {
        if (cancelled) return;
        setResults(list);
        setSearched(true);
      })
      .catch(() => {
        if (!cancelled) setResults([]);
      })
      .finally(() => {
        if (!cancelled) setSearching(false);
      });
    return () => {
      cancelled = true;
    };
  }, [type, selectedColors]);

  const loadMoreTop = () => {
    const nextPage = topPage + 1;
    setTopLoadingMore(true);
    api.getTopDecks(nextPage)
      .then((res) => {
        setResults((prev) => [...prev, ...res.decks]);
        setTopPage(nextPage);
        setTopTotal(res.total);
      })
      .catch(() => undefined)
      .finally(() => setTopLoadingMore(false));
  };

  return (
    <div className="app">
      <Navbar username={username} onLogout={onLogout} />

      <div className="community">
        <div className="community-search">
          <select
            className="community-type"
            value={type}
            onChange={(e) => {
              const newType = e.target.value as SearchType;
              setType(newType);
              setResults([]);
              setSearched(false);
              setSearching(false);
            }}
          >
            <option value="commander">Commander</option>
            <option value="username">Username</option>
            <option value="top">Top</option>
            <option value="colors">Colors</option>
          </select>
          {type === 'colors' ? (
            <div className="community-colors">
              {COLOR_OPTIONS.map((color) => (
                <label key={color} className="community-color-check">
                  <input
                    type="checkbox"
                    checked={selectedColors.includes(color)}
                    onChange={(e) => {
                      setSelectedColors((prev) =>
                        e.target.checked ? [...prev, color] : prev.filter((c) => c !== color),
                      );
                    }}
                  />
                  <ManaCost cost={`{${color}}`} />
                  <span className="community-color-label">{color}</span>
                </label>
              ))}
            </div>
          ) : type !== 'top' ? (
            <input
              className="community-input"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={type === 'commander' ? 'Search by commander…' : 'Search by username…'}
            />
          ) : null}
        </div>

        <div className="community-results">
          {searching && <div className="muted">Searching…</div>}
          {!searching && searched && results.length === 0 && (
            <div className="muted">No decks found.</div>
          )}
          {!searching && !searched && type !== 'top' && type !== 'colors' && query.trim().length === 0 && (
            <div className="muted">Enter a commander or username to search community decks.</div>
          )}
          {!searching && !searched && type === 'colors' && selectedColors.length === 0 && (
            <div className="muted">Select one or more colors to search community decks.</div>
          )}
          {type === 'top' && !searching && topTotal > 0 && (
            <div className="community-top-summary muted">
              Top {Math.min(topTotal, 40)} of {topTotal} decks by hearts
            </div>
          )}
          {results.length > 0 && (
            <div className="community-deck-grid">
              {results.map((r, i) => (
                <CommunityDeckCard key={`${r.id}-${i}`} deck={r} onOpen={setSelectedDeck} />
              ))}
            </div>
          )}
          {type === 'top' && !searching && results.length > 0 && results.length < topTotal && (
            <div className="community-load-more">
              <button className="btn" onClick={loadMoreTop} disabled={topLoadingMore}>
                {topLoadingMore ? 'Loading…' : 'Load more'}
              </button>
            </div>
          )}
        </div>
      </div>

      {selectedDeck && (
        <CommunityDeckModal deck={selectedDeck} onClose={() => setSelectedDeck(null)} />
      )}
    </div>
  );
}
