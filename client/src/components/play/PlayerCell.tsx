// ---------------------------------------------------------------------------
// PlayerCell (Phase 10) — one player's play area, rendered identically for
// everyone so every player gets the same amount of screen space:
//   • header: name + hand chip (opponents: card back with 🖐️ + count, left of
//     the deck chip) + deck chip (card back with 🃏 + count) + graveyard chip
//     (card back with 🪦 + count) — all three icons centered on the back
//   • table zone: free-form canvas, cards absolutely positioned by --tx/--ty
//   • hand strip: face-up draggable cards — own cell only; opponents' hands
//     are hidden behind the header chip to keep their table space big
//
// isOwn toggles interactivity: draw/shuffle on the deck chip, tap/drag on
// table cards, drag-out of the hand, drop targets (table/hand/deck/graveyard).
// Opponent cells stay render-only except right-click zoom and clicking the
// graveyard chip — no drag handlers, ever.
// ---------------------------------------------------------------------------

import type { CSSProperties, DragEvent } from 'react';
import { useEffect, useState } from 'react';
import CardImage from '../CardImage';
import { COUNTER_COLORS, type CardCounters, type CardInstance, type PlayerMatchState, type TablePos, type Zone } from '../../types';
import { MAX_LIFE } from './gameLogic';

/** One small colored dot per counter; renders nothing when the total is 0. */
function CounterPips({ counters }: { counters: CardCounters }) {
  const total = COUNTER_COLORS.reduce((sum, color) => sum + counters[color], 0);
  if (total === 0) return null;
  return (
    <div className="counter-pips" aria-hidden>
      {COUNTER_COLORS.flatMap((color) =>
        Array.from({ length: counters[color] }, (_, i) => <span key={`${color}-${i}`} className={`counter-pip pip-${color}`} />),
      )}
    </div>
  );
}

export interface ZoneDropHandlers {
  onDragOver: (e: DragEvent<HTMLElement>) => void;
  onDragLeave: (e: DragEvent<HTMLElement>) => void;
  onDrop: (e: DragEvent<HTMLElement>) => void;
}

/** Interactions for the local player's cell only. */
export interface OwnCellInteractions {
  dragOver: Zone | null;
  ghost: TablePos | null;
  draggingId: string | null;
  tableZoneHandlers: ZoneDropHandlers;
  zoneDropHandlers: (zone: Zone) => ZoneDropHandlers;
  onDraw: () => void;
  onDeckContextMenu: (x: number, y: number) => void;
  /** Open the "new token" dialog (+ button left of the deck chip). */
  onAddToken?: () => void;
  /** Open the "roll a die" dialog (🎲 button between the + and the deck chip). */
  onRollDice?: () => void;
  /** Commit a new life total for the local player (integer 0..MAX_LIFE). */
  onSetLife?: (life: number) => void;
  onTapCard: (id: string) => void;
  onTableCardDragStart: (e: DragEvent<HTMLElement>, id: string) => void;
  onHandCardDragStart: (e: DragEvent<HTMLElement>, id: string) => void;
}

interface PlayerCellProps {
  player: PlayerMatchState;
  isOwn: boolean;
  imageUrls: Record<string, string>;
  onGraveyardClick: () => void;
  onCardContextMenu: (card: CardInstance, x: number, y: number) => void;
  own?: OwnCellInteractions;
}

