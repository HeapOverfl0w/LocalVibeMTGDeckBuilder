import type { CardResult, Deck, DeckCard, User } from './types';

const API_BASE = '/api';

let token: string | null = localStorage.getItem('mtg_token');

export function getToken(): string | null {
  return token;
}

export function setToken(t: string | null): void {
  token = t;
  if (t) localStorage.setItem('mtg_token', t);
  else localStorage.removeItem('mtg_token');
}

export function clearToken(): void {
  setToken(null);
}

async function request<T>(path: string, options: { method?: string; body?: unknown; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.auth && token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API_BASE}${path}`, {
    method: options.method ?? 'GET',
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
  if (res.status === 401) {
    clearToken();
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  register(username: string, password: string) {
    return request<{ token: string; user: User }>('/auth/register', { method: 'POST', body: { username, password } });
  },
  login(username: string, password: string) {
    return request<{ token: string; user: User }>('/auth/login', { method: 'POST', body: { username, password } });
  },
  me() {
    return request<User>('/auth/me', { auth: true });
  },
  searchCards(q: string) {
    return request<CardResult[]>(`/cards/search?q=${encodeURIComponent(q)}`);
  },
  getDecks() {
    return request<Deck[]>('/decks', { auth: true });
  },
  saveDeck(deck: { id?: string; name: string; cards: DeckCard[]; commander?: string }) {
    return deck.id
      ? request<Deck>(`/decks/${deck.id}`, { method: 'PUT', auth: true, body: deck })
      : request<Deck>('/decks', { method: 'POST', auth: true, body: deck });
  },
  deleteDeck(id: string) {
    return request<void>(`/decks/${id}`, { method: 'DELETE', auth: true });
  },
};