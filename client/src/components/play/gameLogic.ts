// ---------------------------------------------------------------------------
// Local game logic for mock matches (Phase 8, Step 8.1).
//
// Pure functions mirroring server/src/play/match.ts (§4.6) so a mock match is
// indistinguishable from a 1-player multiplayer match: same zone rules, same
// error strings, top of deck = index 0. Deliberate differences:
//   • Math.random shuffle (no CSPRNG needed locally)
//   • immutable updates — every op returns a NEW MatchState (React state)
//   • moveCard resolves the instance across players (mock states are 1-player,
//     so this is equivalent to the server's ownership check)
// ---------------------------------------------------------------------------

import { COUNTER_COLORS, DICE_SIDES, type CardCounters, type CardInstance, type Deck, type DiceSides, type MatchState, type MoveFromZone, type PlayerMatchState, type TablePos, type Zone } from '../../types';

/** Result of a local match operation. */
export type GameOpResult = { ok: true; state: MatchState } | { ok: false; message: string };

/** Default landing spot for a card that enters the table without an explicit position. */
const TABLE_CENTER: TablePos = { x: 0.5, y: 0.5 };

/** Hard cap per counter color (mirrors the server). */
export const MAX_COUNTERS_PER_COLOR = 99;

/** Life total: standard MTG starting value, and the maximum a player may set. */
export const STARTING_LIFE = 20;
export const MAX_LIFE = 999;

/** Clamp a client-supplied position into [0..1]²; null when not finite numbers. */
function clampTablePos(x: number | undefined, y: number | undefined): TablePos | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Validate + normalize a counter map; null when malformed (mirrors the server). */
function normalizeCounters(raw: unknown): CardCounters | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const out = {} as CardCounters;
  for (const color of COUNTER_COLORS) {
    const v = obj[color];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > MAX_COUNTERS_PER_COLOR) return null;
    out[color] = v;
  }
  return out;
}

/** Expand a deck into physical copies — one uuid per copy. */
function expandDeck(deck: Deck): CardInstance[] {
  const cards: CardInstance[] = [];
  for (const card of deck.cards) {
    for (let i = 0; i < card.count; i++) {
      cards.push({
        id: crypto.randomUUID(),
        name: card.name,
        scryfallOracleId: card.scryfallOracleId,
        ...(card.manaCost !== undefined ? { manaCost: card.manaCost } : {}),
        ...(card.type !== undefined ? { type: card.type } : {}),
      });
    }
  }
  return cards;
}

/** In-place Fisher–Yates shuffle (Math.random is fine locally). */
function fisherYates<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/** Return a new state with one player replaced. */
function replacePlayer(state: MatchState, userId: string, player: PlayerMatchState): MatchState {
  return { players: state.players.map((p) => (p.userId === userId ? player : p)) };
}

/** Drop a stale roll display — any action other than rolling replaces or clears it. */
function clearRoll(player: PlayerMatchState): PlayerMatchState {
  const { lastRoll, ...rest } = player;
  void lastRoll;
  return rest;
}

/**
 * Build the initial mock match state from a deck: copies expanded, shuffled,
 * one copy of the commander (when present in the pool) on the table, empty
 * hand/graveyard. `userId` must be the logged-in user's id so GameTable can
 * identify the seat.
 */
export function createMockMatch(deck: Deck, username: string, userId: string): MatchState {
  const cards = expandDeck(deck);
  fisherYates(cards);

  const table: CardInstance[] = [];
  if (deck.commander) {
    const idx = cards.findIndex((c) => c.name === deck.commander);
    if (idx !== -1) table.push({ ...cards.splice(idx, 1)[0], tablePos: { ...TABLE_CENTER } });
  }

  const player: PlayerMatchState = {
    userId,
    username,
    connected: true,
    life: STARTING_LIFE,
    deck: cards,
    hand: [],
    table,
    graveyard: [],
  };
  return { players: [player] };
}

