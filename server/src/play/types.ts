// ---------------------------------------------------------------------------
// Play shared types (server side).
//
// The client keeps a hand-mirrored copy of these shapes in
// client/src/types.ts — there is no shared package in this repo
// (see docs/plan.md §4).
// ---------------------------------------------------------------------------

/** A normalized point inside the table zone (fractions of width/height, 0..1). */
export interface TablePos {
  x: number;
  y: number;
}

/** The five counter colors. Order matters — it is the render order of the pip column. */
export type CounterColor = 'blue' | 'red' | 'green' | 'white' | 'black';

/** The dice a player may roll (d2, d4, d6, d8, d20). */
export const DICE_SIDES = [2, 4, 6, 8, 20] as const;
export type DiceSides = (typeof DICE_SIDES)[number];

/** The result of a player's last dice roll — shown to everyone until the player acts again. */
export interface RollResult {
  value: number;
  sides: DiceSides;
}

export const COUNTER_COLORS: CounterColor[] = ['blue', 'red', 'green', 'white', 'black'];

/** Counters on a table card — one count per color. Only present while the card is on the table. */
export interface CardCounters {
  blue: number;
  red: number;
  green: number;
  white: number;
  black: number;
}

/** A player-made token (no image — rendered from name + power/toughness). */
export interface TokenInfo {
  power: string;
  toughness: string;
}

/** A physical copy of a card inside a match. */
export interface CardInstance {
  /** uuid — unique per physical copy. */
  id: string;
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
  type?: string;
  /** Tapped (rotated 90°) while on the table; cleared when the card leaves the table. */
  tapped?: boolean;
  /** Free-form position on the table (fractions of zone width/height). Only set while on the table. */
  tablePos?: TablePos;
  /** Counters while on the table; removed when the card leaves the table. */
  counters?: CardCounters;
  /** Present on tokens only — they live on the table and are destroyed if moved off it. */
  token?: TokenInfo;
}

/** One player's zones in a match. The client finds itself by userId. */
export interface PlayerMatchState {
  userId: string;
  username: string;
  /** false = ghosted (disconnected). */
  connected: boolean;
  /** Life total — starts at STARTING_LIFE, editable only by the player themselves. */
  life: number;
  /** The player's last dice roll (visible to all players); cleared when they perform their next action. */
  lastRoll?: RollResult;
  /** Index 0 = top of deck. */
  deck: CardInstance[];
  hand: CardInstance[];
  /** The player's own "table" zone (battlefield). */
  table: CardInstance[];
  graveyard: CardInstance[];
}

export interface MatchState {
  players: PlayerMatchState[];
}

// ---------------------------------------------------------------------------
// Lobby (public info only)
// ---------------------------------------------------------------------------

export type LobbyStatus = 'waiting' | 'active';

export interface LobbyPlayerInfo {
  userId: string;
  username: string;
  deckName: string;
  connected: boolean;
}

export interface LobbyInfo {
  code: string;
  status: LobbyStatus;
  hostId: string;
  players: LobbyPlayerInfo[];
}

// ---------------------------------------------------------------------------
// Zones & moves
// ---------------------------------------------------------------------------

export type Zone = 'hand' | 'table' | 'deck' | 'graveyard';

/** Zones a card may be moved *from* (you never move a card out of your deck). */
export type MoveFromZone = Exclude<Zone, 'deck'>;

// ---------------------------------------------------------------------------
// Client → server messages (intents)
// ---------------------------------------------------------------------------

export interface CreateLobbyMessage {
  type: 'create_lobby';
  deckId: string;
}

export interface JoinLobbyMessage {
  type: 'join_lobby';
  code: string;
  /** Required when joining a waiting lobby; ignored for seat rejoin. */
  deckId?: string;
}

export interface LeaveLobbyMessage {
  type: 'leave_lobby';
}

export interface StartMatchMessage {
  type: 'start_match';
}

export interface CancelLobbyMessage {
  type: 'cancel_lobby';
}

export interface DrawMessage {
  type: 'draw';
}

export interface ShuffleMessage {
  type: 'shuffle';
}

