// ---------------------------------------------------------------------------
// Play websocket foundation (Phase 1) + lobby wiring (Phase 2).
//
// Attaches a WebSocketServer to the existing Express HTTP server on the
// /play path. Upgrades are authenticated with the same JWT used by the REST
// API; every message is routed through handleMessage(), which validates the
// JSON, resets the member's idle timer, and dispatches by type. Lobby intents
// go to the lobby manager (Phase 2); match intents plug in at Phase 3
// (see docs/plan.md §5).
// ---------------------------------------------------------------------------

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { Deck } from '../db';
import { createLobbyManager } from './lobbyManager';
import type { ClientMessage, ServerMessage } from './types';
import { PLAY_IDLE_TIMEOUT_MS } from './types';

/** Authenticated user attached to a play socket. */
export interface PlayUser {
  id: string;
  username: string;
}

/** A WebSocket with the authenticated user attached at upgrade time. */
export type PlaySocket = WebSocket & { user: PlayUser };

export interface PlayDeps {
  /** Verify a JWT and return the user, or null when missing/invalid/expired. */
  verifyToken(token: string): PlayUser | null;
  /** Return the deck only if it exists and belongs to `userId`. */
  getOwnedDeck(userId: string, deckId: string): Deck | null;
}

const CLIENT_MESSAGE_TYPES = new Set<string>([
  'create_lobby',
  'join_lobby',
  'leave_lobby',
  'start_match',
  'cancel_lobby',
  'draw',
  'shuffle',
  'move_card',
  'tap_card',
  'place_card',
  'set_counters',
  'create_token',
  'set_life',
  'roll_dice',
]);

/** Send a JSON message if the socket is open (no-throw by design). */
export function send(ws: PlaySocket, message: ServerMessage): void {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

export function attachPlay(httpServer: Server, deps: PlayDeps): void {
  const wss = new WebSocketServer({ noServer: true });

  /**
   * Latest socket per user. A second connection for the same user is accepted
   * (lobby membership — not sockets — is what's limited); it simply becomes
   * the registered socket until it closes.
   */
  const socketsByUser = new Map<string, PlaySocket>();

  const sendToUser = (userId: string, message: ServerMessage): void => {
    const ws = socketsByUser.get(userId);
    if (ws) send(ws, message);
  };

  const lobbyManager = createLobbyManager({ sendToUser });
  // Log the effective value at startup: a leaked shell variable (e.g.
  // PLAY_IDLE_TIMEOUT_MS=3000 from smoke testing) is otherwise invisible and
  // manifests as "lobby kicked me out after 5 seconds".
  console.log(`[play] lobby idle timeout: ${PLAY_IDLE_TIMEOUT_MS / 1000} s (set via PLAY_IDLE_TIMEOUT_MS)`);
  lobbyManager.startIdleSweep();

  wss.on('connection', (ws: WebSocket) => {
    const playSocket = ws as PlaySocket;
    const user = playSocket.user;
    socketsByUser.set(user.id, playSocket);
    console.log(`[play] hello: ${user.username} (${user.id}) connected`);

    playSocket.on('message', (data) => handleMessage(playSocket, data));
    playSocket.on('close', () => {
      if (socketsByUser.get(user.id) === playSocket) {
        socketsByUser.delete(user.id);
      }
      lobbyManager.handleDisconnect(user.id);
      console.log(`[play] bye: ${user.username} (${user.id}) disconnected`);
    });
    playSocket.on('error', (err) => {
      console.error(`[play] socket error for ${user.username}:`, err.message);
    });
  });

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      socket.destroy();
      return;
    }

    if (url.pathname !== '/play') {
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }

    const user = deps.verifyToken(url.searchParams.get('token') ?? '');
    if (!user) {
      const body = 'Unauthorized';
      socket.write(
        `HTTP/1.1 401 Unauthorized\r\nContent-Type: text/plain\r\nConnection: close\r\nContent-Length: ${body.length}\r\n\r\n${body}`,
      );
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      const playSocket = ws as PlaySocket;
      playSocket.user = user;
      wss.emit('connection', playSocket, req);
    });
  });

  // --- message router ------------------------------------------------------

  function handleMessage(ws: PlaySocket, raw: Buffer | ArrayBuffer | Buffer[]): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString());
    } catch {
      // Malformed JSON → error, ignore the message, keep the socket open.
      send(ws, { type: 'error', message: 'Malformed JSON' });
      return;
    }

    const msg = parsed as { type?: unknown } | null;
    if (typeof msg !== 'object' || msg === null || typeof msg.type !== 'string' || !CLIENT_MESSAGE_TYPES.has(msg.type)) {
      send(ws, { type: 'error', message: `Unknown message type: ${String(msg?.type)}` });
      return;
    }
    // Any well-formed message from a lobby member resets the idle timer.
    lobbyManager.touch(ws.user.id);

    dispatch(ws, parsed as ClientMessage);
  }

  function dispatch(ws: PlaySocket, msg: ClientMessage): void {
    console.log(`[play] ${ws.user.username} -> ${msg.type}`);
    switch (msg.type) {
      case 'create_lobby': {
        const deck = deps.getOwnedDeck(ws.user.id, msg.deckId);
        const result = lobbyManager.createLobby(ws.user, deck);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'join_lobby': {
        // deckId is only needed for waiting-lobby joins; seat rejoin ignores it.
        const deck = msg.deckId ? deps.getOwnedDeck(ws.user.id, msg.deckId) : null;
        const result = lobbyManager.joinLobby(ws.user, msg.code, deck);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'leave_lobby': {
        const result = lobbyManager.leaveLobby(ws.user.id);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'cancel_lobby': {
        const result = lobbyManager.cancelLobby(ws.user.id);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'start_match': {
        const result = lobbyManager.startMatch(ws.user);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'draw': {
        const result = lobbyManager.draw(ws.user.id);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'shuffle': {
        const result = lobbyManager.shuffleDeck(ws.user.id);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'move_card': {
        const result = lobbyManager.moveCard(ws.user.id, msg.instanceId, msg.from, msg.to, msg.x, msg.y, msg.deckPosition);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'tap_card': {
        const result = lobbyManager.tapCard(ws.user.id, msg.instanceId);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'place_card': {
        const result = lobbyManager.placeCard(ws.user.id, msg.instanceId, msg.x, msg.y);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'set_counters': {
        const result = lobbyManager.setCounters(ws.user.id, msg.instanceId, msg.counters);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'create_token': {
        const result = lobbyManager.createToken(ws.user.id, msg.name, msg.power, msg.toughness);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'set_life': {
        const result = lobbyManager.setLife(ws.user.id, msg.life);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
      case 'roll_dice': {
        const result = lobbyManager.rollDice(ws.user.id, msg.sides);
        if (!result.ok) send(ws, { type: 'error', message: result.message });
        break;
      }
    }
  }
}
