// ---------------------------------------------------------------------------
// Play session provider (Phase 4, Step 4.4; mock mode Phase 8).
//
// Owns the play session state machine + socket ABOVE <Routes>, so a running
// lobby/match survives route changes (nav clicks, back button, typed URLs).
// Mounted for the whole authenticated app only — inert otherwise.
//
// Intent dispatch: multiplayer intents go through the socket; mock intents
// call gameLogic.ts locally and set match state directly (no socket).
// ---------------------------------------------------------------------------

import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import type { CardCounters, ClientMessage, Deck, DiceSides, LobbyInfo, MatchState, MoveFromZone, ServerMessage, TablePos, Zone } from '../../types';
import { getUserId } from '../../api';
import { usePlaySocket } from './usePlaySocket';
import type { PlaySocket } from './usePlaySocket';
import { createMockMatch, createToken as logicCreateToken, draw as logicDraw, moveCard as logicMove, placeCard as logicPlace, rollDice as logicRollDice, setCounters as logicSetCounters, setLife as logicSetLife, shuffleDeck as logicShuffle, tapCard as logicTap } from './gameLogic';

export type PlayPhase = 'landing' | 'lobby' | 'game';
export type PlayMode = 'mock' | 'multiplayer';

export interface PlaySessionValue {
  phase: PlayPhase;
  mode: PlayMode;
  lobby: LobbyInfo | null;
  match: MatchState | null;
  /** Deck used for the current mock session. */
  mockDeck: Deck | null;
  /** Persistent banner (session_end) — dismissed explicitly. */
  banner: string | null;
  /** Transient toast (server error) — auto-dismisses. */
  toast: string | null;

  hostLobby(deckId: string): void;
  joinLobby(code: string, deckId: string): void;
  startMock(deck: Deck): void;
  leaveLobby(): void;
  cancelLobby(): void;
  startMatch(): void;
  draw(): void;
  shuffle(): void;
  moveCard(instanceId: string, from: MoveFromZone, to: Zone, pos?: TablePos, deckPosition?: 'top' | 'bottom' | number): void;
  /** Toggle the tapped state of one of your table cards. */
  tapCard(instanceId: string): void;
  /** Reposition one of your cards that is already on your table (fractions of zone size). */
  placeCard(instanceId: string, x: number, y: number): void;
  /** Set the counters on one of your table cards (each color count 0..99; all-zero clears). */
  setCounters(instanceId: string, counters: CardCounters): void;
  /** Create a token on your table (no image — name + power/toughness "X/Y"). */
  createToken(name: string, power: string, toughness: string): void;
  /** Set your life total (integer in [0..999]). */
  setLife(life: number): void;
  /** Roll one of your dice (d2/d4/d6/d8/d20) — result is visible to all players. */
  rollDice(sides: DiceSides): void;
  dismissBanner(): void;
}

const PlaySessionContext = createContext<PlaySessionValue | null>(null);

export function usePlaySession(): PlaySessionValue {
  const ctx = useContext(PlaySessionContext);
  if (!ctx) throw new Error('usePlaySession must be used inside <PlaySessionProvider>');
  return ctx;
}

