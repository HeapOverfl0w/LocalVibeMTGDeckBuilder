// ---------------------------------------------------------------------------
// Lobby modal (Phase 5, Step 5.3) — follows the existing hand-modal pattern.
// Header: lobby code large + copy-to-clipboard; player rows with host crown
// and connected dots; host gets Start Match (disabled below 2 players) +
// Cancel Lobby, non-hosts get Leave. Closes itself when the phase leaves
// 'lobby' (match_start / session_end), which PlayView handles.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import { getUserId } from '../../api';
import { usePlaySession } from './PlaySessionContext';

export default function LobbyModal() {
  const { lobby, startMatch, cancelLobby, leaveLobby } = usePlaySession();
  const [copied, setCopied] = useState(false);

  if (!lobby) return null;

  const myId = getUserId();
  const isHost = myId !== null && myId === lobby.hostId;

  async function copyCode(): Promise<void> {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(lobby!.code);
      } else {
        // Fallback for non-secure contexts.
        const ta = document.createElement('textarea');
        ta.value = lobby!.code;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
      }
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard unavailable — the code is selectable text, so the user can copy it manually.
    }
  }

  return (
    <div className="hand-modal-backdrop">
      <div className="hand-modal lobby-modal">
        <h3 className="hand-title">Lobby</h3>
        <div className="lobby-code-row">
          <span className="lobby-code">{lobby.code}</span>
          <button className={`lobby-copy-btn${copied ? ' copied' : ''}`} onClick={copyCode}>
            {copied ? '✓ Copied' : 'Copy'}
          </button>
        </div>
        <p className="lobby-subtitle">Share this code to let others join</p>

        <ul className="lobby-players">
          {lobby.players.map((p) => (
            <li key={p.userId} className={p.connected ? '' : 'disconnected'}>
              <span className={`lobby-dot${p.connected ? ' on' : ''}`} />
              <span>
                {p.username}
                {p.userId === lobby.hostId ? ' 👑' : ''} — {p.deckName}
              </span>
            </li>
          ))}
        </ul>

        <div className="lobby-actions">
          {isHost ? (
            <>
              <button className="btn primary" disabled={lobby.players.length < 2} onClick={startMatch}>
                Start Match
              </button>
              <button className="btn danger" onClick={cancelLobby}>
                Cancel Lobby
              </button>
            </>
          ) : (
            <button className="btn" onClick={leaveLobby}>
              Leave
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
