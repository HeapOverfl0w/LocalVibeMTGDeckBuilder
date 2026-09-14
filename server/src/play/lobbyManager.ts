// ---------------------------------------------------------------------------
// Lobby manager (Phase 2).
//
// Ephemeral, in-memory lobbies keyed by a 6-character code. No DB involved —
// on server restart all lobbies vanish (acceptable for v1). The match engine
// plugs into startMatch() in Phase 3 (see docs/plan.md §5).
// ---------------------------------------------------------------------------

import { randomInt } from 'node:crypto';
import type { Deck, DeckCard } from '../db';
import { buildMatchState, createToken as matchCreateToken, draw as matchDraw, moveCard as matchMove, placeCard as matchPlace, rollDice as matchRollDice, setCounters as matchSetCounters, setLife as matchSetLife, shuffleDeck as matchShuffle, tapCard as matchTap } from './match';
import type { MatchOpResult } from './match';
import type { CardCounters, LobbyInfo, MatchState, MoveFromZone, ServerMessage, SessionEndReason, Zone } from './types';
import { PLAY_IDLE_TIMEOUT_MS } from './types';
import type { PlayUser } from './ws';

/** 6-char lobby codes; the alphabet excludes 0/O/1/I/L to avoid confusion. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
export const MAX_PLAYERS = 4;
/**
 * Idle-sweep tick: every 30 s in production, but never slower than the timeout
 * itself — with a short PLAY_IDLE_TIMEOUT_MS (e.g. 3000 for smoke tests) the
 * sweep keeps pace so idle lobbies close within ~2× the timeout.
 */
const SWEEP_INTERVAL_MS = Math.min(30_000, PLAY_IDLE_TIMEOUT_MS);

/** Snapshot of a deck taken at join time — later edits never affect the lobby. */
export interface DeckSnapshot {
  cards: DeckCard[];
  commander?: string;
}

export interface LobbySeat {
  userId: string;
  username: string;
  deckId: string;
  deckName: string;
  deckSnapshot: DeckSnapshot;
  connected: boolean;
}

export interface Lobby {
  code: string;
  hostId: string;
  status: 'waiting' | 'active';
  /** Join order matters — host promotion uses players[0] of the remainder. */
  players: LobbySeat[];
  match?: MatchState;
  lastActivityAt: number;
}

export type LobbyResult = { ok: true } | { ok: false; message: string };

export interface LobbyManagerDeps {
  sendToUser(userId: string, message: ServerMessage): void;
}