/** Pop the top card (index 0) of the player's deck into their hand. */
export function draw(state: MatchState, userId: string): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  if (player.deck.length === 0) return { ok: false, message: 'Your deck is empty' };

  const [card, ...rest] = player.deck;
  return {
    ok: true,
    state: replacePlayer(state, userId, clearRoll({ ...player, deck: rest, hand: [...player.hand, card] })),
  };
}

/** Re-shuffle the player's deck. */
export function shuffleDeck(state: MatchState, userId: string): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };

  const deck = [...player.deck];
  fisherYates(deck);
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, deck })) };
}

/**
 * Move one card between zones. The instance must exist in the claimed `from`
 * zone (freshness check). Moving to `deck` inserts at index 0 (top of deck)
 * unless `deckPosition` says otherwise: `'bottom'` appends, a number is a
 * 1-based depth from the top (1 = on top, max = deck size + 1; out of range →
 * error). `from === to` is a no-op that returns ok. When moving onto the
 * table, `pos` sets the free-form landing position; omitted/invalid → center.
 */
export function moveCard(
  state: MatchState,
  instanceId: string,
  from: MoveFromZone,
  to: Zone,
  pos?: TablePos,
  deckPosition?: 'top' | 'bottom' | number,
): GameOpResult {
  if (from === to) return { ok: true, state };

  for (const player of state.players) {
    const idx = player[from].findIndex((c) => c.id === instanceId);
    if (idx === -1) continue; // not in this player's claimed zone

    // Validate the requested deck depth before mutating anything. The card is
    // not in the deck (`from` can't be 'deck'), so max depth = size + 1.
    if (to === 'deck' && typeof deckPosition === 'number') {
      const max = player.deck.length + 1;
      if (!Number.isInteger(deckPosition) || deckPosition < 1 || deckPosition > max) {
        return { ok: false, message: `Position must be between 1 and ${max}` };
      }
    }

    const card = player[from][idx];
    // A tapped card that leaves the table comes back untapped (and unplaced),
    // and all of its counters are removed.
    let moved: CardInstance = from === 'table' ? { ...card, tapped: false } : { ...card };
    if (from === 'table') {
      delete moved.tablePos;
      delete moved.counters;
    }

    const next: PlayerMatchState = { ...player };
    next[from] = [...player[from].slice(0, idx), ...player[from].slice(idx + 1)];

    // Tokens can't exist off the table — moving one to hand/deck/graveyard
    // destroys it (already removed from the table above).
    if (card.token && to !== 'table') {
      return { ok: true, state: replacePlayer(state, player.userId, clearRoll(next)) };
    }

    if (to === 'table') moved = { ...moved, tablePos: clampTablePos(pos?.x, pos?.y) ?? { ...TABLE_CENTER } };
    if (to === 'deck') {
      const p = deckPosition ?? 'top';
      if (p === 'bottom') next.deck = [...player.deck, moved];
      else if (typeof p === 'number') next.deck = [...player.deck.slice(0, p - 1), moved, ...player.deck.slice(p - 1)];
      else next.deck = [moved, ...player.deck];
    } else next[to] = [...player[to], moved];

    return { ok: true, state: replacePlayer(state, player.userId, clearRoll(next)) };
  }

  return { ok: false, message: 'Card not found' };
}

/**
 * Toggle the tapped state of one of the player's table cards. The instance
 * must exist on that player's table; tapping is only meaningful on the table.
 */
export function tapCard(state: MatchState, userId: string, instanceId: string): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };

  const idx = player.table.findIndex((c) => c.id === instanceId);
  if (idx === -1) return { ok: false, message: 'Card not found' };

  const card = player.table[idx];
  const table = [...player.table.slice(0, idx), { ...card, tapped: !card.tapped }, ...player.table.slice(idx + 1)];
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, table })) };
}

/**
 * Reposition one of the player's cards that is already on their table. The
 * instance must exist on that player's table; the target position must be
 * finite (clamped into [0..1]²). Tapped state is untouched.
 */
