import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import * as db from './db';
import type { User, DeckCard, Deck } from './db';

const PORT = Number(process.env.PORT ?? 4000);
const JWT_SECRET = process.env.JWT_SECRET ?? 'mtg-deck-builder-dev-secret';
const CARDS_FILE = path.resolve(__dirname, '../../AtomicCards.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CardIdentifier {
  scryfallOracleId?: string;
}

interface CardData {
  identifiers: CardIdentifier;
  manaCost?: string;
  manaValue?: number;
  type?: string;
}

interface AtomicCardsResponse {
  meta: {
    date: string;
    version: string;
  };
  data: Record<string, CardData[]>;
}

declare global {
  namespace Express {
    interface Request {
      user?: { id: string; username: string };
    }
  }
}

// ---------------------------------------------------------------------------
// Card data (loaded from AtomicCards.json into memory)
// ---------------------------------------------------------------------------

interface CardNameData {
  name: string;
  scryfallOracleId: string;
  type?: string;
  manaCost?: string;
  manaValue?: number;
}

const cardNames = new Map<string, CardNameData>();

function loadCards(): void {
  console.log(`Loading cards from ${CARDS_FILE}...`);
  const raw = fs.readFileSync(CARDS_FILE, 'utf8');
  const parsed: AtomicCardsResponse = JSON.parse(raw);
  for (const [name, variations] of Object.entries(parsed.data)) {
    if (variations && variations.length > 0) {
      const first = variations[0];
      const scryfallOracleId = first.identifiers?.scryfallOracleId || '';
      cardNames.set(name, { name, scryfallOracleId, manaCost: first.manaCost, manaValue: first.manaValue, type: first.type });
    }
  }
  console.log(`Loaded ${cardNames.size} unique card names.`);
}

function searchCards(query: string, limit: number): { name: string; scryfallOracleId: string; manaCost?: string; manaValue?: number; type?: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const words = q.split(/\s+/).filter(Boolean);

  const results: { name: string; scryfallOracleId: string; manaCost?: string; manaValue?: number; type?: string; score: number }[] = [];

  for (const [name, card] of cardNames) {
    const lower = name.toLowerCase();
    if (lower === q) {
      results.push({ name, scryfallOracleId: card.scryfallOracleId, manaCost: card.manaCost, manaValue: card.manaValue, type: card.type, score: -10_000 });
      continue;
    }
    let score = 0;
    let matched = true;
    for (const word of words) {
      const idx = lower.indexOf(word);
      if (idx === -1) {
        matched = false;
        break;
      }
      score += idx;
    }
    if (!matched) continue;
    if (lower.startsWith(q)) score -= 5_000;
    results.push({ name, scryfallOracleId: card.scryfallOracleId, manaCost: card.manaCost, manaValue: card.manaValue, type: card.type, score });
  }

  results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return results.slice(0, limit).map(({ name, scryfallOracleId, manaCost, manaValue, type }) => ({ name, scryfallOracleId, manaCost, manaValue, type }));
}

function enrichDeckCards(cards: DeckCard[]): DeckCard[] {
  return cards.map((c) => {
    const known = cardNames.get(c.name);
    return known
      ? {
          ...c,
          ...(known.manaCost ? { manaCost: known.manaCost } : {}),
          ...(known.manaValue !== undefined ? { manaValue: known.manaValue } : {}),
          ...(known.type ? { type: known.type } : {}),
        }
      : c;
  });
}

