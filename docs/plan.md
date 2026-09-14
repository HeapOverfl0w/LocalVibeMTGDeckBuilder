# Play Tab — Mock Matches & Websocket Lobbies

A new **Play** tab (alongside Community and My Decks) where users can test a deck solo ("Mock" play) or host/join a lobby over a websocket and play a basic, freeform match together.

## 1. Confirmed decisions

| Topic | Decision |
|-------|----------|
| Lobby discovery | **Lobby code entry.** Host gets a short code (6 chars); others type it into a field to join. No lobby list UI. |
| Max players | **Up to 4** per lobby/match (free-for-all; one opponent zone per player). |
| Opening hand | **Empty hand.** Players draw manually by clicking their deck. |
| Turn structure | **No turns.** Pure sandbox — anyone can move cards anytime. No mana, combat, or rule enforcement. |
| Commander | **Placed on the table** automatically at match start (one copy removed from the shuffle pool). |
| Disconnects | **Ghost the leaver.** Their cards stay in place, marked disconnected; others keep playing. Reconnecting by re-entering the code restores the seat. |
| Idle timeout | **10 minutes of no activity closes the lobby — including active matches.** Any client action resets the timer. |

## 2. Assumptions & open items

Assumptions (flag if wrong):

- Play requires login, like every other tab; you play one of your **saved decks** (chosen from the same list as My Decks). Decks with 0 cards are rejected at lobby join time.
- The deck is **snapshotted at join time** — editing a deck in another tab does not affect an in-progress lobby/match.
- A running session (waiting lobby or active match) **survives route changes**: its state and socket live in an app-level provider above `<Routes>`, so switching tabs, hitting back, or typing a URL cannot unmount it. Other tabs stay usable during a session; a floating "return to match" pill appears while away from Play. (If hard-disabling Community/My Decks during a session is preferred instead, that's a one-line change — see Step 4.4.)
- A user is never blocked by an old lobby: **creating or joining a lobby implicitly leaves any current one** (waiting lobby → seat removed with host promotion; active match → ghosted, cards stay put). Re-entering your own live lobby's code resyncs that tab instead of erroring.
- Host needs **≥ 2 players** to start a match; ghosted (disconnected) players may still be in the lobby when it starts.
- If the host leaves a *waiting* lobby, host role passes to the earliest-joined remaining player. If nobody remains, the lobby closes.
- "Top of deck" = index 0 of the deck array. Drawing removes index 0; moving a card to your deck inserts at index 0.
- Desktop-first: HTML5 drag & drop only (no touch support in v1).

Open items (not blocking):

- No hard cap on total cards per deck for play (a few hundred is fine at this scale).
- Reconnect grace: ghosted seats persist until the idle timeout closes the lobby.
- The 10-minute threshold is exposed as `PLAY_IDLE_TIMEOUT_MS` env var (default `600000`) so tests can shrink it.

## 3. Architecture

```
Browser (client)                          Server (Express, port 4000)
─────────────────                         ────────────────────────────
App                                       httpServer = http.createServer(app)
 ├─ <Routes>                               (existing REST routes unchanged)
 │    /login /decks /community             ▲
 │    (pages unchanged)                    │ REST /api/decks (landing deck list)
 │    /play → PlayView (pure view)         │
 └─ <PlaySessionProvider>                  │
      • mounted for the whole authed app   │
      • owns socket + phase/lobby/match ───┴── WebSocket ws://host/play?token=<jwt>
        state — survives route changes             │
      • on /play: renders Landing/Lobby/Game  ▼
      • elsewhere + active session:     upgrade handler: verify JWT before accepting
        floating "return to match" pill
                                             │ message routing
                                             ▼
                                        LobbyManager (in-memory Map<code, Lobby>)
                                         ├─ create/join/leave/cancel/start
                                         ├─ idle sweep (30s interval, 10 min threshold)
                                         └─ Match engine: card instances, zones,
                                            shuffle/draw/move validation,
                                            full-state broadcast to all seats
```

Key choices:

- **Server-authoritative multiplayer.** Clients send *intents* (`draw`, `shuffle`, `move_card`); the server validates and broadcasts a **full state snapshot** after every mutation. At ≤ 4 players / ~100 cards this is simpler and more robust than delta sync.
- **Mock mode never touches the websocket.** It runs the same zone rules locally in a small pure module (`gameLogic.ts`) so the interactions feel identical.
- **Lobbies are ephemeral, in-memory only.** No DB schema changes. On server restart all lobbies vanish (acceptable for v1).
- The WS endpoint lives on the **same HTTP server/port** as Express; Vite proxies it in dev.

## 4. Data model & protocol

### 4.1 Card instances

A deck is expanded into physical card copies, each with a stable id so individual copies can be moved:

```ts
interface CardInstance {
  id: string;              // uuid — unique per physical copy
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
  type?: string;
}
```

### 4.2 Match state (server → client)

```ts
interface PlayerMatchState {
  userId: string;
  username: string;
  connected: boolean;          // false = ghosted
  life: number;                // starts at 20 — editable only by the player themselves (set_life)
  deck: CardInstance[];        // index 0 = top
  hand: CardInstance[];
  table: CardInstance[];       // the player's own "table" zone (battlefield)
  graveyard: CardInstance[];
}

interface MatchState { players: PlayerMatchState[] }   // client finds itself by userId

interface CardInstance {
  id: string;               // uuid — unique per physical copy
  name: string;
  scryfallOracleId: string;
  manaCost?: string;
  type?: string;
  tapped?: boolean;         // table only — cleared when the card leaves the table
  tablePos?: TablePos;      // table only — { x, y } fractions of zone size (0..1)
  counters?: CardCounters;  // table only — { blue, red, green, white, black }, removed on leaving the table
  token?: TokenInfo;        // present on tokens only — no image; destroyed if moved off the table
}

interface TokenInfo { power: string; toughness: string }   // rendered as "X/Y"; both '' when the token has no P/T
```

At match start, per player: expand `deck.cards` (name × count) into instances → Fisher–Yates shuffle (`crypto.randomInt`) → if the deck has a commander and a matching card exists, remove **one** copy from the pool and place it in `table`. `hand`, `graveyard` start empty.

### 4.3 Lobby snapshot (server → client, public info only)

```ts
interface LobbyPlayerInfo { userId: string; username: string; deckName: string; connected: boolean }
interface LobbyInfo { code: string; status: 'waiting' | 'active'; hostId: string; players: LobbyPlayerInfo[] }
```

### 4.4 Client → server messages (intents)

| Message | Payload | Rules |
|---------|---------|-------|
| `create_lobby` | `{ deckId }` | Deck must belong to user and have ≥ 1 card. Snapshot the deck. Implicitly leaves any current lobby first (waiting → seat removed; active → ghosted). Server generates the code and replies with `lobby_joined`. |
| `join_lobby` | `{ code, deckId? }` | `deckId` required when joining a *waiting* lobby (validated as above); implicitly leaves any **other** current lobby first. Re-entering your own live seat resyncs that tab (`state_update` or `lobby_joined`, no error). If the match is *active*: only allowed to **rejoin your existing seat** (`deckId` ignored); new joiners get error "Match already in progress". |
| `leave_lobby` | `{}` | Waiting: remove seat; host leaves → promote earliest-joined remaining player, or close if empty. Active: mark seat ghosted (`connected: false`), cards stay put. |
| `start_match` | `{}` | Host only, status `waiting`, ≥ 2 players. Builds match state (see 4.2), sets status `active`, broadcasts `match_start`. |
| `cancel_lobby` | `{}` | Host only, status `waiting`. Closes the lobby (`session_end`, reason `host_cancelled`). |
| `draw` | `{}` | Pop index 0 of **your** deck → your hand. Empty deck → `error` "Your deck is empty", no state change. |
| `shuffle` | `{}` | Fisher–Yates on **your** deck only. |
| `move_card` | `{ instanceId, from: 'hand'\|'table'\|'graveyard', to: 'hand'\|'deck'\|'graveyard'\|'table' }` | Card must exist in the requester's `from` zone (this is what enforces "you can't take cards from another player's graveyard"). `to: 'deck'` inserts at index 0 (top). `from === to` is ignored. Stale/unknown instance → `error`. Optional `x`/`y` when `to: 'table'`: landing position (fractions of zone size, clamped to [0..1]²; omitted → center). Leaving the table clears `tapped`, `tablePos`, and `counters`. |
| `tap_card` | `{ instanceId }` | Card must be on the **requester's** table. Toggles `tapped`; leaving the table untaps. |
| `place_card` | `{ instanceId, x, y }` | Card must already be on the requester's table; repositions it (clamped to [0..1]²). Tapped state untouched. |
| `set_counters` | `{ instanceId, counters: { blue, red, green, white, black } }` | Card must be on the **requester's** table. Every count must be an integer in [0..99], else `error` "Invalid counter count". All-zero map clears the card's counters (field removed). Counters exist only while the card is on its owner's table — any move off the table removes them. |
| `create_token` | `{ name, power, toughness }` | Creates a token on the **requester's** table at center. Name is required non-empty (≤ 60 chars after trim); power/toughness are optional but must be set **together** (exactly one → `error` "Power and toughness must both be set"), each ≤ 10 chars when present, else `error`. Tokens have no image; they interact like other table cards but are **destroyed** if moved to hand/deck/graveyard (removed from the table, never added to the destination). |
| `set_life` | `{ life }` | Sets the **requester's** life total. Must be an integer in [0..999], else `error` "Invalid life total". Players start at 20; only the player themselves can change it (the op resolves the requester's own seat). Broadcast to all seats via `state_update`. |

