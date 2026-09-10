import { useEffect, useState, type MouseEvent } from 'react';
import { api } from '../api';
import type { CommunityDeckDetail, CommunityDeckResult, DeckCard } from '../types';
import { getCardImageUrl } from '../cardImage';
import ManaCost from './ManaCost';
import CardImage from './CardImage';
import DeckStats from './DeckStats';

interface CommunityDeckModalProps {
  deck: CommunityDeckResult;
  onClose: () => void;
}

interface HoverState {
  card: DeckCard;
  x: number;
  y: number;
}

export default function CommunityDeckModal({ deck, onClose }: CommunityDeckModalProps) {
  const [detail, setDetail] = useState<CommunityDeckDetail | null>(null);
  const [error, setError] = useState('');
  const [hover, setHover] = useState<HoverState | null>(null);
  const [tooltipUrls, setTooltipUrls] = useState<Record<string, string>>({});
  const [hearted, setHearted] = useState<boolean | null>(null);
  const [hearting, setHearting] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setError('');
    setHearted(null);
    api.getCommunityDeck(deck.id)
      .then((d) => {
        if (!cancelled) {
          setDetail(d);
          setHearted(d.hearted);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load deck');
      });
    return () => {
      cancelled = true;
    };
  }, [deck.id]);

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

  async function handleHeartClick() {
    if (hearting) return;
    setHearting(true);
    try {
      const res = await api.heartDeck(deck.id);
      setHearted(res.hearted);
      setDetail((prev) => (prev ? { ...prev, hearts: res.hearts, hearted: res.hearted } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to heart deck');
    } finally {
      setHearting(false);
    }
  }

  async function handleCopyClick() {
    if (copied || copying) return;
    setCopying(true);
    try {
      await api.copyDeck(deck.id);
      setCopied(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to copy deck');
    } finally {
      setCopying(false);
    }
  }

  function handleRowHover(e: MouseEvent<HTMLDivElement>, card: DeckCard) {
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

  return (
    <div className="deck-modal-backdrop" onClick={handleBackdropClick}>
      <div className="deck-modal" role="dialog" aria-label={deck.name}>
        <div className="deck-modal-header">
          <div className="deck-modal-meta">
            <h2 className="deck-modal-title">{deck.name}</h2>
            by {deck.username}
            {deck.commander && (
              <span className="deck-modal-commander"> · Commander: {deck.commander}</span>
            )}
          </div>
          <div className="deck-modal-actions">
            <button
              type="button"
              className={`deck-modal-heart-btn${hearted ? ' hearted' : ''}`}
              onClick={handleHeartClick}
              disabled={hearting}
              title={hearted ? 'Remove heart' : 'Heart this deck'}
            >
              <span className="deck-modal-heart">♥</span>
              <span className="deck-modal-hearts">{detail ? detail.hearts : deck.hearts}</span>
            </button>
            <button
              type="button"
              className="deck-modal-copy-btn"
              onClick={handleCopyClick}
              disabled={copied || copying}
              title={copied ? 'Deck copied to your account' : 'Copy this deck to your account'}
            >
              {copied ? '✓ Copied' : copying ? 'Copying…' : 'Copy deck'}
            </button>
          </div>
        </div>

        {error && <div className="error-banner">{error}</div>}

        {!detail && !error && <div className="muted">Loading deck…</div>}

        {detail && (
          <>
            <div className="text-list">
              {detail.cards.length === 0 ? (
                <div className="empty">This deck has no cards.</div>
              ) : (
                detail.cards.map((c) => (
                  <div
                    key={c.name}
                    className="deck-row"
                    onMouseEnter={(e) => handleRowHover(e, c)}
                    onMouseLeave={() => setHover(null)}
                  >
                    <span className="row-count">{c.count}</span>
                    <span className="row-name">{c.name}</span>
                    {c.manaCost && <span className="row-mana"><ManaCost cost={c.manaCost} /></span>}
                  </div>
                ))
              )}
            </div>
            <DeckStats cards={detail.cards} hearts={detail.hearts} description={detail.description} editable={false} />
          </>
        )}

        {hover && (
          <div className="card-tooltip" style={{ left: hover.x, top: hover.y }}>
            <CardImage url={tooltipUrls[hover.card.scryfallOracleId]} alt={hover.card.name} />
          </div>
        )}
      </div>
    </div>
  );
}