function extractColorsFromManaCost(cost: string | undefined): Set<string> {
  const colors = new Set<string>();
  if (!cost) return colors;
  const regex = /\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(cost)) !== null) {
    for (const ch of match[1]) {
      if (ch === 'W' || ch === 'U' || ch === 'B' || ch === 'R' || ch === 'G') {
        colors.add(ch);
      }
    }
  }
  return colors;
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, hash: string): boolean {
  const candidate = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    const payload = jwt.verify(header.slice(7), JWT_SECRET) as { userId: string; username: string };
    req.user = { id: payload.userId, username: payload.username };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ---------------------------------------------------------------------------
// Deck payload validation
// ---------------------------------------------------------------------------

function validateDeckPayload(body: unknown): { name: string; cards: DeckCard[]; commander?: string } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { name, cards, commander } = body as { name?: unknown; cards?: unknown; commander?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) return null;
  if (commander !== undefined && typeof commander !== 'string') return null;
  if (!Array.isArray(cards)) return null;

  const out: DeckCard[] = [];
  for (const entry of cards) {
    if (!entry || typeof entry !== 'object') return null;
    const { name: cardName, scryfallOracleId, count, manaCost, manaValue, type } = entry as {
      name?: unknown;
      scryfallOracleId?: unknown;
      count?: unknown;
      manaCost?: unknown;
      manaValue?: unknown;
      type?: unknown;
    };
    if (
      typeof cardName !== 'string' ||
      typeof scryfallOracleId !== 'string' ||
      typeof count !== 'number' ||
      !Number.isInteger(count) ||
      count < 1 ||
      count > 100
    ) {
      return null;
    }
    out.push({
      name: cardName,
      scryfallOracleId,
      count,
      ...(typeof type === 'string' ? { type } : {}),
      ...(typeof manaCost === 'string' ? { manaCost } : {}),
      ...(typeof manaValue === 'number' ? { manaValue } : {}),
    });
  }
  return { name: name.trim(), cards: out, ...(typeof commander === 'string' ? { commander } : {}) };
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: '2mb' }));

app.post('/api/auth/register', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  const name = username.trim();
  if (name.length < 3 || name.length > 32) {
    res.status(400).json({ error: 'Username must be 3-32 characters' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'Password must be at least 6 characters' });
    return;
  }
  if (db.getUserByUsername(name)) {
    res.status(409).json({ error: 'Username already taken' });
    return;
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const user: User = {
    id: crypto.randomUUID(),
    username: name,
    salt,
    passwordHash: hashPassword(password, salt),
  };
  db.insertUser(user);
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username } });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  const user = db.getUserByUsername(username.trim());
  if (!user || !verifyPassword(password, user.salt, user.passwordHash)) {
    res.status(401).json({ error: 'Invalid username or password' });
    return;
  }
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username } });
});

app.get('/api/auth/me', requireAuth, (req: Request, res: Response) => {
  res.json({ username: req.user!.username });
});

app.get('/api/cards/search', (req: Request, res: Response) => {
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (q.trim().length < 3) {
    res.json([]);
    return;
  }
  res.json(searchCards(q, 50));
});

app.get('/api/decks', requireAuth, (req: Request, res: Response) => {
  const decks = db.getDecksByUser(req.user!.id).map((d) => ({
    id: d.id,
    name: d.name,
    cards: enrichDeckCards(d.cards),
    commander: d.commander,
    hearts: d.hearts,
    isCommunity: d.isCommunity,
    updatedAt: d.updatedAt,
  }));
  res.json(decks);
});

app.post('/api/decks', requireAuth, (req: Request, res: Response) => {
  const payload = validateDeckPayload(req.body);
  if (!payload) {
    res.status(400).json({ error: 'Invalid deck payload' });
    return;
  }
  const deck: Deck = {
    id: crypto.randomUUID(),
    userId: req.user!.id,
    name: payload.name,
    cards: payload.cards,
    commander: payload.commander,
    hearts: 0,
    isCommunity: false,
    updatedAt: new Date().toISOString(),
  };
  db.insertDeck(deck);
  res.status(201).json(deck);
});

app.put('/api/decks/:id', requireAuth, (req: Request, res: Response) => {
  const existing = db.getDeckById(req.params.id);
  if (!existing || existing.userId !== req.user!.id) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  const payload = validateDeckPayload(req.body);
  if (!payload) {
    res.status(400).json({ error: 'Invalid deck payload' });
    return;
  }
  const deck: Deck = {
    ...existing,
    name: payload.name,
    commander: payload.commander,
    cards: payload.cards,
    isCommunity: false,
    updatedAt: new Date().toISOString(),
  };
  db.updateDeck(deck);
  res.json(deck);
});

app.delete('/api/decks/:id', requireAuth, (req: Request, res: Response) => {
  const existing = db.getDeckById(req.params.id);
  if (!existing || existing.userId !== req.user!.id) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  db.deleteDeck(existing.id);
  res.status(204).send();
});

