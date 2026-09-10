# Server Optimization Plan

This plan addresses performance issues in the server (`server/src/db.ts` and `server/src/index.ts`), primarily the pattern of loading **all decks** (and all users) into memory and filtering in JavaScript instead of using targeted SQL queries.

## Findings

| # | Location | Problem |
|---|----------|---------|
| 1 | `GET /api/community/search` | `db.getAllDecks()` + `db.getAllUsers()`, then filters in JS (`commander.includes(needle)` / username match). Loads **every deck's full `cards` JSON blob** and `JSON.parse`s it, even though the response only needs `id, name, commander, hearts, username`. |
| 2 | `GET /api/community/search-by-colors` | Same "load all decks + all users" pattern, then filters in JS by commander mana colors. Worst offender — full table + full user table per request. |
| 3 | `GET /api/community/top` | Already uses SQL `LIMIT/OFFSET` (good), but **N+1**: calls `db.getUserById(d.userId)` once per deck in the page. |
| 4 | `POST /api/decks/:id/heart` | Read-modify-write of the **entire row** (rewrites the `cards` blob) via `updateDeck`. Also a lost-update race under concurrent hearts. |
| 5 | `db.getAllDecks()` / `getAllUsers()` | Exist only to feed #1/#2; return full rows. |
| 6 | `searchCards` (minor) | O(n) over all card names on every `/api/cards/search` request. |
| 7 | (clarity) `is_community` | Naming is inverted: `1` = private copy (hidden from community), `0` = public. All community queries correctly use `= 0`, so behavior is fine — just don't "fix" the name without a data migration. |

The core issue: the `cards` column is a JSON blob, and the search endpoints pull it when they don't need it. The fix is **narrow SQL queries** (select only `id, name, commander, hearts, user_id`) plus **joins** instead of in-memory filtering.

## Plan

### Phase 1 — Quick wins (no schema change)

Add narrow query functions to `db.ts` (never select `cards`):

- `searchCommunityByCommander(needle)` → `SELECT d.id, d.name, d.commander, d.hearts, d.user_id FROM decks d WHERE d.is_community = 0 AND d.commander LIKE ?` (escape `%`/`_` in the needle; SQLite `LIKE` is ASCII case-insensitive, matching the current `.toLowerCase().includes()` behavior).
- `searchCommunityByUsername(needle)` → `... FROM decks d JOIN users u ON d.user_id = u.id WHERE d.is_community = 0 AND u.username LIKE ?`.
- `getTopCommunity(limit, offset)` → `... FROM decks d LEFT JOIN users u ON d.user_id = u.id WHERE d.is_community = 0 ORDER BY d.hearts DESC, d.name ASC LIMIT ? OFFSET ?` — **kills the N+1** in `/api/community/top`.
- `getCommunityDeckWithUser(id)` → single join for the detail endpoint.
- `incrementHearts(id)` → `UPDATE decks SET hearts = hearts + 1 WHERE id = ?` (atomic; check `.changes` for 404).

Rewrite the three endpoints to call these. For `search-by-colors`, keep the in-memory color filter **but over the narrow rows** (no blob, no `JSON.parse`) — a big win with zero schema change.

Add index: `CREATE INDEX IF NOT EXISTS idx_decks_community_top ON decks(is_community, hearts, name);`

### Phase 2 — Proper fix for color search (schema change)

Color search can't be done in SQL today because mana colors live in the in-memory `cardNames` map, not the DB. Denormalize:

- Add `commander_colors INTEGER NOT NULL DEFAULT 0` (bitmask: W=1, U=2, B=4, R=8, G=16).
- Populate it on insert/update/copy (the server already computes colors via `extractColorsFromManaCost`).
- One-time backfill of existing rows (trivial at current scale).
- Query becomes: `WHERE is_community = 0 AND (commander_colors & @mask) = @mask ORDER BY hearts DESC, d.name ASC LIMIT 40` — pure SQL, no in-memory filter.
- Index: `CREATE INDEX IF NOT EXISTS idx_decks_community_colors ON decks(is_community, commander_colors);`

### Phase 3 — Optional

- Optimize `searchCards` (precompute a lowercased name index / prefix structure) if card-search latency matters.
- `commander` index if you ever add prefix/autocomplete search.

## Risks / notes

- `LIKE` case-insensitivity is ASCII-only — fine for card names, matches current behavior.
- SQL `ORDER BY name` uses byte order vs JS `localeCompare` — negligible for deck names; keep the JS sort if you need exact parity.
- Phase 2 backfill must complete before the color query goes live.
- Keep `is_community = 0` semantics as-is; don't rename without migrating data.

## Recommendation

Phase 1 removes the "load all decks" problem and the N+1 with no schema migration. Phase 2 makes color search fully SQL-driven.
