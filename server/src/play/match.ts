// ---------------------------------------------------------------------------
// Match engine (Phase 3).
//
// Builds the initial match state from a lobby's seat snapshots and provides
// the sandbox operations (draw / shuffle / move card). All operations mutate
// the live MatchState in place and return it; the caller (lobby manager) is
// responsible for broadcasting `state_update` after a successful op.
// ---------------------------------------------------------------------------

import { randomInt, randomUUID } from 'node:crypto';
import type { DeckSnapshot, Lobby } from './lobbyManager';
import { COUNTER_COLORS, DICE_SIDES, type CardCounters, type CardInstance, type DiceSides, type MatchState, type MoveFromZone, type PlayerMatchState, type TablePos, type Zone } from './types';

/** Result of a match operation. `state` is the live (mutated) match state. */
export type MatchOpResult = { ok: true; state: MatchState } | { ok: false; message: string };

/** Default landing spot for a card that enters the table without an explicit position. */
const TABLE_CENTER: TablePos = { x: 0.5, y: 0.5 };

/** Hard cap per counter color (keeps pip columns sane and blocks absurd state). */
export const MAX_COUNTERS_PER_COLOR = 99;

/** Life total: standard MTG starting value, and the maximum a player may set. */
export const STARTING_LIFE = 20;
export const MAX_LIFE = 999;

/** Clamp a client-supplied position into [0..1]²; null when not finite numbers. */
function clampTablePos(x: number | undefined, y: number | undefined): TablePos | null {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: Math.min(1, Math.max(0, x)), y: Math.min(1, Math.max(0, y)) };
}

/** Validate + normalize a client-supplied counter map; null when malformed. */
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

/** Expand a deck snapshot into physical copies — one uuid per copy. */
function expandDeck(snapshot: DeckSnapshot): CardInstance[] {
  const cards: CardInstance[] = [];
  for (const card of snapshot.cards) {
    for (let i = 0; i < card.count; i++) {
      cards.push({
        id: randomUUID(),
        name: card.name,
        scryfallOracleId: card.scryfallOracleId,
        ...(card.manaCost !== undefined ? { manaCost: card.manaCost } : {}),
        ...(card.type !== undefined ? { type: card.type } : {}),
      });
    }
  }
  return cards;
}

/** In-place Fisher–Yates shuffle using the CSPRNG (crypto.randomInt). */
export function fisherYates<T>(arr: T[]): void {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
}

/**
 * Build the initial match state from a lobby's seat snapshots. Every player
 * gets an empty hand, their deck shuffled (Fisher–Yates), and — when the deck
 * has a commander with a matching card in the pool — one copy removed from
 * the shuffle and placed on their table.
 */
export function buildMatchState(lobby: Lobby): MatchState {
  const players: PlayerMatchState[] = lobby.players.map((seat) => {
    const deck = expandDeck(seat.deckSnapshot);
    fisherYates(deck);

    const table: CardInstance[] = [];
    const commanderName = seat.deckSnapshot.commander;
    if (commanderName) {
      const idx = deck.findIndex((c) => c.name === commanderName);
      if (idx !== -1) table.push({ ...deck.splice(idx, 1)[0], tablePos: { ...TABLE_CENTER } });
    }

    return {
      userId: seat.userId,
      username: seat.username,
      connected: seat.connected,
      life: STARTING_LIFE,
      deck,
      hand: [],
      table,
      graveyard: [],
    };
  });

  return { players };
}

function playerOf(state: MatchState, userId: string): PlayerMatchState | undefined {
  return state.players.find((p) => p.userId === userId);
}

/** Drop a stale roll display — any action other than rolling replaces or clears it. */
function clearRoll(player: PlayerMatchState): void {
  delete player.lastRoll;
}

/** Pop the top card (index 0) of the player's deck into their hand. */
export function draw(lobby: Lobby, userId: string): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  if (player.deck.length === 0) return { ok: false, message: 'Your deck is empty' };
  clearRoll(player);
  const card = player.deck.shift()!;
  player.hand.push(card);
  return { ok: true, state };
}

/** Re-shuffle the player's deck in place. */
export function shuffleDeck(lobby: Lobby, userId: string): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  clearRoll(player);
  fisherYates(player.deck);
  return { ok: true, state };
}

/**
 * Move one of the requester's cards between zones. The instance must exist in
 * the claimed `from` zone (ownership + freshness check). Moving to `deck`
 * inserts at index 0 (top of deck) unless `deckPosition` says otherwise:
 * `'bottom'` appends, a number is a 1-based depth from the top (1 = on top,
 * max = current deck size + 1; out of range → error). `from === to` is a
 * no-op. When moving onto the table, `x`/`y` set the free-form landing
 * position (fractions of zone size); omitted or invalid → center.
 */