app.post('/api/decks/:id/heart', requireAuth, (req: Request, res: Response) => {
  const deck = db.getDeckById(req.params.id);
  if (!deck) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  const copy: Deck = {
    id: crypto.randomUUID(),
    userId: req.user!.id,
    name: deck.name,
    cards: deck.cards.map((c) => ({ ...c })),
    commander: deck.commander,
    hearts: 0,
    isCommunity: true,
    updatedAt: new Date().toISOString(),
  };
  db.insertDeck(copy);
  res.status(201).json(copy);
});

// ---------------------------------------------------------------------------
// Community search
// ---------------------------------------------------------------------------

type CommunitySearchType = 'commander' | 'username';

app.get('/api/community/search', requireAuth, (req: Request, res: Response) => {
  const type = req.query.type;
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';

  if (type !== 'commander' && type !== 'username') {
    res.status(400).json({ error: 'type must be "commander" or "username"' });
    return;
  }
  if (q.length === 0) {
    res.json([]);
    return;
  }

  const needle = q.toLowerCase();
  const allDecks = db.getAllDecks();
  const allUsers = db.getAllUsers();
  const usersById = new Map(allUsers.map((u) => [u.id, u.username]));

  let decks: Deck[];
  if (type === 'commander') {
    decks = allDecks.filter((d) => d.commander && d.commander.toLowerCase().includes(needle));
  } else {
    const matchingUserIds = new Set(
      allUsers.filter((u) => u.username.toLowerCase().includes(needle)).map((u) => u.id),
    );
    decks = allDecks.filter((d) => matchingUserIds.has(d.userId));
  }

  const results = decks
    .map((d) => ({
      id: d.id,
      name: d.name,
      username: usersById.get(d.userId) ?? 'Unknown',
      commander: d.commander,
      commanderOracleId: d.commander ? cardNames.get(d.commander)?.scryfallOracleId : undefined,
      hearts: d.hearts,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
  res.json(results);
});

app.get('/api/community/top', requireAuth, (req: Request, res: Response) => {
  const rawPage = typeof req.query.page === 'string' ? parseInt(req.query.page, 10) : NaN;
  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawLimit = typeof req.query.limit === 'string' ? parseInt(req.query.limit, 10) : NaN;
  const limit = Number.isInteger(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 40) : 40;

  const total = db.countDecks();
  const offset = (page - 1) * limit;
  const decks = db.getTopDecks(limit, offset).map((d) => ({
    id: d.id,
    name: d.name,
    username: db.getUserById(d.userId)?.username ?? 'Unknown',
    commander: d.commander,
    commanderOracleId: d.commander ? cardNames.get(d.commander)?.scryfallOracleId : undefined,
    hearts: d.hearts,
  }));

  res.json({
    decks,
    total,
    page,
    limit,
  });
});

app.get('/api/community/search-by-colors', requireAuth, (req: Request, res: Response) => {
  const rawColors = typeof req.query.colors === 'string' ? req.query.colors : '';
  const colors = [
    ...new Set(
      rawColors
        .split(',')
        .map((c) => c.trim().toUpperCase())
        .filter((c) => c === 'W' || c === 'U' || c === 'B' || c === 'R' || c === 'G'),
    ),
  ];
  if (colors.length === 0) {
    res.json([]);
    return;
  }
  const usersById = new Map(db.getAllUsers().map((u) => [u.id, u.username]));
  const decks = db.getAllDecks()
    .filter((d) => {
      if (!d.commander) return false;
      const commander = cardNames.get(d.commander);
      if (!commander || !commander.manaCost) return false;
      const costColors = extractColorsFromManaCost(commander.manaCost);
      return colors.every((c) => costColors.has(c));
    })
    .sort((a, b) => b.hearts - a.hearts || a.name.localeCompare(b.name))
    .slice(0, 40)
    .map((d) => ({
      id: d.id,
      name: d.name,
      username: usersById.get(d.userId) ?? 'Unknown',
      commander: d.commander,
      commanderOracleId: d.commander ? cardNames.get(d.commander)?.scryfallOracleId : undefined,
      hearts: d.hearts,
    }));
  res.json(decks);
});

app.get('/api/community/decks/:id', requireAuth, (req: Request, res: Response) => {
  const deck = db.getDeckById(req.params.id);
  if (!deck) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  res.json({
    name: deck.name,
    username: db.getUserById(deck.userId)?.username ?? 'Unknown',
    commander: deck.commander,
    hearts: deck.hearts,
    cards: enrichDeckCards(deck.cards),
  });
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

loadCards();

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});