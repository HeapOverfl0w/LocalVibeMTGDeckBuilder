import { useEffect, useState } from 'react';
import { api, clearToken, getToken } from './api';
import AuthForm from './components/AuthForm';
import DeckEditor from './components/DeckEditor';

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

  if (!username) {
    return <AuthForm onAuthed={setUsername} />;
  }

  return (
    <DeckEditor
      username={username}
      onLogout={() => {
        clearToken();
        setUsername(null);
      }}
    />
  );
}