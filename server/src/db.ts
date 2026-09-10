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
  description?: string;
  hearts: number;
  isCommunity: boolean;
  updatedAt: string;
  /** Bitmask of the commander's mana colors: W=1, U=2, B=4, R=8, G=16. */
  commanderColors: number;
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
    description  TEXT,
    hearts       INTEGER NOT NULL DEFAULT 0,
    is_community INTEGER NOT NULL DEFAULT 0,
    updated_at   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS deck_hearts (
    deck_id TEXT NOT NULL REFERENCES decks(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    PRIMARY KEY (deck_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY
  );

  CREATE INDEX IF NOT EXISTS idx_decks_user_id ON decks(user_id);
  CREATE INDEX IF NOT EXISTS idx_decks_hearts  ON decks(hearts);
  CREATE INDEX IF NOT EXISTS idx_decks_community_top ON decks(is_community, hearts, name);
`);

// Existing databases created before Phase 2 lack the column; add it idempotently.
// Must run before the commander_colors index below, which depends on the column.
function ensureCommanderColorsColumn(): void {
  const cols = db.prepare('PRAGMA table_info(decks)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'commander_colors')) {
    db.exec('ALTER TABLE decks ADD COLUMN commander_colors INTEGER NOT NULL DEFAULT 0');
  }
}
ensureCommanderColorsColumn();

// Existing databases created before the description feature lack the column; add it idempotently.
function ensureDescriptionColumn(): void {
  const cols = db.prepare('PRAGMA table_info(decks)').all() as { name: string }[];
  if (!cols.some((c) => c.name === 'description')) {
    db.exec('ALTER TABLE decks ADD COLUMN description TEXT');
  }
}
ensureDescriptionColumn();

db.exec('CREATE INDEX IF NOT EXISTS idx_decks_community_colors ON decks(is_community, commander_colors);');

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
  description: string | null;
  hearts: number;
  is_community: number;
  updated_at: string;
  commander_colors: number;
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
    description: row.description ?? undefined,
    hearts: row.hearts,
    isCommunity: row.is_community === 1,
    updatedAt: row.updated_at,
    commanderColors: row.commander_colors,
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
    'INSERT INTO decks (id, user_id, name, cards, commander, description, hearts, is_community, updated_at, commander_colors) ' +
      'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    deck.id,
    deck.userId,
    deck.name,
    JSON.stringify(deck.cards),
    deck.commander ?? null,
    deck.description ?? null,
    deck.hearts,
    deck.isCommunity ? 1 : 0,
    deck.updatedAt,
    deck.commanderColors,
  );
}

export function updateDeck(deck: Deck): void {
  db.prepare(
    'UPDATE decks SET name = ?, cards = ?, commander = ?, description = ?, hearts = ?, is_community = ?, updated_at = ?, commander_colors = ? WHERE id = ?',
  ).run(
    deck.name,
    JSON.stringify(deck.cards),
    deck.commander ?? null,
    deck.description ?? null,
    deck.hearts,
    deck.isCommunity ? 1 : 0,
    deck.updatedAt,
    deck.commanderColors,
    deck.id,
  );
}

export function deleteDeck(id: string): void {
  db.prepare('DELETE FROM decks WHERE id = ?').run(id);
}

// ---------------------------------------------------------------------------
// Community (narrow) queries — never select the `cards` blob
// ---------------------------------------------------------------------------

export interface CommunityDeckRow {
  id: string;
  name: string;
  commander: string | null;
  hearts: number;
  user_id: string;
  username: string | null;
}

const COMMUNITY_DECK_SELECT =
  'SELECT d.id, d.name, d.commander, d.hearts, d.user_id, u.username '
  + 'FROM decks d LEFT JOIN users u ON d.user_id = u.id';

function escapeLike(needle: string): string {
  return needle.replace(/[%_]/g, '\\$&');
}

export function searchCommunityByCommander(needle: string): CommunityDeckRow[] {
  const rows = db
    .prepare(`${COMMUNITY_DECK_SELECT} WHERE d.is_community = 0 AND d.commander LIKE ? ESCAPE '\\'`)
    .all(`%${escapeLike(needle)}%`) as unknown as CommunityDeckRow[];
  return rows;
}

export function searchCommunityByUsername(needle: string): CommunityDeckRow[] {
  const rows = db
    .prepare(`${COMMUNITY_DECK_SELECT} WHERE d.is_community = 0 AND u.username LIKE ? ESCAPE '\\'`)
    .all(`%${escapeLike(needle)}%`) as unknown as CommunityDeckRow[];
  return rows;
}

export function getTopCommunity(limit: number, offset: number): CommunityDeckRow[] {
  const rows = db
    .prepare(
      `${COMMUNITY_DECK_SELECT} WHERE d.is_community = 0 ORDER BY d.hearts DESC, d.name ASC LIMIT ? OFFSET ?`,
    )
    .all(limit, offset) as unknown as CommunityDeckRow[];
  return rows;
}

/**
 * Pure-SQL color search. `mask` is the required commander-color bitmask
 * (W=1, U=2, B=4, R=8, G=16); a deck matches when it contains every requested
 * color, i.e. `(commander_colors & mask) = mask`.
 *
 * When `colorless` is true, only Colorless commanders (commander_colors === 0)
 * should match, so the color filter is replaced with an equality check.
 */
export function searchCommunityByColors(mask: number, limit: number, colorless: boolean): CommunityDeckRow[] {
  if (colorless) {
    const rows = db
      .prepare(
        `${COMMUNITY_DECK_SELECT} WHERE d.is_community = 0 AND d.commander_colors = 0 ` +
          'ORDER BY d.hearts DESC, d.name ASC LIMIT ?',
      )
      .all(limit) as unknown as CommunityDeckRow[];
    return rows;
  }
  const rows = db
    .prepare(
      `${COMMUNITY_DECK_SELECT} WHERE d.is_community = 0 AND (d.commander_colors & ?) = ? ` +
        'ORDER BY d.hearts DESC, d.name ASC LIMIT ?',
    )
    .all(mask, mask, limit) as unknown as CommunityDeckRow[];
  return rows;
}

export function getCommunityDeckWithUser(id: string): (CommunityDeckRow & { cards: DeckCard[]; description: string | null }) | undefined {
  const row = db
    .prepare(
      'SELECT d.id, d.name, d.commander, d.hearts, d.user_id, u.username, d.cards, d.description '
      + 'FROM decks d LEFT JOIN users u ON d.user_id = u.id WHERE d.id = ?',
    )
    .get(id) as (CommunityDeckRow & { cards: string; description: string | null }) | undefined;
  if (!row) return undefined;
  return { ...row, cards: JSON.parse(row.cards) as DeckCard[] };
}

/**
 * Toggle a user's heart on a deck. Returns the new heart count, or undefined
 * if the deck does not exist.
 */
export function toggleHeart(deckId: string, userId: string): number | undefined {
  const existing = db
    .prepare('SELECT 1 AS x FROM deck_hearts WHERE deck_id = ? AND user_id = ?')
    .get(deckId, userId);
  if (existing) {
    // Remove the heart
    db.prepare('DELETE FROM deck_hearts WHERE deck_id = ? AND user_id = ?').run(deckId, userId);
    db.prepare('UPDATE decks SET hearts = MAX(hearts - 1, 0) WHERE id = ?').run(deckId);
  } else {
    // Add the heart
    db.prepare('INSERT INTO deck_hearts (deck_id, user_id, created_at) VALUES (?, ?, ?)').run(
      deckId,
      userId,
      new Date().toISOString(),
    );
    db.prepare('UPDATE decks SET hearts = hearts + 1 WHERE id = ?').run(deckId);
  }
  const row = db.prepare('SELECT hearts FROM decks WHERE id = ?').get(deckId) as { hearts: number };
  return row.hearts;
}

/**
 * Check whether a user has hearted a deck.
 */
export function hasHearted(deckId: string, userId: string): boolean {
  const row = db
    .prepare('SELECT 1 AS x FROM deck_hearts WHERE deck_id = ? AND user_id = ?')
    .get(deckId, userId);
  return row !== undefined;
}

export function countDecks(): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM decks WHERE is_community = 0').get() as { n: number };
  return row.n;
}

// ---------------------------------------------------------------------------
// One-time backfill of `commander_colors` (Phase 2)
// ---------------------------------------------------------------------------

/**
 * Populate `commander_colors` for rows created before Phase 2. Runs at most
 * once, guarded by a `schema_migrations` row. `colorFor` maps a commander name
 * to its color bitmask (supplied by the caller, which owns the card data).
 */
export function backfillCommanderColors(colorFor: (commander: string) => number): void {
  const done = db.prepare('SELECT 1 AS done FROM schema_migrations WHERE name = ?').get('commander_colors_backfill');
  if (done) return;

  const rows = db.prepare('SELECT id, commander FROM decks').all() as { id: string; commander: string | null }[];
  const update = db.prepare('UPDATE decks SET commander_colors = ? WHERE id = ?');
  db.exec('BEGIN');
  try {
    for (const row of rows) {
      update.run(row.commander ? colorFor(row.commander) : 0, row.id);
    }
    db.prepare('INSERT INTO schema_migrations (name) VALUES (?)').run('commander_colors_backfill');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  console.log(`Backfilled commander_colors for ${rows.length} decks.`);
}
