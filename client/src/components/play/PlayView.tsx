// ---------------------------------------------------------------------------
// Play view (Phase 4, Step 4.4) — a PURE view: reads the session context and
// renders Navbar + one of {PlayLanding, LobbyModal over landing, GameTable}
// based on phase. It owns nothing session-related.
// ---------------------------------------------------------------------------

import Navbar from '../Navbar';
import { usePlaySession } from './PlaySessionContext';
import PlayLanding from './PlayLanding';
import LobbyModal from './LobbyModal';
import GameTable from './GameTable';

interface PlayViewProps {
  username: string;
  onLogout: () => void;
}

export default function PlayView({ username, onLogout }: PlayViewProps) {
  const { phase } = usePlaySession();

  return (
    <div className="play-view">
      <Navbar username={username} onLogout={onLogout} />
      {phase === 'game' ? (
        <GameTable />
      ) : (
        <>
          <PlayLanding />
          {phase === 'lobby' && <LobbyModal />}
        </>
      )}
    </div>
  );
}