export function createLobbyManager(deps: LobbyManagerDeps) {
  const lobbies = new Map<string, Lobby>();

  // --- helpers -------------------------------------------------------------

  function generateCode(): string {
    for (;;) {
      let code = '';
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      }
      if (!lobbies.has(code)) return code;
    }
  }

  function toInfo(lobby: Lobby): LobbyInfo {
    return {
      code: lobby.code,
      status: lobby.status,
      hostId: lobby.hostId,
      players: lobby.players.map((p) => ({
        userId: p.userId,
        username: p.username,
        deckName: p.deckName,
        connected: p.connected,
      })),
    };
  }

  function lobbyByUser(userId: string): Lobby | undefined {
    for (const lobby of lobbies.values()) {
      if (lobby.players.some((p) => p.userId === userId)) return lobby;
    }
    return undefined;
  }

  function broadcastLobbyUpdate(lobby: Lobby): void {
    const info = toInfo(lobby);
    for (const seat of lobby.players) {
      if (seat.connected) deps.sendToUser(seat.userId, { type: 'lobby_update', lobby: info });
    }
  }

  function broadcastStateUpdate(lobby: Lobby): void {
    if (!lobby.match) return;
    for (const seat of lobby.players) {
      if (seat.connected) deps.sendToUser(seat.userId, { type: 'state_update', state: lobby.match });
    }
  }

  /**
   * Keep MatchState players' `connected` flags in sync with their seats.
   * Call immediately after any seat.connected change, before broadcasting —
   * the match state holds its own copy built at start time and would
   * otherwise drift (ghosted players reporting as connected).
   */
  function syncMatchConnected(lobby: Lobby): void {
    if (!lobby.match) return;
    for (const p of lobby.match.players) {
      const seat = lobby.players.find((s) => s.userId === p.userId);
      if (seat) p.connected = seat.connected;
    }
  }

  function closeLobby(lobby: Lobby, reason: SessionEndReason, message: string): void {
    // Notify every seat that still has a live socket — including ghosted ones
    // (e.g. a player who left mid-match but whose tab is still connected), so
    // no client keeps stale "you're in a match" state. sendToUser no-ops for
    // users with no open socket, so truly disconnected ghosts are skipped.
    for (const seat of lobby.players) {
      deps.sendToUser(seat.userId, { type: 'session_end', reason, message });
    }
    lobbies.delete(lobby.code);
  }

  function makeSeat(user: PlayUser, deck: Deck): LobbySeat {
    return {
      userId: user.id,
      username: user.username,
      deckId: deck.id,
      deckName: deck.name,
      deckSnapshot: {
        cards: deck.cards.map((c) => ({ ...c })),
        ...(deck.commander ? { commander: deck.commander } : {}),
      },
      connected: true,
    };
  }

  /**
   * Remove `userId` from their current lobby using leave semantics: waiting
   * lobbies drop the seat entirely (with host promotion), active matches ghost
   * it — cards stay put, the other players keep going, and the idle sweep
   * eventually closes the lobby. Called before create/join so an old lobby
   * never blocks a player from starting a new one.
   */
  function detachFromCurrentLobby(userId: string): void {
    const lobby = lobbyByUser(userId);
    if (!lobby) return;
    const seat = lobby.players.find((p) => p.userId === userId);
    if (!seat) return;

    if (lobby.status === 'active') {
      // Ghost the leaver; their cards stay put.
      seat.connected = false;
      syncMatchConnected(lobby);
      broadcastStateUpdate(lobby);
      return;
    }

    lobby.players.splice(lobby.players.indexOf(seat), 1);
    lobby.lastActivityAt = Date.now();
    if (lobby.players.length === 0) {
      lobbies.delete(lobby.code); // nobody left — nothing to broadcast
      return;
    }
    if (lobby.hostId === userId) {
      lobby.hostId = lobby.players[0].userId; // earliest-joined remaining player
    }
    broadcastLobbyUpdate(lobby);
  }

  // --- lifecycle -----------------------------------------------------------

  function createLobby(user: PlayUser, deck: Deck | null): LobbyResult {
    if (!deck) return { ok: false, message: 'Deck not found' };
    if (deck.cards.length === 0) return { ok: false, message: 'Your deck has no cards' };

    // Creating a lobby implicitly leaves any current one — players are never
    // stuck in an old (e.g. ghosted) seat.
    detachFromCurrentLobby(user.id);

    const lobby: Lobby = {
      code: generateCode(),
      hostId: user.id,
      status: 'waiting',
      players: [makeSeat(user, deck)],
      lastActivityAt: Date.now(),
    };
    lobbies.set(lobby.code, lobby);
    deps.sendToUser(user.id, { type: 'lobby_joined', lobby: toInfo(lobby) });
    return { ok: true };
  }

  function joinLobby(user: PlayUser, codeRaw: string, deck: Deck | null): LobbyResult {
    const lobby = lobbies.get(codeRaw.trim().toUpperCase());
    if (!lobby) return { ok: false, message: 'Lobby not found' };

    const seat = lobby.players.find((p) => p.userId === user.id);
    if (seat) {
      if (seat.connected) {
        // Re-entering your own live lobby (e.g. a second tab) — resync this
        // socket instead of erroring; nothing changed for the other players.
        lobby.lastActivityAt = Date.now();
        if (lobby.status === 'active') {
          if (lobby.match) deps.sendToUser(user.id, { type: 'state_update', state: lobby.match });
        } else {
          deps.sendToUser(user.id, { type: 'lobby_joined', lobby: toInfo(lobby) });
        }
        return { ok: true };
      }
      // Reconnect of a ghosted seat (re-entering the code after a disconnect).
      seat.connected = true;
      lobby.lastActivityAt = Date.now();
      syncMatchConnected(lobby);
      if (lobby.status === 'active') {
        if (lobby.match) {
          deps.sendToUser(user.id, { type: 'state_update', state: lobby.match }); // full resync
          broadcastStateUpdate(lobby);
        }
      } else {
        deps.sendToUser(user.id, { type: 'lobby_joined', lobby: toInfo(lobby) });
        broadcastLobbyUpdate(lobby);
      }
      return { ok: true };
    }

    // New seat: validate first so a failed join never strands the user in
    // their old lobby.
    if (lobby.status === 'active') return { ok: false, message: 'Match already in progress' };
    if (lobby.players.length >= MAX_PLAYERS) return { ok: false, message: 'Lobby is full' };
    if (!deck) return { ok: false, message: 'A deck is required to join a lobby' };
    if (deck.cards.length === 0) return { ok: false, message: 'Your deck has no cards' };

    // All good — leave any *other* current lobby first, then take the seat.
    const current = lobbyByUser(user.id);
    if (current && current.code !== lobby.code) detachFromCurrentLobby(user.id);

    lobby.players.push(makeSeat(user, deck));
    lobby.lastActivityAt = Date.now();
    deps.sendToUser(user.id, { type: 'lobby_joined', lobby: toInfo(lobby) });
    broadcastLobbyUpdate(lobby);
    return { ok: true };
  }

  function leaveLobby(userId: string): LobbyResult {
    const lobby = lobbyByUser(userId);
    if (!lobby || !lobby.players.some((p) => p.userId === userId)) return { ok: false, message: "You're not in a lobby" };
    detachFromCurrentLobby(userId);
    return { ok: true };
  }

  function cancelLobby(userId: string): LobbyResult {
    const lobby = lobbyByUser(userId);
    if (!lobby) return { ok: false, message: "You're not in a lobby" };
    if (lobby.status !== 'waiting') return { ok: false, message: 'Match already in progress' };
    if (lobby.hostId !== userId) return { ok: false, message: 'Only the host can cancel the lobby' };
    closeLobby(lobby, 'host_cancelled', 'The host cancelled the lobby');
    return { ok: true };
  }

  function startMatch(user: PlayUser): LobbyResult {
    const lobby = lobbyByUser(user.id);
    if (!lobby) return { ok: false, message: "You're not in a lobby" };
    if (lobby.status !== 'waiting') return { ok: false, message: 'Match already in progress' };
    if (lobby.hostId !== user.id) return { ok: false, message: 'Only the host can start the match' };
    if (lobby.players.length < 2) return { ok: false, message: 'Need at least 2 players to start' };

    const state = buildMatchState(lobby);
    lobby.status = 'active';
    lobby.match = state;
    lobby.lastActivityAt = Date.now();
    for (const seat of lobby.players) {
      if (seat.connected) deps.sendToUser(seat.userId, { type: 'match_start', state });
    }
    return { ok: true };
  }

  // --- match operations (Phase 3) ------------------------------------------

  /** Resolve the caller's active lobby, or a standard error. */
  function activeLobbyFor(userId: string): { lobby: Lobby } | { error: string } {
    const lobby = lobbyByUser(userId);
    if (!lobby) return { error: "You're not in a lobby" };
    if (lobby.status !== 'active' || !lobby.match) return { error: 'Match has not started yet' };
    return { lobby };
  }

  function draw(userId: string): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchDraw(resolved.lobby, userId);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function shuffleDeck(userId: string): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchShuffle(resolved.lobby, userId);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function moveCard(
    userId: string,
    instanceId: string,
    from: MoveFromZone,
    to: Zone,
    x?: number,
    y?: number,
    deckPosition?: 'top' | 'bottom' | number,
  ): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchMove(resolved.lobby, userId, instanceId, from, to, x, y, deckPosition);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function tapCard(userId: string, instanceId: string): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchTap(resolved.lobby, userId, instanceId);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function placeCard(userId: string, instanceId: string, x: number, y: number): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchPlace(resolved.lobby, userId, instanceId, x, y);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function setCounters(userId: string, instanceId: string, counters: CardCounters): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchSetCounters(resolved.lobby, userId, instanceId, counters);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function createToken(userId: string, name: string, power: string, toughness: string): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchCreateToken(resolved.lobby, userId, name, power, toughness);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function setLife(userId: string, raw: unknown): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchSetLife(resolved.lobby, userId, raw);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  function rollDice(userId: string, sides: unknown): MatchOpResult {
    const resolved = activeLobbyFor(userId);
    if ('error' in resolved) return { ok: false, message: resolved.error };
    const result = matchRollDice(resolved.lobby, userId, sides);
    if (result.ok) broadcastStateUpdate(resolved.lobby);
    return result;
  }

  /** Socket closed for a user: ghost their seat (or close an all-ghost waiting lobby). */
  function handleDisconnect(userId: string): void {
    const lobby = lobbyByUser(userId);
    if (!lobby) return;
    const seat = lobby.players.find((p) => p.userId === userId);
    if (!seat || !seat.connected) return;
    seat.connected = false;
    syncMatchConnected(lobby);

    if (lobby.status === 'waiting') {
      if (!lobby.players.some((p) => p.connected)) {
        lobbies.delete(lobby.code); // all seats disconnected while waiting → close immediately
        return;
      }
      broadcastLobbyUpdate(lobby);
    } else {
      // Active: others see the gray dot; the ghost persists until the idle sweep closes the lobby.
      broadcastStateUpdate(lobby);
    }
  }

  /** Any well-formed message from a lobby member resets the idle timer. */
  function touch(userId: string): void {
    const lobby = lobbyByUser(userId);
    if (lobby) lobby.lastActivityAt = Date.now();
  }

  // --- idle sweep ----------------------------------------------------------

  /** Human phrasing for an idle duration ("5 seconds", "10 minutes", ...). */
  function formatIdleMs(ms: number): string {
    const s = Math.round(ms / 1000);
    if (s < 60) return `${s} second${s === 1 ? '' : 's'}`;
    const m = Math.round(s / 60);
    if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
    const h = Math.round(m / 60);
    return `${h} hour${h === 1 ? '' : 's'}`;
  }

  /**
   * Single interval closing any lobby (waiting or active) that has had no
   * activity for PLAY_IDLE_TIMEOUT_MS. Started once from attachPlay(). The
   * close message reports the ACTUAL idle time — with a misconfigured
   * (too-small) timeout, "closed after 5 seconds of inactivity" tells the
   * player something is wrong instead of claiming 10 minutes passed.
   */
  function startIdleSweep(): NodeJS.Timeout {
    const timer = setInterval(() => {
      const now = Date.now();
      for (const lobby of [...lobbies.values()]) {
        if (now - lobby.lastActivityAt > PLAY_IDLE_TIMEOUT_MS) {
          closeLobby(lobby, 'idle_timeout', `Lobby closed after ${formatIdleMs(now - lobby.lastActivityAt)} of inactivity`);
        }
      }
    }, SWEEP_INTERVAL_MS);
    timer.unref();
    return timer;
  }

  return {
    createLobby,
    joinLobby,
    leaveLobby,
    cancelLobby,
    startMatch,
    draw,
    shuffleDeck,
    moveCard,
    tapCard,
    placeCard,
    setCounters,
    createToken,
    setLife,
    rollDice,
    handleDisconnect,
    touch,
    lobbyByUser,
    toInfo,
    startIdleSweep,
  };
}
