import { DatabaseSync } from 'node:sqlite';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.resolve(__dirname, '../data');
const DB_FILE = path.join(DATA_DIR, 'deckbuilder.db');
const LEGACY_DATA_FILE = path.join(DATA_DIR, 'db.json');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface User {
  id: string;
  username: string;
  salt: string;
  passwordHash: string;
}

export interface DeckCard {
  name: string;
  scryfallOracleId: string;
  count: number;
  manaCost?: string;
  manaValue?: number;
  type?: string;
}

export interface Deck {
  id: string;
  userId: string;
  name: string;
  cards: DeckCard[];
  commander?: string;
  hearts: number;
  isCommunity: boolean;
  updatedAt: string;
}

interface LegacyDB {
  users?: User[];
  decks?: Deck[];
}

// ---------------------------------------------------------------------------
// Connection + schema
// ---------------------------------------------------------------------------

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    username      TEXT NOT NULL,
    salt          TEXT NOT NULL,
    password_hash TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);

  CREATE TABLE IF NOT EXISTS decks (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    name         TEXT NOT NULL,
    cards        TEXT NOT NULL,
    commander    TEXT,
    hearts       INTEGER NOT NULL DEFAULT 0,
    is_community INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_decks_user_id ON decks(user_id);
  CREATE INDEX IF NOT EXISTS idx_decks_hearts  ON decks(hearts);
`);

// ---------------------------------------------------------------------------
// Row <-> domain mapping
// ---------------------------------------------------------------------------

interface UserRow {
  id: string;
  username: string;
  salt: string;
  password_hash: string;
}

interface DeckRow {
  id: string;
  user_id: string;
  name: string;
  cards: string;
  commander: string | null;
  hearts: number;
  is_community: number;
  updated_at: string;
}

function rowToUser(row: UserRow): User {
  return { id: row.id, username: row.username, salt: row.salt, passwordHash: row.password_hash };
}

function rowToDeck(row: DeckRow): Deck {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    cards: JSON.parse(row.cards) as DeckCard[],
    commander: row.commander ?? undefined,
    hearts: row.hearts,
    isCommunity: row.is_community === 1,
    updatedAt: row.updated_at,
  };
}

// ---------------------------------------------------------------------------
// One-time migration from the legacy JSON file
// ---------------------------------------------------------------------------

function migrateFromLegacy(): void {
  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number };
  if (userCount.n > 0) return;
  if (!fs.existsSync(LEGACY_DATA_FILE)) return;

  const legacy = JSON.parse(fs.readFileSync(LEGACY_DATA_FILE, 'utf8')) as LegacyDB;
  const users = legacy.users ?? [];
  const decks = legacy.decks ?? [];
  if (users.length === 0 && decks.length === 0) return;

  const insertUser = db.prepare(
    'INSERT INTO users (id, username, salt, password_hash) VALUES (@id, @username, @salt, @password_hash)',
  );
  const insertDeck = db.prepare(
    'INSERT INTO decks (id, user_id, name, cards, commander, hearts, is_community, updated_at) ' +
      'VALUES (@id, @user_id, @name, @cards, @commander, @hearts, @is_community, @updated_at)',
  );

  db.exec('BEGIN');
  try {
    for (const u of users) {
      insertUser.run({ id: u.id, username: u.username, salt: u.salt, password_hash: u.passwordHash });
    }
    for (const d of decks) {
      insertDeck.run({
        id: d.id,
        user_id: d.userId,
        name: d.name,
        cards: JSON.stringify(d.cards ?? []),
        commander: d.commander ?? null,
        hearts: typeof d.hearts === 'number' ? d.hearts : 0,
        is_community: d.isCommunity === true ? 1 : 0,
        updated_at: d.updatedAt,
      });
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`Migrated ${users.length} users and ${decks.length} decks from ${LEGACY_DATA_FILE}.`);
}

migrateFromLegacy();

// ---------------------------------------------------------------------------
// User data access
// ---------------------------------------------------------------------------

export function getUserByUsername(username: string): User | undefined {
  const row = db
    .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
    .get(username) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

export function getUserById(id: string): User | undefined {
  const row = db.prepare('SELECT * FROM users WHERE id = ?').get(id) as UserRow | undefined;
  return row ? rowToUser(row) : undefined;
}

export function insertUser(user: User): void {
  db.prepare('INSERT INTO users (id, username, salt, password_hash) VALUES (?, ?, ?, ?)').run(
    user.id,
    user.username,
    user.salt,
    user.passwordHash,
  );
}

export function getAllUsers(): User[] {
  const rows = db.prepare('SELECT * FROM users').all() as unknown as UserRow[];
  return rows.map(rowToUser);
}

// ---------------------------------------------------------------------------
// Deck data access
// ---------------------------------------------------------------------------

export function getDeckById(id: string): Deck | undefined {
  const row = db.prepare('SELECT * FROM decks WHERE id = ?').get(id) as DeckRow | undefined;
  return row ? rowToDeck(row) : undefined;
}

export function getDecksByUser(userId: string): Deck[] {
  const rows = db.prepare('SELECT * FROM decks WHERE user_id = ?').all(userId) as unknown as DeckRow[];
  return rows.map(rowToDeck);
}

export function insertDeck(deck: Deck): void {
  db.prepare(
    'INSERT INTO decks (id, user_id, name, cards, commander, hearts, is_community, updated_at) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    deck.id,
    deck.userId,
    deck.name,
    JSON.stringify(deck.cards),
    deck.commander ?? null,
    deck.hearts,
    deck.isCommunity ? 1 : 0,
    deck.updatedAt,
  );
}

export function updateDeck(deck: Deck): void {
  db.prepare(
    'UPDATE decks SET name = ?, cards = ?, commander = ?, hearts = ?, is_community = ?, updated_at = ? WHERE id = ?',
  ).run(
    deck.name,
    JSON.stringify(deck.cards),
    deck.commander ?? null,
    deck.hearts,
    deck.isCommunity ? 1 : 0,
    deck.updatedAt,
    deck.id,
  );
}

export function deleteDeck(id: string): void {
  db.prepare('DELETE FROM decks WHERE id = ?').run(id);
}

export function getAllDecks(): Deck[] {
  const rows = db.prepare('SELECT * FROM decks').all() as unknown as DeckRow[];
  return rows.map(rowToDeck);
}

export function getTopDecks(limit: number, offset: number): Deck[] {
  const rows = db
    .prepare('SELECT * FROM decks ORDER BY hearts DESC, name ASC LIMIT ? OFFSET ?')
    .all(limit, offset) as unknown as DeckRow[];
  return rows.map(rowToDeck);
}

export function countDecks(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM decks').get() as { n: number };
  return row.n;
}
