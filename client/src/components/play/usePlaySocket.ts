// ---------------------------------------------------------------------------
// Play socket wrapper (Phase 4, Step 4.2; resync-failure reporting Phase 9).
//
// Thin wrapper around the /play websocket: connects with the stored JWT,
// exposes send(intent), parses server messages (guarding against non-JSON),
// and — when the caller says we're in a lobby/match — retries an unexpected
// close with capped exponential backoff for up to ~3 minutes. After each
// successful reopen it resyncs by sending `join_lobby { code }` if we hold a
// code. If that resync is rejected (e.g. the lobby was idle-closed while we
// were away), the first message after open is an error and it is reported via
// onResyncFailed instead of onMessage — the caller then surfaces a banner and
// returns to landing rather than reconnecting forever. Stopping is policy:
// the caller flips shouldReconnect() off (e.g. on session_end / return to
// landing) and/or calls disconnect().
// ---------------------------------------------------------------------------

import { useEffect, useRef } from 'react';
import { getToken } from '../../api';
import type { ClientMessage, ServerMessage } from '../../types';

const RECONNECT_BACKOFF_MS = [1000, 2000, 4000, 8000, 15000]; // capped at 15s
const RECONNECT_BUDGET_MS = 180_000; // ~3 minutes of total retrying

export interface PlaySocketHandlers {
  /** Called for every parsed server message. */
  onMessage: (msg: ServerMessage) => void;
  /** Whether an unexpected close should trigger a reconnect attempt. */
  shouldReconnect: () => boolean;
  /** If we hold a lobby code, resync with `join_lobby { code }` after each reopen. */
  getResyncCode: () => string | null;
  /** Called when the post-reopen resync is rejected (session is gone). */
  onResyncFailed?: (message: string) => void;
}

export interface PlaySocket {
  /** Open the socket (no-op if one is already open/connecting). */
  connect: () => void;
  /** Send an intent; dropped silently if the socket isn't open. */
  send: (intent: ClientMessage) => void;
  /** Intentionally close the socket and cancel any pending reconnects. */
  disconnect: () => void;
}

export function usePlaySocket(handlers: PlaySocketHandlers): PlaySocket {
  const wsRef = useRef<WebSocket | null>(null);
  const timerRef = useRef<number | null>(null);
  const attemptRef = useRef(0);
  const budgetStartRef = useRef<number | null>(null);
  const intentionalRef = useRef(false);
  // True while the post-reopen `join_lobby { code }` resync is in flight; the
  // first parsed message settles it (error → onResyncFailed, else normal flow).
  const resyncPendingRef = useRef(false);
  // Intents sent while the socket is still CONNECTING. They are flushed in
  // order once open — otherwise hostLobby/joinLobby (which send their intent
  // immediately after connect()) would drop it silently, since a fresh
  // WebSocket is not OPEN until an async round-trip completes.
  const pendingRef = useRef<ClientMessage[]>([]);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  function clearTimer(): void {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }

  /** Send queued intents, in order, on a socket that just opened. */
  function flushPending(ws: WebSocket): void {
    for (const intent of pendingRef.current) ws.send(JSON.stringify(intent));
    pendingRef.current = [];
  }

  function openSocket(): void {
    const token = getToken();
    if (!token) return;
    const existing = wsRef.current;
    if (existing && (existing.readyState === WebSocket.CONNECTING || existing.readyState === WebSocket.OPEN)) return;

    intentionalRef.current = false;
    resyncPendingRef.current = false;
    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${window.location.host}/play?token=${encodeURIComponent(token)}`);
    wsRef.current = ws;

    ws.onopen = () => {
      // Successful (re)connect: reset backoff, then resync our seat if we hold a code.
      attemptRef.current = 0;
      budgetStartRef.current = null;
      const code = handlersRef.current.getResyncCode();
      if (code) {
        ws.send(JSON.stringify({ type: 'join_lobby', code }));
        resyncPendingRef.current = true;
      }
      // Queued intents go out after the resync — a rejoining seat must be
      // registered before its match intents are processed.
      flushPending(ws);
    };

    ws.onmessage = (ev: MessageEvent) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(ev.data));
      } catch {
        return; // guard against non-JSON frames
      }
      if (parsed !== null && typeof parsed === 'object' && 'type' in parsed) {
        const msg = parsed as ServerMessage;
        // The first message after a resync is its verdict: an error means the
        // session we were rejoining no longer exists.
        if (resyncPendingRef.current) {
          resyncPendingRef.current = false;
          if (msg.type === 'error') {
            handlersRef.current.onResyncFailed?.(msg.message);
            return;
          }
        }
        handlersRef.current.onMessage(msg);
      }
    };

    ws.onclose = () => {
      if (wsRef.current !== ws) return; // stale socket — a newer one already replaced it
      wsRef.current = null;
      if (intentionalRef.current) return;
      scheduleReconnect();
    };
  }

  function scheduleReconnect(): void {
    clearTimer();
    if (!handlersRef.current.shouldReconnect()) return;
    if (budgetStartRef.current === null) {
      budgetStartRef.current = Date.now();
    } else if (Date.now() - budgetStartRef.current > RECONNECT_BUDGET_MS) {
      return; // gave up after ~3 minutes — the caller surfaces it (e.g. session_end banner)
    }
    const delay = RECONNECT_BACKOFF_MS[Math.min(attemptRef.current, RECONNECT_BACKOFF_MS.length - 1)];
    attemptRef.current += 1;
    timerRef.current = window.setTimeout(openSocket, delay);
  }

  function disconnect(): void {
    intentionalRef.current = true;
    clearTimer();
    attemptRef.current = 0;
    budgetStartRef.current = null;
    pendingRef.current = []; // intentional close — never flush stale intents later
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // already closed
      }
    }
  }

  function connect(): void {
    openSocket();
  }

  function send(intent: ClientMessage): void {
    const ws = wsRef.current;
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(intent));
    else if (ws.readyState === WebSocket.CONNECTING) pendingRef.current.push(intent);
    // CLOSED/CLOSING: dropped — either a reconnect will flush fresh intents or
    // the session is intentionally over.
  }

  // Cleanup on unmount: close without reconnecting.
  useEffect(
    () => () => {
      intentionalRef.current = true;
      clearTimer();
      pendingRef.current = [];
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch {
          // already closed
        }
      }
    },
    [],
  );

  return { connect, send, disconnect };
}