export interface MoveCardMessage {
  type: 'move_card';
  instanceId: string;
  from: MoveFromZone;
  to: Zone;
  /** When `to === 'table'`: where the card lands (fractions of zone size, 0..1). Omitted → center. */
  x?: number;
  y?: number;
  /**
   * When `to === 'deck'`: where in the deck the card goes. `'top'` (default),
   * `'bottom'`, or a 1-based depth from the top (1 = on top, max = deck size + 1).
   */
  deckPosition?: 'top' | 'bottom' | number;
}

export interface TapCardMessage {
  type: 'tap_card';
  /** The card must be on the requester's table. */
  instanceId: string;
}

/** Reposition one of the requester's cards that is already on their table. */
export interface PlaceCardMessage {
  type: 'place_card';
  instanceId: string;
  /** New position, fractions of zone width/height (0..1). */
  x: number;
  y: number;
}

/** Set the counters on one of the requester's table cards (each count 0..99). */
export interface SetCountersMessage {
  type: 'set_counters';
  /** The card must be on the requester's table. */
  instanceId: string;
  counters: CardCounters;
}

/** Create a token on the requester's table (no image — name + power/toughness). */
export interface CreateTokenMessage {
  type: 'create_token';
  name: string;
  power: string;
  toughness: string;
}

/** Set the requester's life total (integer in [0..MAX_LIFE]). */
export interface SetLifeMessage {
  type: 'set_life';
  life: number;
}

/** Roll one of the requester's dice (sides must be one of DICE_SIDES). */
export interface RollDiceMessage {
  type: 'roll_dice';
  sides: DiceSides;
}

export type ClientMessage =
  | CreateLobbyMessage
  | JoinLobbyMessage
  | LeaveLobbyMessage
  | StartMatchMessage
  | CancelLobbyMessage
  | DrawMessage
  | ShuffleMessage
  | MoveCardMessage
  | TapCardMessage
  | PlaceCardMessage
  | SetCountersMessage
  | CreateTokenMessage
  | SetLifeMessage
  | RollDiceMessage;

// ---------------------------------------------------------------------------
// Server → client messages
// ---------------------------------------------------------------------------

export interface LobbyJoinedMessage {
  type: 'lobby_joined';
  lobby: LobbyInfo;
}

export interface LobbyUpdateMessage {
  type: 'lobby_update';
  lobby: LobbyInfo;
}

export interface MatchStartMessage {
  type: 'match_start';
  state: MatchState;
}

export interface StateUpdateMessage {
  type: 'state_update';
  state: MatchState;
}

export type SessionEndReason = 'idle_timeout' | 'host_cancelled' | 'lobby_empty';

export interface SessionEndMessage {
  type: 'session_end';
  reason: SessionEndReason;
  message: string;
}

export interface ErrorMessage {
  type: 'error';
  message: string;
}

export type ServerMessage =
  | LobbyJoinedMessage
  | LobbyUpdateMessage
  | MatchStartMessage
  | StateUpdateMessage
  | SessionEndMessage
  | ErrorMessage;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Idle timeout for lobbies (waiting or active): after this long without any
 * client action the lobby is closed. Exposed as an env var so tests can
 * shrink it (default 10 minutes).
 *
 * Degenerate values are rejected, not honored: PLAY_IDLE_TIMEOUT_MS='' or 0
 * would parse to 0 and close every lobby on the first sweep tick (a leaked
 * test value in the shell is the classic way this bites — see Step 10.12).
 * Anything below 1 s falls back to the default with a warning.
 */
const DEFAULT_IDLE_TIMEOUT_MS = 600_000;
const rawIdleTimeout = Number(process.env.PLAY_IDLE_TIMEOUT_MS ?? DEFAULT_IDLE_TIMEOUT_MS);
export const PLAY_IDLE_TIMEOUT_MS: number =
  Number.isFinite(rawIdleTimeout) && rawIdleTimeout >= 1000 ? rawIdleTimeout : DEFAULT_IDLE_TIMEOUT_MS;
if (PLAY_IDLE_TIMEOUT_MS !== rawIdleTimeout) {
  console.warn(
    `[play] PLAY_IDLE_TIMEOUT_MS=${JSON.stringify(process.env.PLAY_IDLE_TIMEOUT_MS)} is not a usable value (need >= 1000 ms) — using the ${DEFAULT_IDLE_TIMEOUT_MS / 60000}-minute default.`,
  );
}
