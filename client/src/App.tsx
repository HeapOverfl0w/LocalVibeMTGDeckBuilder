import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, clearToken, getToken } from './api';
import AuthForm from './components/AuthForm';
import Community from './components/Community';
import DeckEditor from './components/DeckEditor';
import { PlaySessionProvider } from './components/play/PlaySessionContext';
import PlayView from './components/play/PlayView';

export default function App() {
  const [username, setUsername] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(getToken()));

  useEffect(() => {
    if (!getToken()) {
      setLoading(false);
      return;
    }
    api.me()
      .then((u) => setUsername(u.username))
      .catch(() => clearToken())
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return <div className="loading-screen">Loading…</div>;
  }

  const logout = () => {
    clearToken();
    setUsername(null); // unmounts PlaySessionProvider → socket closes → ghosted on the server
  };

  if (!username) {
    return (
      <Routes>
        <Route path="/login" element={<AuthForm onAuthed={setUsername} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    // Session state + socket live ABOVE <Routes>, so a running lobby/match
    // survives route changes (Phase 4, Step 4.4).
    <PlaySessionProvider username={username}>
      <Routes>
        <Route path="/login" element={<Navigate to="/decks" replace />} />
        <Route path="/decks" element={<DeckEditor username={username} onLogout={logout} />} />
        <Route path="/community" element={<Community username={username} onLogout={logout} />} />
        <Route path="/play" element={<PlayView username={username} onLogout={logout} />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    </PlaySessionProvider>
  );
}