export function moveCard(
  lobby: Lobby,
  userId: string,
  instanceId: string,
  from: MoveFromZone,
  to: Zone,
  x?: number,
  y?: number,
  deckPosition?: 'top' | 'bottom' | number,
): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  if (from === to) return { ok: true, state };

  const source = player[from];
  const idx = source.findIndex((c) => c.id === instanceId);
  if (idx === -1) return { ok: false, message: 'Card not found' };

  // Validate the requested deck depth BEFORE removing the card, so a failed
  // move never strands it. The card is not in the deck (`from` can't be
  // 'deck'), so the max depth after removal is deck size + 1.
  if (to === 'deck' && typeof deckPosition === 'number') {
    const max = player.deck.length + 1;
    if (!Number.isInteger(deckPosition) || deckPosition < 1 || deckPosition > max) {
      return { ok: false, message: `Position must be between 1 and ${max}` };
    }
  }

  const [card] = source.splice(idx, 1);
  // A tapped card that leaves the table comes back untapped (and unplaced),
  // and all of its counters are removed.
  if (from === 'table') {
    card.tapped = false;
    delete card.tablePos;
    delete card.counters;
  }
  // Tokens can't exist off the table — moving one to hand/deck/graveyard
  // destroys it (it has already been removed from the table above).
  if (card.token && to !== 'table') {
    clearRoll(player);
    return { ok: true, state };
  }
  if (to === 'deck') {
    const pos = deckPosition ?? 'top';
    if (pos === 'bottom') player.deck.push(card);
    else if (typeof pos === 'number') player.deck.splice(pos - 1, 0, card);
    else player.deck.unshift(card);
  } else {
    // Entering the table: explicit drop position, or center by default.
    if (to === 'table') card.tablePos = clampTablePos(x, y) ?? { ...TABLE_CENTER };
    player[to].push(card);
  }
  clearRoll(player);
  return { ok: true, state };
}

/**
 * Toggle the tapped state of one of the requester's table cards. The instance
 * must exist on the requester's table (ownership + zone check); tapping is
 * only meaningful on the table.
 */
export function tapCard(lobby: Lobby, userId: string, instanceId: string): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  const card = player.table.find((c) => c.id === instanceId);
  if (!card) return { ok: false, message: 'Card not found' };
  clearRoll(player);
  card.tapped = !card.tapped;
  return { ok: true, state };
}

/**
 * Reposition one of the requester's cards that is already on their table.
 * The instance must exist on the requester's table (ownership + zone check)
 * and the target position must be finite (clamped into [0..1]²). Tapped state
 * is untouched — moving a tapped card keeps it tapped.
 */
export function placeCard(lobby: Lobby, userId: string, instanceId: string, x: number, y: number): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  const card = player.table.find((c) => c.id === instanceId);
  if (!card) return { ok: false, message: 'Card not found' };
  const pos = clampTablePos(x, y);
  if (!pos) return { ok: false, message: 'Invalid position' };
  clearRoll(player);
  card.tablePos = pos;
  return { ok: true, state };
}

/**
 * Set the counters on one of the requester's table cards. The instance must
 * exist on the requester's table (ownership + zone check); every color count
 * must be an integer in [0..MAX_COUNTERS_PER_COLOR]. An all-zero map clears
 * the card's counters. Counters only ever exist while a card is on its owner's
 * table — leaving the table removes them (see moveCard).
 */
export function setCounters(lobby: Lobby, userId: string, instanceId: string, raw: unknown): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  const card = player.table.find((c) => c.id === instanceId);
  if (!card) return { ok: false, message: 'Card not found' };

  const counters = normalizeCounters(raw);
  if (!counters) return { ok: false, message: 'Invalid counter count' };

  const total = COUNTER_COLORS.reduce((sum, color) => sum + counters[color], 0);
  clearRoll(player);
  if (total === 0) delete card.counters;
  else card.counters = counters;
  return { ok: true, state };
}

/** Max lengths for token fields. */
const TOKEN_NAME_MAX = 60;
const TOKEN_PT_MAX = 10;

/**
 * Create a token on the requester's table. Tokens have no image — they render
 * from their name plus power/toughness ("X/Y"). The new token starts at the
 * center of the table. Unlike real cards, a token is destroyed if it is moved
 * off the table (see moveCard).
 */
export function createToken(lobby: Lobby, userId: string, rawName: unknown, rawPower: unknown, rawToughness: unknown): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
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

  clearRoll(player);
  player.table.push({
    id: randomUUID(),
    name,
    scryfallOracleId: '',
    token: { power, toughness },
    tablePos: { ...TABLE_CENTER },
  });
  return { ok: true, state };
}

/**
 * Set the requester's life total. Only the player themselves may change it
 * (the op resolves the requester's own seat); the value must be an integer in
 * [0..MAX_LIFE]. Broadcast to all seats via state_update like every other op.
 */
export function setLife(lobby: Lobby, userId: string, raw: unknown): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0 || raw > MAX_LIFE) {
    return { ok: false, message: 'Invalid life total' };
  }
  clearRoll(player);
  player.life = raw;
  return { ok: true, state };
}

/**
 * Roll one of the requester's dice (d2/d4/d6/d8/d20). The result is stored on
 * the player (`lastRoll`) and broadcast like every other op — all players see
 * it. It stays visible until the player performs their next action, which
 * clears it (see clearRoll in each op). A new roll replaces an old one.
 */
export function rollDice(lobby: Lobby, userId: string, rawSides: unknown): MatchOpResult {
  const state = lobby.match;
  if (!state) return { ok: false, message: 'Match has not started yet' };
  const player = playerOf(state, userId);
  if (!player) return { ok: false, message: "You're not in this match" };
  const sides = typeof rawSides === 'number' ? rawSides : NaN;
  if (!(DICE_SIDES as readonly number[]).includes(sides)) {
    return { ok: false, message: `Invalid die — choose one of ${DICE_SIDES.join(', ')}` };
  }
  player.lastRoll = { value: randomInt(sides) + 1, sides: sides as DiceSides };
  return { ok: true, state };
}