export default function PlayerCell({ player, isOwn, imageUrls, onGraveyardClick, onCardContextMenu, own }: PlayerCellProps) {
  // Life total editing (own cell only): `lifeDraft` holds the text while the
  // user types; commit on Enter or blur. Valid + changed → send the op and
  // keep showing the typed value until the state update confirms it; invalid
  // or unchanged reverts to the committed value immediately.
  const [lifeDraft, setLifeDraft] = useState<string | null>(null);
  useEffect(() => {
    if (lifeDraft !== null && Number(lifeDraft.trim()) === player.life) setLifeDraft(null);
  }, [player.life, lifeDraft]);

  function commitLife() {
    if (lifeDraft === null) return;
    const trimmed = lifeDraft.trim();
    const parsed = Number(trimmed);
    const valid = /^\d+$/.test(trimmed) && parsed >= 0 && parsed <= MAX_LIFE;
    if (!valid || parsed === player.life) {
      setLifeDraft(null);
      return;
    }
    own?.onSetLife?.(parsed);
  }

  return (
    <div className={`player-cell${isOwn ? ' player-cell-own' : ''}${player.connected ? '' : ' disconnected'}`}>
      {/* Dice roll result — a large number in the middle of this player's play
          area, visible to everyone; it disappears when they act again. */}
      {player.lastRoll && (
        <div className="roll-display" aria-live="polite">
          <span className="roll-value">{player.lastRoll.value}</span>
          <span className="roll-label">
            d{player.lastRoll.sides}
            {!isOwn ? ` — ${player.username}` : ''}
          </span>
        </div>
      )}
      {/* Header: name + life total (editable for self, number-only for
          opponents) + hand chip (opponents) + deck chip + graveyard chip */}
      <div className="player-cell-header">
        <div className="player-cell-id">
          <span className="player-cell-name" title={isOwn ? `${player.username} (you)` : player.username}>
            {player.username}
            {isOwn ? ' (you)' : ''}
            {!player.connected && <span className="muted"> (disconnected)</span>}
          </span>
          {isOwn ? (
            <label className="player-life player-life-editable" title="Your life total — type a whole number and press Enter">
              <span className="life-heart" aria-hidden>♥</span>
              <input
                className="life-input"
                value={lifeDraft ?? String(player.life)}
                onChange={(e) => setLifeDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitLife();
                }}
                onBlur={commitLife}
                inputMode="numeric"
                aria-label="Your life total"
              />
            </label>
          ) : (
            <span className="player-life" title={`${player.username}'s life total`}>
              <span className="life-heart" aria-hidden>♥</span>
              {player.life}
            </span>
          )}
        </div>
        <div className="player-cell-chips">
          {/* Opponent hand chip: same look as the deck chip, 🖐️ centered on the
              card back + count badge showing how many cards they hold.
              Render-only — no interaction. */}
          {!isOwn && (
            <div
              className="cell-deck cell-hand-chip"
              title={`${player.username}'s hand — ${player.hand.length} card${player.hand.length === 1 ? '' : 's'}`}
            >
              <div className="card-back">
                <span className="hand-symbol" aria-hidden>
                  🖐️
                </span>
              </div>
              <span className="count-badge">{player.hand.length}</span>
            </div>
          )}

          {/* Token button: + to the left of your deck chip — opens the new-token dialog */}
          {isOwn && own?.onAddToken && (
            <button type="button" className="token-add-btn" title="Add a token to your table" onClick={own.onAddToken}>
              +
            </button>
          )}

          {/* Dice button: between the + and your deck chip — opens the roll-a-die dialog */}
          {isOwn && own?.onRollDice && (
            <button type="button" className="dice-btn" title="Roll a die" onClick={own.onRollDice}>
              🎲
            </button>
          )}

          {/* Deck chip: 🃏 centered on the card back + count. Own = click to draw,
              right-click for options, drop target (top of deck) */}
          <div
            className={`cell-deck${isOwn ? ' clickable' : ''}${isOwn && own?.dragOver === 'deck' ? ' drop-target-active' : ''}`}
            title={isOwn ? 'Your deck — click to draw, right-click for options' : `${player.username}'s deck`}
            onClick={isOwn ? own?.onDraw : undefined}
            onContextMenu={
              isOwn
                ? (e) => {
                    e.preventDefault();
                    own?.onDeckContextMenu(e.clientX, e.clientY);
                  }
                : undefined
            }
            {...(isOwn ? (own?.zoneDropHandlers('deck') ?? {}) : {})}
          >
            <div className="card-back">
              <span className="deck-symbol" aria-hidden>
                🃏
              </span>
            </div>
            <span className="count-badge">{player.deck.length}</span>
          </div>

          {/* Graveyard chip: same look as the deck chip, 🪦 centered on the card
              back + count badge. Click opens the list; own is also a drop target */}
          <div
            className={`cell-gy${isOwn && own?.dragOver === 'graveyard' ? ' drop-target-active' : ''}`}
            title={`${player.username}'s graveyard — click to view`}
            onClick={onGraveyardClick}
            {...(isOwn ? (own?.zoneDropHandlers('graveyard') ?? {}) : {})}
          >
            <div className="card-back">
              <span className="gy-symbol" aria-hidden>
                🪦
              </span>
            </div>
            <span className="count-badge">{player.graveyard.length}</span>
          </div>
        </div>
      </div>

      {/* Table zone — free-form canvas, equal for every player */}
      <div className={`cell-table${isOwn && own?.dragOver === 'table' ? ' drop-target-active' : ''}`} {...(isOwn ? (own?.tableZoneHandlers ?? {}) : {})}>
        {player.table.length === 0 && !(isOwn && own?.ghost) ? (
          isOwn ? <span className="zone-hint">Your table — drag cards here, anywhere</span> : null
        ) : (
          <>
            {player.table.map((c) => {
              const pos = c.tablePos ?? { x: 0.5, y: 0.5 };
              return (
                <div
                  key={c.id}
                  className={`gt-card gt-card-cell draggable-card${c.tapped ? ' tapped' : ''}${isOwn && own?.draggingId === c.id ? ' dragging' : ''}`}
                  style={{ '--tx': `${pos.x * 100}%`, '--ty': `${pos.y * 100}%` } as CSSProperties}
                  title={
                    isOwn
                      ? `${c.name}${c.tapped ? ' (tapped)' : ''} — click to ${c.tapped ? 'untap' : 'tap'}, drag to move, right-click to zoom`
                      : `${player.username}: ${c.name}${c.tapped ? ' (tapped)' : ''} — right-click to zoom`
                  }
                  draggable={isOwn}
                  onDragStart={isOwn ? (e) => own?.onTableCardDragStart(e, c.id) : undefined}
                  onClick={isOwn ? () => own?.onTapCard(c.id) : undefined}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    onCardContextMenu(c, e.clientX, e.clientY);
                  }}
                >
                  {c.token ? (
                    // Token: no image — name on top (wrapping), "X/Y" at the bottom
                    // when it has power/toughness, both centered.
                    <div className={`gt-token${c.token.power && c.token.toughness ? '' : ' gt-token-no-pt'}`}>
                      <span className="gt-token-name">{c.name}</span>
                      {c.token.power && c.token.toughness && (
                        <span className="gt-token-pt">
                          {c.token.power}/{c.token.toughness}
                        </span>
                      )}
                    </div>
                  ) : (
                    <CardImage url={imageUrls[c.scryfallOracleId]} alt={c.name} manaCost={c.manaCost} />
                  )}
                  {/* Counter pips live inside the card element so they rotate
                      with it when tapped. Bottom-left, stacking upward. */}
                  {c.counters && <CounterPips counters={c.counters} />}
                </div>
              );
            })}
            {isOwn && own?.ghost && (
              <div className="gt-drop-ghost" style={{ left: `${own.ghost.x * 100}%`, top: `${own.ghost.y * 100}%` }} aria-hidden />
            )}
          </>
        )}
      </div>

      {/* Hand strip — own cell only (opponents' hands are the header chip) */}
      {isOwn && (
        <div className={`cell-hand${own?.dragOver === 'hand' ? ' drop-target-active' : ''}`} {...(own?.zoneDropHandlers('hand') ?? {})}>
          {player.hand.length === 0 ? (
            <span className="zone-hint">Your hand</span>
          ) : (
            player.hand.map((c) => (
              <div
                key={c.id}
                className="gt-card gt-card-hand draggable-card"
                title={`${c.name} — drag to play, right-click to zoom`}
                draggable
                onDragStart={(e) => own?.onHandCardDragStart(e, c.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  onCardContextMenu(c, e.clientX, e.clientY);
                }}
              >
                <CardImage url={imageUrls[c.scryfallOracleId]} alt={c.name} manaCost={c.manaCost} />
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
