// ---------------------------------------------------------------------------
// Game table (Phases 6–8, Phase 10 layout) — layout, card rendering, and
// interactions.
//
// All rendering/interaction code is shared between modes: in mock mode the
// provider's intents run gameLogic locally (no socket), in multiplayer they
// go through the socket. The only visible difference is the top bar (MOCK
// badge instead of the lobby code; "Exit" instead of "Leave").
//
// Layout (Phase 10): every player gets an equal play cell — 1 player fills
// the whole area, 2 players split it in half side by side, 3–4 players get a
// 2×2 grid with missing seats rendered as blank cells. You always occupy the
// first slot; opponents follow in seat order. Each cell is a PlayerCell:
// header (name + deck/GY chips, plus a hand-count chip for opponents),
// free-form table zone, and your own face-up hand strip.
//
// Interactions (Phase 7 + free-form table):
//   • left-click your deck chip → draw; right-click → context menu (Shuffle Deck)
//   • left-click any graveyard chip → GraveyardList modal
//   • own hand/table cards are draggable (HTML5 DnD); drop targets (own only):
//     table zone, hand strip, deck chip, graveyard chip
//   • the table is free-form: drops land at the cursor position and table
//     cards can be re-dragged anywhere on it (ghost preview while hovering).
//     Positions are server-authoritative — every player sees the same layout.
// No optimistic rendering — the UI updates from the authoritative state_update.
// ---------------------------------------------------------------------------

import { useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { getCardImageUrl } from '../../cardImage';
import { getUserId } from '../../api';
import type { CardInstance, TablePos, Zone } from '../../types';
import { usePlaySession } from './PlaySessionContext';
import PlayerCell, { type OwnCellInteractions } from './PlayerCell';
import ContextMenu from './ContextMenu';
import CardZoomModal from './CardZoomModal';
import CounterModal from './CounterModal';
import DiceModal from './DiceModal';
import PlaceCardModal from './PlaceCardModal';
import TokenModal from './TokenModal';
import GraveyardList from './GraveyardList';
import { clearActiveDrag, getActiveDrag, getDragPayload, setDragPayload } from './playDnd';

/**
 * Pre-fetches Scryfall image URLs for every unique oracle id in the given
 * cards (Promise.all, keyed map). The map stays warm across state updates —
 * only ids that have never been fetched are requested.
 */
function useCardImageUrls(cards: CardInstance[]): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const urlsRef = useRef(urls);
  urlsRef.current = urls;

  const idsKey = useMemo(() => [...new Set(cards.map((c) => c.scryfallOracleId))].sort().join(','), [cards]);

  useEffect(() => {
    if (!idsKey) return;
    let cancelled = false;
    const missing = idsKey.split(',').filter((id) => !urlsRef.current[id]);
    if (missing.length === 0) return;
    Promise.all(missing.map(async (id): Promise<[string, string]> => [id, await getCardImageUrl(id)])).then(
      (entries) => {
        if (!cancelled) setUrls((prev) => ({ ...prev, ...Object.fromEntries(entries) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [idsKey]);

  return urls;
}

export default function GameTable() {
  const { mode, match, lobby, draw, shuffle, moveCard, tapCard, placeCard, setCounters, createToken, setLife, rollDice, leaveLobby } = usePlaySession();

  // Hooks must run unconditionally — compute everything, then branch.
  const myId = getUserId();
  const me = match?.players.find((p) => p.userId === myId);
  const allCards = match ? match.players.flatMap((p) => [...p.deck, ...p.hand, ...p.table, ...p.graveyard]) : [];
  const imageUrls = useCardImageUrls(allCards);

  // Interaction state.
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null); // deck-stack context menu
  const [cardMenu, setCardMenu] = useState<{ x: number; y: number; card: CardInstance } | null>(null); // hand/table card menu (zoom + counters)
  const [zoomCard, setZoomCard] = useState<CardInstance | null>(null); // card in the zoom modal
  const [counterCardId, setCounterCardId] = useState<string | null>(null); // own table card in the counter modal
  const [placeCardId, setPlaceCardId] = useState<string | null>(null); // own table card in the place-card dialog
  const [tokenModalOpen, setTokenModalOpen] = useState(false); // new-token dialog (+ button)
  const [diceModalOpen, setDiceModalOpen] = useState(false); // roll-a-die dialog (🎲 button)
  const [gyPlayerId, setGyPlayerId] = useState<string | null>(null); // whose graveyard list is open
  const [dragOver, setDragOver] = useState<Zone | null>(null); // drop-target highlight
  const [ghost, setGhost] = useState<TablePos | null>(null); // placement preview on the table zone
  const [draggingId, setDraggingId] = useState<string | null>(null); // own card currently being dragged

  // A drag that ends anywhere (drop outside our targets, Escape-cancel) must
  // still clear the ghost + dimming — window-level listeners catch all of it.
  useEffect(() => {
    const clear = () => {
      setGhost(null);
      setDraggingId(null);
      clearActiveDrag();
    };
    window.addEventListener('dragend', clear);
    window.addEventListener('drop', clear);
    return () => {
      window.removeEventListener('dragend', clear);
      window.removeEventListener('drop', clear);
    };
  }, []);

  // Mock mode now produces real `match` state (Phase 8), so the only guard is
  // a missing match. All rendering below is shared between modes.
  if (!match) {
    return (
      <div className="game-table">
        <p className="muted game-mock-note">No match in progress.</p>
        <button className="btn" onClick={leaveLobby}>
          Exit
        </button>
      </div>
    );
  }

  if (!me) {
    return (
      <div className="game-table">
        <p className="muted game-mock-note">Couldn't identify your seat in this match.</p>
        <button className="btn" onClick={leaveLobby}>
          Leave
        </button>
      </div>
    );
  }

  const gyPlayer = gyPlayerId ? (match.players.find((p) => p.userId === gyPlayerId) ?? null) : null;

  // The counter modal only ever opens for your own table cards — resolve the
  // live card so the dialog initializes from the current state.
  const counterCard = counterCardId ? (me.table.find((c) => c.id === counterCardId) ?? null) : null;

  // Same for the place-card dialog: it only applies to your own table cards.
  const placeTarget = placeCardId ? (me.table.find((c) => c.id === placeCardId) ?? null) : null;

  /** Drop-target handlers for one of your zones. */
  function dropHandlers(to: Zone) {
    return {
      onDragOver: (e: DragEvent<HTMLElement>) => {
        e.preventDefault(); // required to allow the drop
        setDragOver((cur) => (cur === to ? cur : to));
      },
      onDragLeave: (e: DragEvent<HTMLElement>) => {
        const next = e.relatedTarget as Node | null;
        if (next && e.currentTarget.contains(next)) return; // still inside this target
        setDragOver((cur) => (cur === to ? null : cur));
      },
      onDrop: (e: DragEvent<HTMLElement>) => {
        e.preventDefault();
        const payload = getDragPayload(e);
        setDragOver(null);
        if (!payload || payload.from === to) return; // ignore no-ops
        moveCard(payload.instanceId, payload.from, to);
      },
    };
  }

  /** Cursor position as a clamped fraction of the table zone (0..1 per axis). */
  function posFromEvent(e: DragEvent<HTMLElement>): TablePos | null {
    const rect = e.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
  }

  /**
   * Table-zone drop handlers — free-form placement. Hovering shows a ghost at
   * the cursor; dropping sends place_card (card already on the table) or
   * move_card with the landing position (from hand / graveyard).
   */
  const tableZoneHandlers = {
    onDragOver: (e: DragEvent<HTMLElement>) => {
      if (!getActiveDrag()) return; // not a card drag — no highlight, no ghost, no drop
      e.preventDefault(); // required to allow the drop
      setDragOver((cur) => (cur === 'table' ? cur : 'table'));
      const pos = posFromEvent(e);
      if (pos) {
        // Bail out of re-render when the cursor hasn't meaningfully moved.
        setGhost((cur) => (cur && Math.abs(cur.x - pos.x) < 0.005 && Math.abs(cur.y - pos.y) < 0.005 ? cur : pos));
      }
    },
    onDragLeave: (e: DragEvent<HTMLElement>) => {
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return; // still inside the zone
      setDragOver((cur) => (cur === 'table' ? null : cur));
      setGhost(null);
    },
    onDrop: (e: DragEvent<HTMLElement>) => {
      e.preventDefault();
      const payload = getDragPayload(e); // also clears the active-drag tracker
      setDragOver(null);
      setGhost(null);
      if (!payload) return;
      const pos = posFromEvent(e) ?? { x: 0.5, y: 0.5 };
      if (payload.from === 'table') placeCard(payload.instanceId, pos.x, pos.y);
      else moveCard(payload.instanceId, payload.from, 'table', pos);
    },
  };

  // Layout slots: you first, then opponents in seat order. The grid is sized
  // for the player count — 1 → one full-area cell, 2 → two half-screen cells
  // side by side, 3–4 → 2×2 with missing seats as blank cells.
  const players = [me, ...match.players.filter((p) => p.userId !== myId)];
  const gridClass = `game-grid ${players.length === 1 ? 'grid-1' : players.length === 2 ? 'grid-2' : 'grid-4'}`;
  const emptyCells = players.length >= 3 ? 4 - players.length : 0;

  const ownInteractions: OwnCellInteractions = {
    dragOver,
    ghost,
    draggingId,
    tableZoneHandlers,
    zoneDropHandlers: dropHandlers,
    onDraw: () => draw(),
    onDeckContextMenu: (x, y) => setMenu({ x, y }),
    onAddToken: () => setTokenModalOpen(true),
    onRollDice: () => setDiceModalOpen(true),
    onSetLife: (life) => setLife(life),
    onTapCard: (id) => tapCard(id),
    onTableCardDragStart: (e, id) => {
      setDragPayload(e, id, 'table');
      setDraggingId(id);
    },
    onHandCardDragStart: (e, id) => setDragPayload(e, id, 'hand'),
  };

  return (
    <div className="game-table">
      {/* Top bar: lobby code (or MOCK badge) • player chips … [Leave/Exit] */}
      <div className="game-topbar">
        <span className="game-lobby-code" title={mode === 'mock' ? 'Mock match — local game, no server' : 'Lobby code'}>
          {mode === 'mock' ? 'MOCK' : (lobby?.code ?? '')}
        </span>
        <div className="game-chips">
          {match.players.map((p) => (
            <span key={p.userId} className={`player-chip${p.connected ? '' : ' disconnected'}`}>
              <span className={`lobby-dot${p.connected ? ' on' : ''}`} />
              {p.username}
              {p.userId === myId ? ' (you)' : ''}
            </span>
          ))}
        </div>
        <button className="btn" onClick={leaveLobby}>
          {mode === 'mock' ? 'Exit' : 'Leave'}
        </button>
      </div>

      {/* Equal play cells — every player gets the same amount of screen space */}
      <div className={gridClass}>
        {players.map((p) => (
          <PlayerCell
            key={p.userId}
            player={p}
            isOwn={p.userId === myId}
            imageUrls={imageUrls}
            onGraveyardClick={() => setGyPlayerId(p.userId)}
            onCardContextMenu={(card, x, y) => setCardMenu({ x, y, card })}
            own={p.userId === myId ? ownInteractions : undefined}
          />
        ))}
        {Array.from({ length: emptyCells }).map((_, i) => (
          <div key={`empty-${i}`} className="player-cell player-cell-empty" aria-hidden />
        ))}
      </div>

      {/* Deck-stack context menu (right-click) */}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[{ label: 'Shuffle Deck', onClick: () => shuffle() }]}
          onClose={() => setMenu(null)}
        />
      )}

      {/* Hand/table card context menu (right-click) — zoom anywhere; "Counters..."
          and "Place Card..." only for your own table cards */}
      {cardMenu && (
        <ContextMenu
          x={cardMenu.x}
          y={cardMenu.y}
          items={[
            { label: '🔍 Zoom card', onClick: () => setZoomCard(cardMenu.card) },
            ...(me.table.some((c) => c.id === cardMenu.card.id)
              ? [
                  { label: 'Counters...', onClick: () => setCounterCardId(cardMenu.card.id) },
                  { label: 'Place Card...', onClick: () => setPlaceCardId(cardMenu.card.id) },
                ]
              : []),
          ]}
          onClose={() => setCardMenu(null)}
        />
      )}

      {/* Large card view — closes on backdrop click or Escape */}
      {zoomCard && <CardZoomModal card={zoomCard} imageUrls={imageUrls} onClose={() => setZoomCard(null)} />}

      {/* Counter editor for one of your table cards — OK applies, Cancel/Escape close */}
      {counterCard && (
        <CounterModal
          card={counterCard}
          onApply={(counters) => {
            setCounters(counterCard.id, counters);
            setCounterCardId(null);
          }}
          onClose={() => setCounterCardId(null)}
        />
      )}

      {/* Place-card dialog for one of your table cards — Pick a destination, Place sends the move */}
      {placeTarget && (
        <PlaceCardModal
          cardName={placeTarget.name}
          deckCount={me.deck.length}
          onPlace={(dest) => {
            if (dest === 'graveyard') moveCard(placeTarget.id, 'table', 'graveyard');
            else if (typeof dest === 'object') moveCard(placeTarget.id, 'table', 'deck', undefined, dest.depth);
            else moveCard(placeTarget.id, 'table', 'deck', undefined, dest);
            setPlaceCardId(null);
          }}
          onClose={() => setPlaceCardId(null)}
        />
      )}

      {/* New-token dialog (+ button left of your deck chip) — OK creates the token on your table */}
      {tokenModalOpen && (
        <TokenModal
          onCreate={(name, power, toughness) => {
            createToken(name, power, toughness);
            setTokenModalOpen(false);
          }}
          onClose={() => setTokenModalOpen(false)}
        />
      )}

      {/* Roll-a-die dialog (🎲 button between + and your deck chip) — Roll sends the op;
          the result shows in your play area until your next action */}
      {diceModalOpen && (
        <DiceModal
          onRoll={(sides) => {
            rollDice(sides);
            setDiceModalOpen(false);
          }}
          onClose={() => setDiceModalOpen(false)}
        />
      )}

      {/* Graveyard list modal (yours or an opponent's) */}
      {gyPlayer && (
        <GraveyardList player={gyPlayer} isOwn={gyPlayer.userId === myId} onClose={() => setGyPlayerId(null)} onZoom={(card) => setZoomCard(card)} />
      )}
    </div>
  );
}