Every message received from a lobby member resets that lobby's `lastActivityAt`.

### 4.5 Server → client messages

| Message | Payload | When |
|---------|---------|------|
| `lobby_joined` | `{ lobby: LobbyInfo }` | After successful create or join of a waiting lobby (includes the code). |
| `lobby_update` | `{ lobby: LobbyInfo }` | Membership / host / connected-status change while waiting. |
| `match_start` | `{ state: MatchState }` | Host started; all seats switch to the game view. |
| `state_update` | `{ state: MatchState }` | After any validated mutation (draw/shuffle/move/reconnect). Also sent when a ghosted player reconnects (full resync). |
| `session_end` | `{ reason: 'idle_timeout' \| 'host_cancelled' \| 'lobby_empty', message: string }` | Lobby closed (waiting or active) — idle sweep, host cancel, or all players gone. Client returns to landing with a banner. |
| `error` | `{ message: string }` | Human-readable rejection; client shows a toast/banner and keeps current view. |

### 4.6 Card-move rules matrix (enforced server-side, mirrored in mock mode)

| From \ To | hand | table | deck (top) | graveyard |
|-----------|------|-------|------------|-----------|
| your hand | — | ✅ | ✅ | ✅ |
| your table | ✅ | — | ✅ | ✅ |
| your graveyard | ✅ | ✅ | ✅ | — |
| anyone else's zone | ❌ (all intents) | ❌ | ❌ | ❌ |

## 5. Implementation steps

### Phase 0 — Dependencies & proxy (foundation)

**Step 0.1 — Add `ws` to the server.**
Files: `server/package.json`.
Add `"ws": "^8.18.0"` to dependencies and `"@types/ws": "^8.5.10"` to devDependencies; `npm install`.

**Step 0.2 — Proxy the websocket path in Vite.**
Files: `client/vite.config.ts`.
Add to `server.proxy`:
```ts
'/play': { target: 'ws://localhost:4000', ws: true, changeOrigin: true },
```
Acceptance: `npm run dev` starts both apps; a raw `new WebSocket('ws://localhost:5173/play')` from the browser console reaches the server (will 401 until Phase 1, which proves routing works).

### Phase 1 — Server websocket foundation

**Step 1.1 — Shared play types.**
Files: new `server/src/play/types.ts`.
Define `CardInstance`, `PlayerMatchState`, `MatchState`, `LobbyInfo`, `LobbyPlayerInfo`, and the client→server / server→client message unions exactly as in §4. Export a `PLAY_IDLE_TIMEOUT_MS` constant reading `process.env.PLAY_IDLE_TIMEOUT_MS ?? 600_000`.