export function PlaySessionProvider({ username, children }: { username: string; children: ReactNode }) {
  const [phase, setPhase] = useState<PlayPhase>('landing');
  const [mode, setMode] = useState<PlayMode>('multiplayer');
  const [lobby, setLobby] = useState<LobbyInfo | null>(null);
  const [match, setMatch] = useState<MatchState | null>(null);
  const [mockDeck, setMockDeck] = useState<Deck | null>(null);
  const [banner, setBanner] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // Refs so the socket's handlers always see current values without re-subscribing.
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const lobbyRef = useRef(lobby);
  lobbyRef.current = lobby;
  // Ref for mock intents — local ops need the current match without re-creating handlers.
  const matchRef = useRef(match);
  matchRef.current = match;

  // The socket is created below; the message handler reaches it via this ref.
  const socketRef = useRef<PlaySocket | null>(null);

  // Transient toasts auto-dismiss.
  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 5000);
    return () => window.clearTimeout(t);
  }, [toast]);

  function handleMessage(msg: ServerMessage): void {
    switch (msg.type) {
      case 'lobby_joined':
      case 'lobby_update':
        setLobby(msg.lobby);
        setPhase('lobby');
        break;
      case 'match_start':
      case 'state_update':
        setMatch(msg.state);
        setPhase('game');
        break;
      case 'session_end':
        // The server closed the session (idle timeout, host cancel, empty).
        setPhase('landing');
        setLobby(null);
        setMatch(null);
        setBanner(msg.message);
        socketRef.current?.disconnect(); // stop reconnecting — there is nothing to resync to
        break;
      case 'error':
        setToast(msg.message);
        break;
    }
  }

  const socket = usePlaySocket({
    onMessage: handleMessage,
    shouldReconnect: () => phaseRef.current !== 'landing',
    getResyncCode: () => (phaseRef.current !== 'landing' ? (lobbyRef.current?.code ?? null) : null),
    // Phase 9, Step 9.1: the session we were rejoining is gone (e.g. the lobby
    // was idle-closed while away) — banner + landing, no more reconnecting.
    onResyncFailed: (message) => {
      setPhase('landing');
      setLobby(null);
      setMatch(null);
      setBanner(message);
      socketRef.current?.disconnect();
    },
  });
  socketRef.current = socket;

  function hostLobby(deckId: string): void {
    setMode('multiplayer');
    socket.connect();
    socket.send({ type: 'create_lobby', deckId }); // lobby_joined flips phase to 'lobby'
  }

  function joinLobby(code: string, deckId: string): void {
    setMode('multiplayer');
    socket.connect();
    socket.send({ type: 'join_lobby', code, deckId }); // lobby_joined flips phase to 'lobby'
  }

  function startMock(deck: Deck): void {
    // Phase 8: build the local match state — GameTable renders it exactly like
    // a multiplayer match (same seat lookup via getUserId()).
    const myId = getUserId();
    if (!myId) return; // unauthenticated — provider shouldn't be mounted
    setMode('mock');
    setMockDeck(deck);
    setMatch(createMockMatch(deck, username, myId));
    setPhase('game');
  }

  /** Apply a local game op in mock mode; ok → new state, error → toast. */
  function applyLocal(
    op: (state: MatchState, userId: string) => { ok: true; state: MatchState } | { ok: false; message: string },
  ): void {
    const state = matchRef.current;
    const myId = getUserId();
    if (!state || !myId) return;
    const result = op(state, myId);
    if (result.ok) setMatch(result.state);
    else setToast(result.message);
  }

  function leaveLobby(): void {
    if (modeRef.current === 'mock') {
      // "Exit" — local reset only, no socket involved.
      setPhase('landing');
      setMatch(null);
      setMockDeck(null);
      return;
    }
    socket.send({ type: 'leave_lobby' }); // server ghosts the seat; cards stay put
    setPhase('landing');
    setLobby(null);
    setMatch(null);
    socket.disconnect(); // we're done with this session — no reconnects
  }

  function cancelLobby(): void {
    socket.send({ type: 'cancel_lobby' }); // session_end (host_cancelled) flips to landing + banner
  }

  function startMatch(): void {
    socket.send({ type: 'start_match' }); // match_start broadcast flips everyone to the game view
  }

  function draw(): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicDraw(state, userId));
      return;
    }
    socket.send({ type: 'draw' });
  }

  function shuffle(): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicShuffle(state, userId));
      return;
    }
    socket.send({ type: 'shuffle' });
  }

  function moveCard(instanceId: string, from: MoveFromZone, to: Zone, pos?: TablePos, deckPosition?: 'top' | 'bottom' | number): void {
    if (modeRef.current === 'mock') {
      applyLocal((state) => logicMove(state, instanceId, from, to, pos, deckPosition));
      return;
    }
    const msg: ClientMessage = { type: 'move_card', instanceId, from, to };
    // Only meaningful when landing on the table.
    if (to === 'table' && pos) {
      msg.x = pos.x;
      msg.y = pos.y;
    }
    // Only meaningful when landing in the deck.
    if (to === 'deck' && deckPosition !== undefined) {
      msg.deckPosition = deckPosition;
    }
    socket.send(msg);
  }

  function tapCard(instanceId: string): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicTap(state, userId, instanceId));
      return;
    }
    socket.send({ type: 'tap_card', instanceId });
  }

  function placeCard(instanceId: string, x: number, y: number): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicPlace(state, userId, instanceId, x, y));
      return;
    }
    socket.send({ type: 'place_card', instanceId, x, y });
  }

  function setCounters(instanceId: string, counters: CardCounters): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicSetCounters(state, userId, instanceId, counters));
      return;
    }
    socket.send({ type: 'set_counters', instanceId, counters });
  }

  function createToken(name: string, power: string, toughness: string): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicCreateToken(state, userId, name, power, toughness));
      return;
    }
    socket.send({ type: 'create_token', name, power, toughness });
  }

  function setLife(life: number): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicSetLife(state, userId, life));
      return;
    }
    socket.send({ type: 'set_life', life });
  }

  function rollDice(sides: DiceSides): void {
    if (modeRef.current === 'mock') {
      applyLocal((state, userId) => logicRollDice(state, userId, sides));
      return;
    }
    socket.send({ type: 'roll_dice', sides });
  }

  function dismissBanner(): void {
    setBanner(null);
  }

  const value = useMemo<PlaySessionValue>(
    () => ({
      phase,
      mode,
      lobby,
      match,
      mockDeck,
      banner,
      toast,
      hostLobby,
      joinLobby,
      startMock,
      leaveLobby,
      cancelLobby,
      startMatch,
      draw,
      shuffle,
      moveCard,
      tapCard,
      placeCard,
      setCounters,
      createToken,
      setLife,
      rollDice,
      dismissBanner,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intent fns are stable in practice (refs + socket)
    [phase, mode, lobby, match, mockDeck, banner, toast],
  );

  // Floating "return to match" pill: active session while away from /play.
  const location = useLocation();
  const navigate = useNavigate();
  const showPill = phase !== 'landing' && location.pathname !== '/play';

  return (
    <PlaySessionContext.Provider value={value}>
      {children}
      {showPill && (
        <button className="play-return-pill" onClick={() => navigate('/play')}>
          ⚔️ Match in progress — Return
        </button>
      )}
    </PlaySessionContext.Provider>
  );
}
