import { useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { api, clearToken, getToken } from './api';
import AuthForm from './components/AuthForm';
import DeckEditor from './components/DeckEditor';
import Navbar from './components/Navbar';

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

  return (
    <Routes>
      <Route
        path="/login"
        element={
          username ? (
            <Navigate to="/decks" replace />
          ) : (
            <AuthForm onAuthed={setUsername} />
          )
        }
      />
      <Route
        path="/decks"
        element={
          username ? (
            <DeckEditor
              username={username}
              onLogout={() => {
                clearToken();
                setUsername(null);
              }}
            />
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route
        path="/community"
        element={
          username ? (
            <div className="app">
              <Navbar
                username={username}
                onLogout={() => {
                  clearToken();
                  setUsername(null);
                }}
              />
            </div>
          ) : (
            <Navigate to="/login" replace />
          )
        }
      />
      <Route path="*" element={<Navigate to="/login" replace />} />
    </Routes>
  );
}