**Step 1.2 — Attach the WebSocketServer to the existing HTTP server.**
Files: `server/src/index.ts`, new `server/src/play/ws.ts`.
- In `index.ts`, replace `app.listen(PORT, …)` with `const httpServer = http.createServer(app); httpServer.listen(PORT, …)`.
- In `play/ws.ts`, export `attachPlay(httpServer, deps)` where `deps = { verifyToken(token): { id, username } | null, getOwnedDeck(userId, deckId): Deck | null }` (implemented in `index.ts` from the existing JWT helper and `db.getDeckById`).
- Create `new WebSocketServer({ noServer: true })`. On `httpServer` `'upgrade'`: only accept pathname `/play`; read `?token=`, verify with `deps.verifyToken`; on failure write a `401 Unauthorized` response and destroy the socket. On success, `wss.handleUpgrade(...)` and emit `connection` with the user attached (`ws.user`).
- On `connection`: register the socket in a `Map<userId, WebSocket>` (one connection per user; if a second connection arrives for the same user while not in a lobby, accept it — lobby membership is what's limited, not sockets).
- Message router: parse JSON (malformed → `error` + ignore), update the member's lobby `lastActivityAt`, then dispatch by `type`. Unknown type → `error`.
Acceptance: connecting without/with a bad token gets HTTP 401 on upgrade; a valid token opens the socket and is echoed back in a test `hello`-style log line.

### Phase 2 — Lobby manager

Files: new `server/src/play/lobbyManager.ts`.

**Step 2.1 — Lobby store & lifecycle.**
In-memory `Map<code, Lobby>` where:
```ts
interface Lobby {
  code: string;                       // 6 chars from "ABCDEFGHJKMNPQRSTUVWXYZ23456789" (no 0/O/1/I/L)
  hostId: string;
  status: 'waiting' | 'active';
  players: LobbySeat[];               // array, join order matters (host promotion uses it)
  match?: MatchState;                 // set when active
  lastActivityAt: number;
}
interface LobbySeat { userId: string; username: string; deckId: string; deckName: string; deckSnapshot: DeckCard[] & { commander?: string }; connected: boolean }
```
Implement: `createLobby(user, deck)`, `joinLobby(user, code, deck?)`, `leaveLobby(userId)`, `cancelLobby(userId)`, `startMatch(code)` (delegates to Phase 3), plus helpers `lobbyByUser(userId)`, `toInfo(lobby): LobbyInfo`.
Rules: unique code generation (retry on collision); max 4 seats; creating/joining implicitly leaves any current lobby first (waiting → seat removed with host promotion; active → ghosted); deck ownership + non-empty check at join (snapshot stored on the seat); waiting-join of a full lobby → error "Lobby is full"; host leaving while waiting → promote `players[0]` of remaining, or close with `session_end { reason: 'lobby_empty' }`; if all seats become disconnected while waiting → close immediately.
After every change, broadcast `lobby_update` (or `lobby_joined` to the joiner) to all connected members.

**Step 2.2 — Idle sweep.**
A single `setInterval(30_000)` started in `attachPlay`: for each lobby, if `Date.now() - lastActivityAt > PLAY_IDLE_TIMEOUT_MS`, close it: send `session_end { reason: 'idle_timeout', message: 'Lobby closed after <actual idle time> of inactivity' }` to all connected members, then delete from the map. The same sweep covers waiting lobbies and active matches (per decision §1). Degenerate `PLAY_IDLE_TIMEOUT_MS` values (< 1000 ms) fall back to the default with a warning, and the effective value is logged at startup (Step 10.12).
Acceptance (manual): with `PLAY_IDLE_TIMEOUT_MS=5000`, an idle lobby closes in ~30–45 s and both clients land back on the Play landing with the banner.

### Phase 3 — Match engine

Files: new `server/src/play/match.ts`.

**Step 3.1 — Build match state.**
`buildMatchState(lobby): MatchState` — for each seat: expand `deckSnapshot` into `CardInstance[]` (uuid per copy), Fisher–Yates with `crypto.randomInt`, commander removal → that player's `table`. Set `lobby.status = 'active'`, `lobby.match = state`, broadcast `match_start { state }`.

**Step 3.2 — Operations.**
Pure-ish functions operating on a seat's zones, each returning `{ ok: true, state } | { ok: false, message }`:
- `draw(lobby, userId)` — pop deck[0] → hand; empty deck → error.
- `shuffleDeck(lobby, userId)` — Fisher–Yates in place.
- `moveCard(lobby, userId, instanceId, from, to)` — locate the instance in the requester's `from` zone (ownership + freshness check), remove it, insert into `to` (`deck` → index 0).
After any successful operation: broadcast `state_update { state }` to all **connected** members.

**Step 3.3 — Wire intents from the router.**
In `play/ws.ts`, map `draw` / `shuffle` / `move_card` to Phase 3 functions, resolving the user's lobby via `lobbyByUser`; "not in a lobby" or wrong status → `error`.
Acceptance (manual, two browser tabs): host + joiner start a match; each sees shuffled decks, empty hands, commander on their own table; draw/move/shuffle update all clients instantly; moving a card to your deck puts it on top (next draw returns it).

### Phase 4 — Client foundation

Files: new `client/src/components/play/` directory, `client/src/App.tsx`, `client/src/components/Navbar.tsx`.

**Step 4.1 — Shared client types.**
New `client/src/types.ts` additions (or `components/play/types.ts`): mirror §4 shapes (`CardInstance`, `PlayerMatchState`, `MatchState`, `LobbyInfo`, message unions). Keep them hand-mirrored of the server types (no shared package in this repo).

**Step 4.2 — Socket wrapper hook.**
New `client/src/components/play/usePlaySocket.ts`:
- `connect()` → `new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/play?token=${getToken()}`)`.
- Exposes `send(intent)` and takes an `onMessage` callback; parses JSON, guards against non-JSON.
- Reconnect: when the socket closes unexpectedly **and** we're in a lobby/match (caller flag), retry with backoff 1s → 2s → 4s → 8s → 15s (capped) for up to ~3 minutes; after each successful reopen, if we hold a `code`, send `join_lobby { code }` to resync. If the server answers `session_end` or an error about a missing lobby, stop retrying and surface it.
- Cleanup on unmount (no reconnects).

**Step 4.3 — Route + nav tab.**
- `App.tsx`: add `<Route path="/play" element={<PlayView/>} />` following the existing pattern (auth gating happens at the provider level, Step 4.4).
- `Navbar.tsx`: add a third `NavLink` "Play" → `/play` (after My Decks), same active-class pattern. No other Navbar changes — tabs stay enabled during a session because the session survives route changes (Step 4.4).
Acceptance: tab appears, route is auth-gated like the others.

**Step 4.4 — Session persistence (no unmount on tab switch).**
Files: new `client/src/components/play/PlaySessionContext.tsx`, `client/src/App.tsx`.
- Move the session state machine + socket **out of `PlayView`** into a `PlaySessionProvider` that wraps all authenticated routes in `App.tsx`: render `<PlaySessionProvider>` around `<Routes>` only when `username` is set (inert — no socket, no pill — otherwise). Since `BrowserRouter` sits above `App`, the provider can use `useLocation`/`useNavigate`.
- The provider owns: `phase: 'landing' | 'lobby' | 'game'`, `mode: 'mock' | 'multiplayer'`, current `LobbyInfo`, current `MatchState`, banner/toast string, and the socket (via `usePlaySocket`). It exposes intent methods — `hostLobby(deckId)`, `joinLobby(code, deckId)`, `startMock(deck)`, `leaveLobby()`, `cancelLobby()`, `startMatch()`, `draw()`, `shuffle()`, `moveCard(instanceId, from, to)` — each dispatching to local logic (mock) or the socket (multiplayer).
- Socket lifecycle: opens on host/join, stays open through lobby + game, closes on `session_end` / return to landing / logout (provider unmount → ghosting, same as closing the browser).
- Because state lives above `<Routes>`, navigating to `/decks` or `/community` (nav click, back button, or typed URL) never unmounts the session. While a session is active and the current route is not `/play`, the provider renders a small fixed pill — "⚔️ Match in progress — Return" (`useNavigate()` → `/play`).
- `PlayView` becomes a pure view: reads the context, renders Navbar + one of {PlayLanding, LobbyModal over landing, GameTable} based on phase. It owns nothing session-related.
- Optional variant (not default): hard-disable the Community/My Decks `NavLink`s while `phase !== 'landing'` (render as muted non-navigating buttons with a "Leave the lobby first" tooltip) — one small change in `Navbar.tsx`, only if the always-on-tabs behavior above is not wanted.
Acceptance: start a lobby, switch to My Decks and hit browser back — socket stays connected (DevTools / server log), pill appears on the other pages; return → session exactly as left.

### Phase 5 — Play landing & lobby modal

Files: new `PlayView.tsx`, `PlayLanding.tsx`, `LobbyModal.tsx`.

**Step 5.1 — Session state machine (in the provider).**
`PlaySessionProvider` (Step 4.4) owns: socket hook, `phase`, current `LobbyInfo`, current `MatchState`, and a banner/toast string. Message → phase mapping: `lobby_joined` → `lobby`; `match_start` / `state_update` (with code) → `game`; `session_end` → `landing` + banner; `error` → toast. `PlayView` (the `/play` route component) renders Navbar + one of {PlayLanding, LobbyModal over landing, GameTable} from that state — it owns nothing session-related.

**Step 5.2 — PlayLanding.**
- Deck dropdown fed by `api.getDecks()` (sorted by name, same pattern as `DeckEditor`), showing card total; play controls disabled until a non-empty deck is selected.
- **Mock** section: "▶ Play Mock" button → builds local match state (Phase 8) and goes straight to the game view with no socket.
- **Multiplayer** section: "Host Lobby" button (sends `create_lobby { deckId }`) and a code input (6 chars, uppercased on input) + "Join" button (sends `join_lobby { code, deckId }`).
- Errors from the server render in a small banner above the controls.

**Step 5.3 — LobbyModal.**
Backdrop + dialog following the existing `hand-modal` pattern:
- Header shows the lobby code large with a copy-to-clipboard button; subtitle "Share this code to let others join".
- Player list rows: username, deck name, 👑 on host, green/gray dot for connected.
- Host controls: **Start Match** (disabled below 2 players) and **Cancel Lobby**; non-host sees **Leave**.
- Closes itself on `match_start` / `session_end`.
Acceptance (manual): host in one tab sees the code; second user joins with it and both lists update live; host cancel returns both to landing; starting with 2+ players flips everyone to the table.

### Phase 6 — Game table layout & card rendering

Files: new `GameTable.tsx`, `OpponentZone.tsx`, additions to `client/src/styles.css`.

**Step 6.1 — Layout.**
CSS grid, desktop-first:
```
┌──────────────────────────────────────────────────────────────┐
│ top bar: lobby code • player chips (name + dot)      [Leave] │
├──────────────────────────────────────────────────────────────┤
│  ┌ Opponent A ──┐   ┌ Opponent B ──┐   ┌ Opponent C ──┐     │
│  │ deck ⬛×n      │   │ …            │   │ …            │     │
│  │ GY 🪦×n       │   │              │   │              │     │
│  │ table [c][c]  │   │              │   │              │     │
│  │ hand ⬛⬛⬛ ×n  │   │              │   │              │     │
├──────────────────────────────────────┬───────────────────────┤
│            YOUR TABLE ZONE           │  YOUR DECK  ⬛×n       │
│        (center, drop target)         │  (click = draw,       │
│                                      │   right-click = menu) │
├──────────────────────────────────────┤  GRAVEYARD 🪦×n       │
│ YOUR HAND — row of face-up cards     │                       │
└──────────────────────────────────────┴───────────────────────┘
```
- Right column holds **your** deck stack and graveyard pile (per spec: "on the right side of the table").
- Opponent zones across the top (1–3), each showing: face-down deck count, clickable graveyard pile, their table cards (small, face-up), face-down hand count. Opponent elements are render-only — no drag handlers anywhere in another player's zone.
- "Leave" button sends `leave_lobby` (ghosts you) and returns to landing.

**Step 6.2 — Card rendering.**
- Reuse `CardImage` + `getCardImageUrl`; pre-fetch image URLs for all unique `scryfallOracleId`s in the current state (`Promise.all`, keyed map, refreshed when new card names appear).
- Face-down cards (your/opponent decks, opponent hands): CSS-only card back (gradient + border, no asset), with a count badge.
- Sizes: hand cards ~120px wide; table cards ~90px; opponent-zone cards ~64px. Hand row scrolls horizontally when full.

### Phase 7 — Interactions

Files: `GameTable.tsx`, new `GraveyardList.tsx`, `ContextMenu.tsx`.

**Step 7.1 — Draw & shuffle (your deck).**
- Left-click your deck stack → send `draw`. Empty-deck error surfaces as a toast.
- Right-click your deck stack → `onContextMenu` with `preventDefault()` opens a small custom context menu at the cursor with one item: **Shuffle Deck** → sends `shuffle`. Menu closes on outside click, Escape, or after choosing. (Opponent decks get no custom menu.)

**Step 7.2 — Graveyard list + drag out.**
- Left-click **any** graveyard pile (yours or an opponent's) opens `GraveyardList`: a modal listing every card as one text row per instance (name; duplicates appear as repeated rows), sorted by name.
- Own graveyard: each row is `draggable`; `onDragStart` sets `dataTransfer.setData('text/plain', JSON.stringify({ instanceId, from: 'graveyard' }))`.
- Opponent's graveyard: plain non-draggable rows plus a note "You can't take cards from another player's graveyard." (Server enforces this regardless.)

**Step 7.3 — Hand → table, and table → zones (HTML5 DnD).**
- Every card in **your** hand and **your** table is `draggable` with the same payload shape (`from: 'hand' | 'table'`).
- Drop targets (only your own): table zone, hand area, deck stack, graveyard pile. Each implements `onDragOver` (`preventDefault()` + highlight class) and `onDrop` (parse payload → send `move_card { instanceId, from, to }`; ignore if `from === to`).
- Optimistic rendering is **not** done — the UI updates from the authoritative `state_update`, keeping one source of truth.
Acceptance (manual): full round-trip works — hand → table → deck (next draw returns it), table → graveyard, graveyard list → drag row back to table; opponent cards are never draggable.

### Phase 8 — Mock mode

Files: new `client/src/components/play/gameLogic.ts`, wiring in `PlaySessionContext.tsx` (`startMock` + local intent dispatch) and `GameTable`.

**Step 8.1 — Local game logic.**
Pure functions mirroring §4.6 (Math.random shuffle is fine locally):
- `createMockMatch(deck: Deck, username): MatchState` — expand copies, shuffle, commander → table, empty hand/graveyard.
- `draw(state, userId)`, `shuffleDeck(state, userId)`, `moveCard(state, instanceId, from, to)` — return new state or an error string; same rules as the server (including top-of-deck = index 0).

**Step 8.2 — Wire mock into GameTable.**
`GameTable` takes a `mode: 'mock' | 'multiplayer'`. In mock mode intents call the local functions and set state directly (no socket); in multiplayer they go through the socket. All rendering/interaction code is shared between modes. "Exit" returns to landing.
Acceptance: mock play is indistinguishable from a 1-player multiplayer match except for the top bar; all Phase 7 interactions work offline-of-the-server.

### Phase 9 — Ghosting/reconnect polish, tests, docs

**Step 9.1 — Ghost UX.**
Disconnected seats render with a gray dot and "disconnected" label in the player chips and opponent zones; their cards remain visible and immovable by others. On reconnect (auto-retry from Step 4.2 + `join_lobby { code }`), the server marks the seat connected and sends `state_update`; the client resumes seamlessly. If the lobby was idle-closed while away, the client shows the banner and returns to landing.

**Step 9.2 — Extend smoke test.**
Files: `smoke-test.mjs`.
Node 22 has a global `WebSocket`, so append a play section (server started with `PLAY_IDLE_TIMEOUT_MS=3000`): register two users + decks → A `create_lobby` (expect code) → B `join_lobby` (both get `lobby_update`) → A `start_match` (both get `match_start`; assert 4 zones, empty hands, commander on table if deck has one) → A `draw` (hand length 1) → A `move_card` hand→table → A `move_card` table→deck then `draw` (same instance returns — top-of-deck proof) → B attempts to move A's card (expect `error`) → B `leave_lobby` (A gets `state_update` with B `connected: false`) → wait ~10 s for idle sweep (both get `session_end { reason: 'idle_timeout' }`).

**Step 9.3 — README + cleanup.**
Add a "Play" feature bullet (mock + lobby codes, up to 4 players, 15-min idle close) and mention the `/play` websocket endpoint. Run `npm run build` for both workspaces; fix type errors.

### Phase 10 — Post-plan play refinements (DONE)

**Step 10.1 — Tap/untap table cards.**
Clicking one of your own table cards toggles its `tapped` state (server op `tap_card`, ownership + zone check). Tapped cards render rotated 90° (transform-only, 150 ms transition) in the owner's zone and every opponent zone. A card that leaves the table comes back untapped.
Acceptance: smoke test asserts tap/untap sync to both seats and rejects foreign taps; two-browser E2E proves the rotation is visible in both browsers.

**Step 10.2 — Free-form table placement.**
Table cards are absolutely positioned by a normalized `tablePos {x, y}` (fractions of zone size, clamped to [0..1]²):
- Drops from hand/graveyard onto your table zone land at the cursor position (`move_card` with optional `x`/`y`).
- Table cards can be re-dragged anywhere on the table (server op `place_card`; tapped state is preserved).
- A dashed ghost preview follows the cursor over the table zone while dragging; the dragged card dims in place.
- Opponent zones mirror each owner's layout at small-card scale (render-only).
- Positions are server-authoritative, broadcast to all seats via `state_update`; leaving the table clears `tablePos`, re-entering without coordinates defaults to center.
Acceptance: smoke test covers commander default-center, positioned move, `place_card` sync to both seats, clamping, foreign-place rejection, and clear-on-leave; two-browser E2E proves ghost preview + drop-at-cursor + mirrored normalized positions in the opponent zone.

**Step 10.3 — Card zoom (right-click menu + graveyard magnifier).**
Right-clicking a hand card, your own table card, or **any opponent's table card** opens the shared `ContextMenu` with a single option, "🔍 Zoom card". Choosing it opens `CardZoomModal`: a large view of the card (Scryfall CDN `large` tier derived from the stored image URL) with the card name. Clicking the backdrop (outside the dialog) or pressing Escape closes it; clicking the card itself does not. Every row in the `GraveyardList` modal — **own and opponents'** — has a magnifying-glass button that opens the same zoom modal for that card. Opponent zones stay render-only otherwise: no drag handlers, ever.
Acceptance: E2E proves menu contents, modal title per card, inside-click keeps open, backdrop click + Escape close; two-browser E2E proves opponent-table-card zoom and 🔍 on own + opponent graveyard rows.

**Step 10.4 — Equal play space (player-count grid).**
The old layout (opponent strip across the top + big own area) is replaced by a grid of equal `PlayerCell`s so every player gets the same amount of screen space:
- 1 player (mock) → one full-area cell.
- 2 players → two half-screen cells side by side.
- 3–4 players → 2×2 grid; missing seats render as blank dashed cells (a 3-player game draws 4 slots, the 4th left empty).
- You always occupy the first slot; opponents follow in seat order.
Each cell is identical for everyone: header (name; opponent hand-count chip; deck and graveyard chips — all three mini card backs with count badges and a centered icon: 🃏 deck, 🖐️ hand, 🪦 graveyard), free-form table zone (same card size in every cell — `--tx/--ty` positioning scales to the zone), hand strip. Opponents have **no hand strip** — their hidden hand renders as a deck-styled card-back chip with a count badge, placed left of the deck chip; only your own cell shows the face-up hand strip (which also gives opponents' table zones more room). Deck chip: click = draw, right-click = shuffle menu, drop = top of deck. Opponent cells stay render-only except right-click zoom and clicking the graveyard chip.
Acceptance: E2E proves grid-1 in mock, grid-2 with equal half-widths + working draw/drag/zoom/GY-chip + mirrored table for 2P, and grid-4 with exactly one blank content-free cell (own cell first) on all three pages for 3P; a second E2E proves the opponent hand chip is deck-styled, sits left of the deck chip, its badge matches the opponent's real hand size, and own/mock hand strips are unaffected.

**Step 10.5 — Relaxed lobby membership + 10-minute idle timeout.**
Players are never blocked by an old lobby: `createLobby` and `joinLobby` call a shared private helper `detachFromCurrentLobby(userId)` that applies leave semantics to the user's current lobby (waiting → seat removed, host promotion, broadcast; active → ghosted, cards stay, state broadcast). Joining validates first (active/full/deck checks) so a *failed* join never strands the user in their old lobby. `leaveLobby` keeps its not-in-lobby guard and delegates to the same helper. Bonus: re-entering your own **live** lobby's code resyncs that tab (`state_update` when active, `lobby_joined` when waiting) instead of erroring — safe because `socketsByUser` keeps only the latest socket per user. The idle timeout default dropped from 15 to **10 minutes** (`PLAY_IDLE_TIMEOUT_MS ?? 600_000`; sweep message updated).
Acceptance: WS E2E (10/10) proves create-while-in-active-lobby (old seat ghosted, other player keeps the match), join-while-in-waiting-lobby (old seat removed, its remaining player sees the update), same-lobby re-entry resync, full-lobby join still errors without touching the old lobby; smoke suite 46/46 unchanged.

**Step 10.6 — Icons on deck + hand chips.**
The deck chip and the opponent hand chip get centered icons exactly like the graveyard: 🃏 on every deck card back, 🖐️ on every hand chip (`.cell-deck .card-back` now `display:grid; place-items:center`, same as `.cell-gy .card-back`); all three share one symbol rule (`.gy-symbol, .deck-symbol, .hand-symbol`).
Acceptance: E2E proves the symbols render in mock + 2P and each icon's bounding-box center matches its card back's center within a few px.

**Step 10.7 — Card counters.**
Right-clicking one of **your own table cards** gains a second context-menu option, "Counters..." (opponent cards and hand cards keep zoom-only). It opens `CounterModal`: five colored circles in fixed order (blue, red, green, white, black), each showing its count in the center with − / + buttons on either side. Counts floor at 0 (− disabled at 0) and cap at 99 (+ disabled at 99); OK sends `set_counters` with the full map (an all-zero map clears the card's counters), Cancel / backdrop click / Escape close without applying. The server validates ownership + table zone + integer counts in [0..99] (`Invalid counter count` otherwise) and strips the field when the total is 0.
Rendering: one small colored dot per counter, a column starting at the card's **bottom-left** and stacking upward (flex `column-reverse`, fixed color order). Pips are rendered *inside* `.gt-card-cell`, so they inherit the tap rotation for free. Counters are server-authoritative and visible to all players via `state_update`; leaving the table (graveyard/hand/library) removes them entirely, like `tapped`/`tablePos`.
Acceptance: E2E (26/26) proves menu gating (own table card only), modal init from current state, +/− math with 0-floor and disabled buttons, pip counts/colors/bottom-left placement, tap-rotation of the pip column ((dx,dy)→(−dy,dx) about card center), full removal after a graveyard round-trip (modal reopens all-zero), and two-player visibility (B sees A's pips; B's menu on A's card has no "Counters..."); smoke suite 46/46 unchanged.

**Step 10.8 — Tokens.**
A "+" button sits in your cell's chip row, **left of your deck chip** (own cell only). It opens `TokenModal` with three text boxes — Name (required), Power and Toughness (optional, but must be set together; a hint line says to leave both blank for tokens without P/T) — and creates a token on your table via the server op `create_token`. Tokens have no image: they render as a card face with the **name at the top** (small text, wrapping) and, when present, **power/toughness as "X/Y" at the bottom** (without P/T the name is centered vertically), both horizontally centered. They interact exactly like other table cards — draggable/re-draggable, tap/untap, right-click menu (Zoom + Counters), counters pips — and are server-authoritative, so every player sees them via `state_update`. The one rule difference: a token **cannot exist off the table** — dragging it to your hand, deck, or graveyard destroys it (it is removed from the table and never added to the destination zone). Zooming a token shows an enlarged token face instead of an image.
Acceptance: E2E (33/33 + 13/13) proves + button placement (own cell only), modal fields/validation/Escape, optional P/T (name-only token renders without "X/Y" and with the centered-face modifier; exactly one of power/toughness keeps OK disabled), default center position, counters + tap on tokens, destruction on drops to graveyard/hand/deck with destination counts unchanged, and two-player visibility (B sees A's token face; B's menu on A's token is zoom-only); smoke suite 46/46 unchanged.

**Step 10.9 — Life totals.**
Each player has a life total (starts at **20**, standard MTG) shown in their cell header, right of the name, as a small pill with a ♥. The local player's pill is an **editable textbox** — type a whole number and press Enter (or blur) to commit; invalid input (non-numeric, negative, or above 999) reverts to the last committed value. Opponents' pills are **read-only numbers** — no textbox. Changes go through the server op `set_life` (integer in [0..999]) and broadcast via `state_update`, so every other player sees the new number immediately.
Acceptance: E2E (13/13) proves start-at-20, commit-on-Enter, revert of non-numeric/negative/>999 input, two-player broadcast (A→B and B→A), read-only opponent pills (no input element in opponent cells), and both values coexisting; smoke suite 46/46 unchanged.

**Step 10.10 — Place Card... (precise deck placement).**
Right-clicking one of **your own table cards** gains a third context-menu option, "Place Card..." (opponent cards and hand cards keep their existing items). It opens `PlaceCardModal` with four radio options for where that card goes: **On Top of Deck**, **On Bottom of Deck**, **Graveyard**, or **X from the Top of the Deck** — a numeric field (1..deck size+1, disabled until its radio is selected) that inserts the card into the deck at that depth (1 = on top). Out-of-range input keeps Place disabled client-side; Cancel / backdrop click / Escape close without moving. The move rides the existing `move_card` op with a new optional `deckPosition` field (`'top'` | `'bottom'` | number) sent only when `to === 'deck'`; the server validates the depth (1..deck size+1, integer — otherwise `Position must be between 1 and N`) **before** removing the card so a failed move never strands it. Omitted field keeps the old top-of-deck behavior, so existing clients are unaffected; the field is ignored for non-deck destinations.
Acceptance: E2E (19/19) proves menu gating (own table cards only — hand cards stay zoom-only), modal title/subtitle, Escape-without-moving, depth validation (out-of-range disables Place, in-range enables), and all four destinations in fresh mock sessions (depth-2 card drawn on the 2nd draw; top card drawn immediately; bottom card survives 4 top draws and returns on the 5th; graveyard placement shows in the GY list); smoke suite now 51/51 (+5: bottom append, out-of-range error, depth-2 insert, field ignored off-deck).

**Step 10.12 — Idle timeout: make misconfiguration visible (bug fix).**
Production report: players kicked from lobbies after ~5 s with `session_end { idle_timeout }` claiming "10 minutes of inactivity". The sweep logic was correct under defaults (verified: a clean `npm run prod` build kept a two-player lobby open for 45+ s), but `PLAY_IDLE_TIMEOUT_MS` can be silently overridden by the shell — the classic leak is running `npm run prod` in the same terminal that set `$env:PLAY_IDLE_TIMEOUT_MS='3000'` for smoke testing, which shrinks the sweep tick to 3 s and closes lobbies ~5 s after the last action. Three hardenings: (1) degenerate values are no longer honored — `PLAY_IDLE_TIMEOUT_MS` below 1000 ms (including `''`/`0`, which parse to 0 and would close every lobby on the first sweep tick) falls back to the 10-minute default with a console warning; (2) the server logs the effective timeout at startup (`[play] lobby idle timeout: 600 s (set via PLAY_IDLE_TIMEOUT_MS)`), so a leaked value is visible in the console; (3) the close message now reports the ACTUAL idle time ("Lobby closed after 5 seconds of inactivity") instead of a hardcoded "10 minutes", so an unexpected kick self-diagnoses.
Acceptance: smoke suite 57/57 with `PLAY_IDLE_TIMEOUT_MS=3000` (valid small values are still honored — the final idle-sweep step still closes both clients); a server started with `PLAY_IDLE_TIMEOUT_MS=0` logs the warning, runs at 600 s, and keeps a two-player lobby open for 45+ s.

**Step 10.13 — Commander eligibility: any legendary creature type (bug fix).**
The deck editor only offered "Set as commander" for cards whose type line contained the exact substring `Legendary Creature` — which silently excluded every multi-word card type: **Legendary Artifact Creatures** ("Legendary Artifact Creature — Golem"), **Legendary Enchantment Creatures** ("Legendary Enchantment Creature — Demigod"), and even plain creatures with an extra keyword in between ("Legendary Snow Creature — …"). The check is now `type.startsWith('Legendary') && /\bCreature\b/.test(type)` (supertypes always lead the type line), so any legendary creature qualifies while legendary non-creatures (planeswalkers, artifacts, enchantments) stay excluded. Verified across the full 36k-card dataset: 221 cards newly eligible, 0 previously-eligible cards lost.
Acceptance: E2E probe in a real browser — deck containing Alibou, Ancient Witness (artifact creature), Anax, Hardened in the Forge (enchantment creature), "Brims" Barone (plain creature), Karn Liberated (legendary planeswalker) and Forest shows the commander toggle on exactly the first three; smoke suite 57/57 unchanged.

| File | Phase 10 change |
|------|-----------------|
| `server/src/play/types.ts` | + `TablePos`, `CardInstance.tablePos?`, `MoveCardMessage.x?/y?`, `PlaceCardMessage` |
| `server/src/play/match.ts` | + `clampTablePos`; move-to-table sets position; leaving clears it (+ untaps); new `placeCard` op |
| `server/src/play/lobbyManager.ts` / `ws.ts` | + `place_card` routing, broadcast, client-message type |
| `client/src/types.ts` | mirrored types |
| `client/src/components/play/gameLogic.ts` | mock mirror (positioned move, `placeCard`, commander center) |
| `client/src/components/play/PlaySessionContext.tsx` | + `placeCard` intent; `moveCard` takes optional position |
| `client/src/components/play/playDnd.ts` | + active-drag tracking (`getActiveDrag`/`clearActiveDrag`) gating the ghost |
| `client/src/components/play/GameTable.tsx` | player-count grid layout (1/2/4 equal cells); right-click zoom menu; DnD state passed to PlayerCell |
| `client/src/components/play/PlayerCell.tsx` | **new** — unified per-player play area (header chips incl. opponent hand-count chip, table zone, own-only hand strip) |
| `client/src/components/play/CardZoomModal.tsx` | **new** — large card view modal (backdrop click / Escape closes) |
| `client/src/components/play/OpponentZone.tsx` | **removed** — replaced by PlayerCell |
| `client/src/components/play/GraveyardList.tsx` | + 🔍 zoom button on every row (own & opponent graveyards) |
| `client/src/styles.css` | absolute positioning via `--tx/--ty`, 180 ms left/top slide, tapped-rotate variants, ghost + dim styles |
| `smoke-test.mjs` | + placement checks (46 total) |
| `server/src/play/lobbyManager.ts` | Step 10.5: `detachFromCurrentLobby` helper; create/join no longer reject "already in a lobby"; same-lobby re-entry resyncs |
| `server/src/play/types.ts` | Step 10.5: idle timeout default 900_000 → 600_000 (10 min) |
| `server/src/play/types.ts` / `match.ts` / `lobbyManager.ts` / `ws.ts` | Step 10.7: `CounterColor`/`CardCounters`, `CardInstance.counters?`, `set_counters` op + routing; leaving the table also clears counters |
| `client/src/types.ts` / `gameLogic.ts` / `PlaySessionContext.tsx` | Step 10.7: mirrored types, mock `setCounters` op, session intent |
| `client/src/components/play/CounterModal.tsx` | **new** (Step 10.7) — five colored circles with +/−, OK applies / Cancel+Escape close |
| `client/src/components/play/GameTable.tsx` / `PlayerCell.tsx` | Step 10.7: "Counters..." menu item (own table cards only), modal wiring, pip column inside `.gt-card-cell` |
| `client/src/styles.css` | Step 10.7: pip + counter-modal styles |
| `server/src/play/types.ts` / `match.ts` / `lobbyManager.ts` / `ws.ts` | Step 10.8: `TokenInfo`, `CardInstance.token?`, `create_token` op + routing; `moveCard` destroys tokens leaving the table |
| `client/src/types.ts` / `gameLogic.ts` / `PlaySessionContext.tsx` | Step 10.8: mirrored types, mock `createToken` op + destroy rule, session intent |
| `client/src/components/play/TokenModal.tsx` | **new** (Step 10.8) — Name / Power / Toughness dialog |
| `client/src/components/play/GameTable.tsx` / `PlayerCell.tsx` / `CardZoomModal.tsx` | Step 10.8: + button (own cell, left of deck chip), modal wiring, token face render, enlarged token in zoom |
| `client/src/styles.css` | Step 10.8: token face + dialog styles |
| `server/src/play/types.ts` / `match.ts` / `lobbyManager.ts` / `ws.ts` | Step 10.9: `PlayerMatchState.life`, `set_life` op (integer 0..999, start 20) + routing |
| `client/src/types.ts` / `gameLogic.ts` / `PlaySessionContext.tsx` | Step 10.9: mirrored types, mock `setLife` op, session intent |
| `client/src/components/play/PlayerCell.tsx` / `GameTable.tsx` | Step 10.9: life pill in header (editable input for self, number-only for opponents), wiring |
| `client/src/styles.css` | Step 10.9: life pill styles |
| `server/src/play/types.ts` / `match.ts` / `lobbyManager.ts` / `ws.ts` | Step 10.10: `MoveCardMessage.deckPosition?`; `moveCard` validates depth before removal, places top/bottom/at-depth; omitted = old top behavior |
| `client/src/types.ts` / `gameLogic.ts` / `PlaySessionContext.tsx` | Step 10.10: mirrored type, mock `moveCard` deck placement, session intent passes `deckPosition` for deck moves |
| `client/src/components/play/PlaceCardModal.tsx` | **new** (Step 10.10) — four radio options + numeric depth field, Place disabled on out-of-range |
| `client/src/components/play/GameTable.tsx` | Step 10.10: "Place Card..." menu item (own table cards only), modal wiring |
| `client/src/styles.css` | Step 10.10: place-modal styles |
| `smoke-test.mjs` | Step 10.10: +5 deckPosition checks (51 total) |
| `server/src/play/types.ts` | Step 10.12: degenerate `PLAY_IDLE_TIMEOUT_MS` (< 1000 ms, incl. `''`/`0`) falls back to default + console warning |
| `server/src/play/lobbyManager.ts` | Step 10.12: idle-close message reports actual idle time (`formatIdleMs`) instead of hardcoded "10 minutes" |
| `server/src/play/ws.ts` | Step 10.12: logs the effective idle timeout at startup |
| `client/src/components/DeckEditor.tsx` | Step 10.13: `isLegendaryCreature` accepts all legendary creature type lines (artifact/enchantment/snow creatures), not just the exact "Legendary Creature" substring |

## 6. Edge cases & validation matrix

| Scenario | Behavior |
|----------|----------|
| Join with wrong/unknown code | `error` "Lobby not found". |
| Join a full lobby (4 seats) | `error` "Lobby is full". |
| Join an active match without a seat | `error` "Match already in progress". |
| User already in a lobby, creates/joins another | Old lobby is left automatically (waiting → seat removed; active → ghosted); the new create/join proceeds. |
| User re-enters their own live lobby's code | Resync (`state_update` / `lobby_joined`) — no error. |
| Empty deck at join | `error` "Your deck has no cards" (checked against the snapshot). |
| Host starts with 1 player | Button disabled client-side; server also rejects. |
| Host cancels / leaves waiting lobby | Cancel → `session_end { host_cancelled }`; leave → host promotion or `lobby_empty`. |
| Draw from empty deck | `error` "Your deck is empty"; no state change. |
| Move a card not in the claimed zone (stale UI) | `error` "Card not found"; client resyncs on next `state_update`. |
| Move someone else's card (tampered client) | Rejected — ownership check in `moveCard`. |
| `set_counters` on someone else's / non-table card | `error` "Card not found" — the instance must be on the requester's table. |
| `set_counters` with negative, fractional, or >99 counts | `error` "Invalid counter count"; no state change. All-zero map clears the card's counters. |
| Card with counters leaves the table (graveyard/hand/library) | Counters removed entirely (same as tap + position); re-entering the table starts clean. |
| Token dragged to hand / deck / graveyard | Token destroyed — removed from the table, **not** added to the destination zone (counts there unchanged). |
| `create_token` with missing/over-long fields | `error` ("Token name is required" / "…is too long"); no state change. |
| `create_token` with exactly one of power/toughness | `error` "Power and toughness must both be set"; no state change. Both blank is valid (token renders without the "X/Y" line). |
| Life total set to non-integer / negative / > 999 | `error` "Invalid life total"; unchanged. Client input reverts invalid text to the last committed value on Enter/blur. |
| Disconnect mid-match | Seat ghosted; others continue; reconnect by code restores seat. |
| All players disconnected while waiting | Lobby closes immediately (`lobby_empty`). |
| 10 min idle, waiting or active | `session_end { idle_timeout }`; lobby deleted. Any action resets the timer. |
| Server restart | All lobbies/matches gone (in-memory); clients' reconnect attempts get "Lobby not found" → banner + landing. |
| Switch tabs / back button mid-session | Session continues in the provider; the other page renders normally; floating pill returns to `/play`. Nothing unmounts, no state lost. |
| Logout mid-session | Provider unmounts, socket closes; user is ghosted from the lobby (same as closing the browser). |
| Refresh mid-session | v1: reload loses in-memory session state → landing; re-enter the code to rejoin (ghost seat persists until idle-close). sessionStorage auto-rejoin is a possible follow-up. |
| Same user opens a second tab in a lobby | Latest socket wins (per-user `socketsByUser`); the new tab can re-enter the code to resync into the lobby, and its create/join of *another* lobby implicitly leaves this one. |
| Malformed WS message / bad JSON | `error` sent, socket stays open. |

## 7. Manual QA checklist

Mock mode: select deck → Play Mock → commander on table, empty hand → click deck to draw several cards → right-click deck → Shuffle → drag hand card to table → right-click it → Counters... → set a few of two colors (check 0-floor) → OK → pips stack from the bottom-left; tap the card and verify the pips rotate with it → click + left of your deck chip → New Token (name/power/toughness) → token appears center-table with name on top and "X/Y" at the bottom, no image → add counters to it, then drag it to graveyard / hand / top of deck and verify each time that it is destroyed (destination counts unchanged) → open own graveyard list → drag a row back to table (counters gone — reopen Counters... to confirm all-zero) → edit the life pill right of your name (type a number, Enter; try an invalid value and watch it revert) → right-click your commander on the table → Place Card... → pick "X from the Top of the Deck" with 2 (try an out-of-range number first — Place stays disabled), then draw twice and confirm it returns second → do it again for On Top / On Bottom / Graveyard and verify each destination → exit.

Multiplayer: host in tab A (note code) → join in tab B with code → both see each other in LobbyModal → start → verify shuffled decks + commander placement on both sides → A draws, B shuffles, A drags hand→table → B sees updates live → mid-match, tab A clicks My Decks and hits browser back → match keeps running with no state loss, floating "return to match" pill appears → click the pill → session resumes exactly as left → B opens A's graveyard (empty at first), then after A moves a card there: list shows it, rows not draggable → B tries dragging one of A's table cards (impossible — no drag handle) → A edits their life pill (e.g. 15) and B sees the number update live in A's header (B's own pill is editable, A's is a plain number on B's screen) → close tab B (disconnect) → A sees gray "disconnected" dot, cards intact → reopen tab B, re-enter code → seat restored, state resynced → let the lobby sit 10 min (or use the env override) → both land on Play landing with the idle banner.

## 8. File change summary

| File | Change |
|------|--------|
| `server/package.json` | + `ws`, + `@types/ws` |
| `server/src/index.ts` | `http.createServer(app)`; pass JWT verify + deck lookup into `attachPlay` |
| `server/src/play/types.ts` | **new** — shared play types, idle-timeout constant |
| `server/src/play/ws.ts` | **new** — WebSocketServer, upgrade auth, message router |
| `server/src/play/lobbyManager.ts` | **new** — lobby lifecycle, codes, host promotion, idle sweep |
| `server/src/play/match.ts` | **new** — match build + draw/shuffle/move validation + broadcast |
| `client/vite.config.ts` | + `/play` websocket proxy |
| `client/src/App.tsx` | + `/play` route; wrap authenticated routes in `PlaySessionProvider` |
| `client/src/components/Navbar.tsx` | + "Play" tab (no other changes — tabs stay enabled during a session) |
| `client/src/types.ts` | + play/match types (mirrored) |
| `client/src/components/play/PlaySessionContext.tsx` | **new** — provider owning socket + phase state; floating return pill |
| `client/src/components/play/PlayView.tsx` | **new** — pure `/play` view (reads session context) |
| `client/src/components/play/PlayLanding.tsx` | **new** — deck select, mock button, host/join UI |
| `client/src/components/play/LobbyModal.tsx` | **new** — players, code, host start/cancel |
| `client/src/components/play/GameTable.tsx` | **new** — table layout + interactions (mock & multiplayer) |
| `client/src/components/play/OpponentZone.tsx` | **new** — read-only opponent zone |
| `client/src/components/play/GraveyardList.tsx` | **new** — text list modal, drag out of own only |
| `client/src/components/play/ContextMenu.tsx` | **new** — right-click menu (Shuffle Deck) |
| `client/src/components/play/usePlaySocket.ts` | **new** — socket wrapper + reconnect/backoff |
| `client/src/components/play/gameLogic.ts` | **new** — pure mock-mode game logic |
| `client/src/styles.css` | + play view, zones, card backs, drop highlights, context menu styles |
| `smoke-test.mjs` | + websocket lobby/match section (uses global `WebSocket`) |
| `README.md` | + Play feature notes |
