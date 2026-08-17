import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';

const PORT = Number(process.env.PORT ?? 4000);
const JWT_SECRET = process.env.JWT_SECRET ?? 'mtg-deck-builder-dev-secret';
const DATA_DIR = path.resolve(__dirname, '../data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
const CARDS_FILE = path.resolve(__dirname, '../../AtomicCards.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface CardIdentifier {
  scryfallOracleId?: string;
}

interface CardData {
  identifiers: CardIdentifier;
}

interface AtomicCardsResponse {
  meta: {
    date: string;
    version: string;
  };
  data: Record<string, CardData[]>;
}

interface User {
  id: string;
  username: string;
  salt: string;
  passwordHash: string;
}

interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
}

interface Deck {
  id: string;
  userId: string;
  name: string;
  cards: DeckCard[];
  updatedAt: string;
}

interface DB {
  users: User[];
  decks: Deck[];
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
}

const cardNames = new Map<string, CardNameData>();

function loadCards(): void {
  console.log(`Loading cards from ${CARDS_FILE}...`);
  const raw = fs.readFileSync(CARDS_FILE, 'utf8');
  const parsed: AtomicCardsResponse = JSON.parse(raw);
  for (const [name, variations] of Object.entries(parsed.data)) {
    if (variations && variations.length > 0) {
      const scryfallOracleId = variations[0].identifiers?.scryfallOracleId || '';
      cardNames.set(name, { name, scryfallOracleId });
    }
  }
  console.log(`Loaded ${cardNames.size} unique card names.`);
}

function searchCards(query: string, limit: number): { name: string; scryfallOracleId: string }[] {
  const q = query.trim().toLowerCase();
  if (q.length < 3) return [];
  const words = q.split(/\s+/).filter(Boolean);

  const results: { name: string; scryfallOracleId: string; score: number }[] = [];

  for (const [name, card] of cardNames) {
    const lower = name.toLowerCase();
    if (lower === q) {
      results.push({ name, scryfallOracleId: card.scryfallOracleId, score: -10_000 });
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
    results.push({ name, scryfallOracleId: card.scryfallOracleId, score });
  }

  results.sort((a, b) => a.score - b.score || a.name.localeCompare(b.name));
  return results.slice(0, limit).map(({ name, scryfallOracleId }) => ({ name, scryfallOracleId }));
}

// ---------------------------------------------------------------------------
// Database (JSON file)
// ---------------------------------------------------------------------------

let db: DB = { users: [], decks: [] };

function loadDB(): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DATA_FILE)) {
    db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) as DB;
  }
}

function saveDB(): void {
  const tmp = `${DATA_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DATA_FILE);
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

function validateDeckPayload(body: unknown): { name: string; cards: DeckCard[] } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const { name, cards } = body as { name?: unknown; cards?: unknown };
  if (typeof name !== 'string' || name.trim().length === 0 || name.trim().length > 100) return null;
  if (!Array.isArray(cards)) return null;

  const out: DeckCard[] = [];
  for (const entry of cards) {
    if (!entry || typeof entry !== 'object') return null;
    const { name: cardName, scryfallOracleId, count } = entry as {
      name?: unknown;
      scryfallOracleId?: unknown;
      count?: unknown;
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
    out.push({ name: cardName, scryfallOracleId, count });
  }
  return { name: name.trim(), cards: out };
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
  if (db.users.some((u) => u.username.toLowerCase() === name.toLowerCase())) {
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
  db.users.push(user);
  saveDB();
  const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { username: user.username } });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
  if (typeof username !== 'string' || typeof password !== 'string') {
    res.status(400).json({ error: 'Username and password are required' });
    return;
  }
  const user = db.users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase());
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
  const decks = db.decks
    .filter((d) => d.userId === req.user!.id)
    .map(({ userId, ...rest }) => rest);
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
    updatedAt: new Date().toISOString(),
  };
  db.decks.push(deck);
  saveDB();
  res.status(201).json(deck);
});

app.put('/api/decks/:id', requireAuth, (req: Request, res: Response) => {
  const deck = db.decks.find((d) => d.id === req.params.id && d.userId === req.user!.id);
  if (!deck) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  const payload = validateDeckPayload(req.body);
  if (!payload) {
    res.status(400).json({ error: 'Invalid deck payload' });
    return;
  }
  deck.name = payload.name;
  deck.cards = payload.cards;
  deck.updatedAt = new Date().toISOString();
  saveDB();
  res.json(deck);
});

app.delete('/api/decks/:id', requireAuth, (req: Request, res: Response) => {
  const idx = db.decks.findIndex((d) => d.id === req.params.id && d.userId === req.user!.id);
  if (idx === -1) {
    res.status(404).json({ error: 'Deck not found' });
    return;
  }
  db.decks.splice(idx, 1);
  saveDB();
  res.status(204).send();
});

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------

loadDB();
loadCards();

app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});