export function placeCard(state: MatchState, userId: string, instanceId: string, x: number, y: number): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };

  const idx = player.table.findIndex((c) => c.id === instanceId);
  if (idx === -1) return { ok: false, message: 'Card not found' };

  const pos = clampTablePos(x, y);
  if (!pos) return { ok: false, message: 'Invalid position' };

  const card = player.table[idx];
  const table = [...player.table.slice(0, idx), { ...card, tablePos: pos }, ...player.table.slice(idx + 1)];
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, table })) };
}

/**
 * Set the counters on one of the player's table cards (mock mirror of the
 * server op). The instance must exist on that player's table; every color
 * count must be an integer in [0..MAX_COUNTERS_PER_COLOR]. An all-zero map
 * clears the card's counters.
 */
export function setCounters(state: MatchState, userId: string, instanceId: string, raw: unknown): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };

  const idx = player.table.findIndex((c) => c.id === instanceId);
  if (idx === -1) return { ok: false, message: 'Card not found' };

  const counters = normalizeCounters(raw);
  if (!counters) return { ok: false, message: 'Invalid counter count' };

  const total = COUNTER_COLORS.reduce((sum, color) => sum + counters[color], 0);
  const card = player.table[idx];
  const updated: CardInstance = { ...card };
  if (total === 0) delete updated.counters;
  else updated.counters = counters;

  const table = [...player.table.slice(0, idx), updated, ...player.table.slice(idx + 1)];
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, table })) };
}

/** Max lengths for token fields (mirror the server). */
const TOKEN_NAME_MAX = 60;
const TOKEN_PT_MAX = 10;

/**
 * Create a token on the player's table (mock mirror of the server op). Tokens
 * have no image — they render from their name plus power/toughness. The new
 * token starts at the center of the table. A token moved off the table is
 * destroyed (see moveCard).
 */
export function createToken(state: MatchState, userId: string, rawName: unknown, rawPower: unknown, rawToughness: unknown): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };

  const name = typeof rawName === 'string' ? rawName.trim() : '';
  const power = typeof rawPower === 'string' ? rawPower.trim() : '';
  const toughness = typeof rawToughness === 'string' ? rawToughness.trim() : '';
  if (!name) return { ok: false, message: 'Token name is required' };
  if (name.length > TOKEN_NAME_MAX) return { ok: false, message: 'Token name is too long' };
  // Power/toughness are optional (some tokens have none), but must be set together.
  const hasPower = power !== '';
  const hasToughness = toughness !== '';
  if (hasPower !== hasToughness) return { ok: false, message: 'Power and toughness must both be set' };
  if (hasPower && (power.length > TOKEN_PT_MAX || toughness.length > TOKEN_PT_MAX)) {
    return { ok: false, message: 'Power or toughness is too long' };
  }

  const token: CardInstance = {
    id: crypto.randomUUID(),
    name,
    scryfallOracleId: '',
    token: { power, toughness },
    tablePos: { ...TABLE_CENTER },
  };
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, table: [...player.table, token] })) };
}

/** Set the player's life total (mock mirror of the server op; integer in [0..MAX_LIFE]). */
export function setLife(state: MatchState, userId: string, raw: unknown): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_LIFE) {
    return { ok: false, message: 'Invalid life total' };
  }
  return { ok: true, state: replacePlayer(state, userId, clearRoll({ ...player, life: raw })) };
}

/**
 * Roll one of the player's dice (mock mirror of the server op). Sides must be
 * one of DICE_SIDES; the result is stored on the player and stays visible
 * until their next action (see clearRoll in each op). A new roll replaces it.
 */
export function rollDice(state: MatchState, userId: string, rawSides: unknown): GameOpResult {
  const player = state.players.find((p) => p.userId === userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  const sides = typeof rawSides === 'number' ? rawSides : NaN;
  if (!(DICE_SIDES as readonly number[]).includes(sides)) {
    return { ok: false, message: `Invalid die — choose one of ${DICE_SIDES.join(', ')}` };
  }
  const value = Math.floor(Math.random() * sides) + 1;
  return { ok: true, state: replacePlayer(state, userId, { ...player, lastRoll: { value, sides: sides as DiceSides } }) };
}
