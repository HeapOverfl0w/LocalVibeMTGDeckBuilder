// Target host is overridable (SMOKE_HOST) so the test can run against a
// dedicated server instance; defaults to the standard dev server.
const HOST = process.env.SMOKE_HOST ?? 'localhost:4000';
const BASE = `http://${HOST}/api`;

async function req(method, path, { token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? undefined : await res.json();
  return { status: res.status, data };
}

const results = [];
function check(name, cond) {
  results.push({ name, ok: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}: ${name}`);
}

// Register a fresh user (unique per run so the test is re-runnable)
const username = 'smoketest_' + Date.now();
const reg = await req('POST', '/auth/register', { body: { username, password: 'password123' } });
check('register returns token', reg.status === 200 && reg.data.token);
const token = reg.data.token;

// Duplicate register should 409
const dup = await req('POST', '/auth/register', { body: { username, password: 'password123' } });
check('duplicate register 409', dup.status === 409);

// Login
const login = await req('POST', '/auth/login', { body: { username, password: 'password123' } });
check('login returns token', login.status === 200 && login.data.token);

// me
const me = await req('GET', '/auth/me', { token });
check('me returns username', me.status === 200 && me.data.username === username);

// Create deck
const deckBody = {
  name: 'Smoke Deck',
  commander: 'Birthing Pod',
  cards: [
    { name: 'Birthing Pod', scryfallOracleId: 'f8b9dd54-0837-47f4-ad14-7a0322d46d5f', count: 1 },
    { name: 'Forest', scryfallOracleId: 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6', count: 15 },
  ],
};
const created = await req('POST', '/decks', { token, body: deckBody });
check('create deck 201', created.status === 201 && created.data.id);
const deckId = created.data.id;

// List decks
const list = await req('GET', '/decks', { token });
check('list decks includes new deck', list.status === 200 && list.data.some((d) => d.id === deckId));

// Update deck
const updated = await req('PUT', `/decks/${deckId}`, { token, body: { ...deckBody, name: 'Smoke Deck v2' } });
check('update deck renames', updated.status === 200 && updated.data.name === 'Smoke Deck v2');

// Heart deck (toggle: first call adds a heart)
const heart = await req('POST', `/decks/${deckId}/heart`, { token });
check('heart deck 200', heart.status === 200 && heart.data.hearts === 1 && heart.data.hearted === true);

// Un-heart deck (toggle: second call removes the heart)
const unheart = await req('POST', `/decks/${deckId}/heart`, { token });
check('un-heart deck 200', unheart.status === 200 && unheart.data.hearts === 0 && unheart.data.hearted === false);

// Re-heart for subsequent tests
const reheart = await req('POST', `/decks/${deckId}/heart`, { token });
check('re-heart deck 200', reheart.status === 200 && reheart.data.hearts === 1 && reheart.data.hearted === true);

// Copy deck (creates a new deck owned by the user)
const copy = await req('POST', `/decks/${deckId}/copy`, { token });
check('copy deck 201', copy.status === 201 && copy.data.id !== deckId && copy.data.isCommunity === true);

// Updating a community deck should preserve isCommunity
const copyUpdated = await req('PUT', `/decks/${copy.data.id}`, { token, body: { ...deckBody, name: 'Smoke Copy v2' } });
check('update preserves isCommunity', copyUpdated.status === 200 && copyUpdated.data.isCommunity === true);

// Community top
const top = await req('GET', '/community/top?page=1&limit=40', { token });
check('community top returns decks', top.status === 200 && Array.isArray(top.data.decks) && top.data.total >= 1);
check('community top excludes community decks', top.data.decks.every((d) => d.id !== copy.data.id));

// Community search by username
const search = await req('GET', `/community/search?type=username&q=smoketest`, { token });
check('community search by username', search.status === 200 && search.data.length >= 1);
check('community search excludes community decks', search.data.every((d) => d.id !== copy.data.id));

// Community deck detail
const detail = await req('GET', `/community/decks/${deckId}`, { token });
check('community deck detail', detail.status === 200 && detail.data.name === 'Smoke Deck v2');

// Delete deck
const del = await req('DELETE', `/decks/${deckId}`, { token });
check('delete deck 204', del.status === 204);

// Verify deleted
const after = await req('GET', '/decks', { token });
check('deck removed after delete', after.status === 200 && !after.data.some((d) => d.id === deckId));

// ---------------------------------------------------------------------------
// Play section (Phase 9, Step 9.2) — websocket lobby/match flow.
//
// Requires the server to be started with PLAY_IDLE_TIMEOUT_MS=3000 so the
// final idle-sweep step completes in seconds instead of 10 minutes:
//   PLAY_IDLE_TIMEOUT_MS=3000 npm run dev --workspace server   (or full dev)
// A dedicated instance can be targeted via SMOKE_HOST, e.g.:
//   PORT=4100 PLAY_IDLE_TIMEOUT_MS=3000 npx tsx server/src/index.ts
//   SMOKE_HOST=localhost:4100 node smoke-test.mjs
// Node >= 22 provides a global WebSocket.
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class PlayClient {
  constructor(name, token) {
    this.name = name;
    this.token = token;
    this.inbox = [];
  }
  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(`ws://${HOST}/play?token=${encodeURIComponent(this.token)}`);
      this.ws.onmessage = (ev) => {
        try {
          this.inbox.push(JSON.parse(String(ev.data)));
        } catch {
          /* ignore non-JSON */
        }
      };
      this.ws.onopen = () => resolve();
      this.ws.onerror = () => reject(new Error(`${this.name}: websocket error`));
    });
  }
  send(obj) {
    this.ws.send(JSON.stringify(obj));
  }
  async expect(pred, what, timeoutMs = 3000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const idx = this.inbox.findIndex(pred);
      if (idx !== -1) return this.inbox.splice(idx, 1)[0];
      await sleep(100);
    }
    throw new Error(`${this.name}: timed out waiting for ${what} | inbox=${JSON.stringify(this.inbox).slice(0, 300)}`);
  }
  drain() {
    const out = this.inbox;
    this.inbox = [];
    return out;
  }
  close() {
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* already closed */
      }
      this.ws = null;
    }
  }
}

// Two fresh users with their own decks: A has a commander, B does not.
const playAUser = 'smoketest_playa_' + Date.now();
const playBUser = 'smoketest_playb_' + Date.now();
const regA = await req('POST', '/auth/register', { body: { username: playAUser, password: 'password123' } });
const regB = await req('POST', '/auth/register', { body: { username: playBUser, password: 'password123' } });
check('play: register A + B', Boolean(regA.data.token && regB.data.token));
const deckAPayload = {
  name: 'Play Deck A',
  commander: 'Birthing Pod',
  cards: [
    { name: 'Birthing Pod', scryfallOracleId: 'f8b9dd54-0837-47f4-ad14-7a0322d46d5f', count: 1 },
    { name: 'Forest', scryfallOracleId: 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6', count: 5 },
  ],
};
const deckBPayload = {
  name: 'Play Deck B',
  cards: [{ name: 'Forest', scryfallOracleId: 'b34bb2dc-c1af-4d77-b0b3-a0fb342a5fc6', count: 2 }],
};
const deckA = await req('POST', '/decks', { token: regA.data.token, body: deckAPayload });
const deckB = await req('POST', '/decks', { token: regB.data.token, body: deckBPayload });
check('play: create decks for A + B', Boolean(deckA.data.id && deckB.data.id));

const a = new PlayClient('A', regA.data.token);
await a.connect();
const b = new PlayClient('B', regB.data.token);
await b.connect();

// A create_lobby → expect code
a.send({ type: 'create_lobby', deckId: deckA.data.id });
const lj = await a.expect((m) => m.type === 'lobby_joined', 'A lobby_joined');
check('play: create_lobby returns 6-char code', /^[A-Z2-9]{6}$/.test(lj.lobby.code), lj.lobby.code);

// B join_lobby → both get lobby_update
b.send({ type: 'join_lobby', code: lj.lobby.code, deckId: deckB.data.id });
await b.expect((m) => m.type === 'lobby_joined', 'B lobby_joined');
const luA = await a.expect((m) => m.type === 'lobby_update' && m.lobby.players.length === 2, 'A lobby_update (2 players)');
await b.expect((m) => m.type === 'lobby_update' && m.lobby.players.length === 2, 'B lobby_update (2 players)');
check('play: both see 2 players in lobby', luA.lobby.players.length === 2);

// A start_match → both get match_start; 4 zones, empty hands, commander on table
a.drain();
b.drain();
a.send({ type: 'start_match' });
const msA = await a.expect((m) => m.type === 'match_start', 'A match_start');
await b.expect((m) => m.type === 'match_start', 'B match_start');
const pa = (state) => state.players.find((p) => p.username === playAUser);
const pb = (state) => state.players.find((p) => p.username === playBUser);
check(
  'play: match_start has 4 zones + empty hands',
  [pa(msA.state), pb(msA.state)].every(
    (p) => Array.isArray(p.deck) && Array.isArray(p.hand) && Array.isArray(p.table) && Array.isArray(p.graveyard) && p.hand.length === 0,
  ),
);
check('play: commander on table when deck has one (A)', pa(msA.state).table.some((c) => c.name === 'Birthing Pod'));
check('play: no commander → empty table (B)', pb(msA.state).table.length === 0);

// A draw → hand length 1
a.drain();
b.drain();
a.send({ type: 'draw' });
const suDraw = await a.expect((m) => m.type === 'state_update', 'A state_update after draw');
await b.expect((m) => m.type === 'state_update', 'B sees draw');
check('play: draw → hand length 1', pa(suDraw.state).hand.length === 1);
const drawnId = pa(suDraw.state).hand[0].id;

// A move_card hand→table
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawnId, from: 'hand', to: 'table' });
const suMove = await a.expect((m) => m.type === 'state_update', 'A state_update after move');
check('play: move hand→table', pa(suMove.state).table.some((c) => c.id === drawnId));

// A 2nd draw, then hand→graveyard→table — the protocol half of the
// "drag a card out of the graveyard onto the board" flow.
a.drain();
b.drain();
a.send({ type: 'draw' });
const suDraw2 = await a.expect((m) => m.type === 'state_update', 'A state_update after 2nd draw');
await b.expect((m) => m.type === 'state_update', 'B sees 2nd draw'); // consume B's copy before the next op
const drawn2Id = pa(suDraw2.state).hand[0]?.id;
check('play: 2nd draw → hand length 1', Boolean(drawn2Id));
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawn2Id, from: 'hand', to: 'graveyard' });
const suGy = await a.expect((m) => m.type === 'state_update', 'A state_update after hand→graveyard');
await b.expect((m) => m.type === 'state_update', 'B sees hand→graveyard');
check('play: move hand→graveyard', pa(suGy.state).graveyard.some((c) => c.id === drawn2Id));
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawn2Id, from: 'graveyard', to: 'table' });
const suGyOut = await a.expect((m) => m.type === 'state_update', 'A state_update after graveyard→table');
await b.expect((m) => m.type === 'state_update', 'B sees graveyard→table'); // consume B's copy before the next op
check('play: move graveyard→table (drag-out-of-graveyard flow)', pa(suGyOut.state).table.some((c) => c.id === drawn2Id));

// A taps their own table card → both players see tapped:true; untap; B can't tap A's card
a.drain();
b.drain();
a.send({ type: 'tap_card', instanceId: drawn2Id });
const suTap = await a.expect((m) => m.type === 'state_update', 'A state_update after tap');
const suTapB = await b.expect((m) => m.type === 'state_update', 'B sees tap');
check(
  'play: tap_card → tapped=true for A and B',
  pa(suTap.state).table.find((c) => c.id === drawn2Id)?.tapped === true &&
    // state_update carries every player's zones — B's copy must show A's card as tapped
    pa(suTapB.state).table.find((c) => c.id === drawn2Id)?.tapped === true,
);
a.drain();
b.drain();
a.send({ type: 'tap_card', instanceId: drawn2Id });
const suUntap = await a.expect((m) => m.type === 'state_update', 'A state_update after untap');
await b.expect((m) => m.type === 'state_update', 'B sees untap');
check('play: tap again → tapped=false', pa(suUntap.state).table.find((c) => c.id === drawn2Id)?.tapped === false);
a.drain();
b.drain();
b.send({ type: 'tap_card', instanceId: drawn2Id });
const errTapB = await b.expect((m) => m.type === 'error', 'B error on foreign tap');
check("play: B can't tap A's card (error)", /not found/i.test(errTapB.message), errTapB.message);

// Free-form table placement (Phase 10): positions are fractions of the zone,
// server-authoritative, broadcast to every player.
check(
  'play: commander gets default center tablePos at match start',
  pa(msA.state).table.find((c) => c.name === 'Birthing Pod')?.tablePos?.x === 0.5 &&
    pa(msA.state).table.find((c) => c.name === 'Birthing Pod')?.tablePos?.y === 0.5,
);

// A 3rd draw, then move hand→table WITH an explicit drop position
a.drain();
b.drain();
a.send({ type: 'draw' });
const suDraw3 = await a.expect((m) => m.type === 'state_update', 'A state_update after 3rd draw');
await b.expect((m) => m.type === 'state_update', 'B sees 3rd draw'); // consume B's copy before the next op
const drawn3Id = pa(suDraw3.state).hand[0]?.id;
check('play: 3rd draw → hand length 1', Boolean(drawn3Id));
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawn3Id, from: 'hand', to: 'table', x: 0.25, y: 0.75 });
const suPlace1 = await a.expect((m) => m.type === 'state_update', 'A state_update after placed move');
const suPlace1B = await b.expect((m) => m.type === 'state_update', 'B sees placed move');
check(
  'play: move hand→table with pos → tablePos for A and B',
  pa(suPlace1.state).table.find((c) => c.id === drawn3Id)?.tablePos?.x === 0.25 &&
    pa(suPlace1.state).table.find((c) => c.id === drawn3Id)?.tablePos?.y === 0.75 &&
    // state_update carries every player's zones — B's copy must show A's placement
    pa(suPlace1B.state).table.find((c) => c.id === drawn3Id)?.tablePos?.x === 0.25,
);

// place_card repositions a card already on the table (both players see it)
a.drain();
b.drain();
a.send({ type: 'place_card', instanceId: drawn3Id, x: 0.8, y: 0.2 });
const suPlace2 = await a.expect((m) => m.type === 'state_update', 'A state_update after place');
const suPlace2B = await b.expect((m) => m.type === 'state_update', 'B sees place');
check(
  'play: place_card → new position for A and B',
  pa(suPlace2.state).table.find((c) => c.id === drawn3Id)?.tablePos?.x === 0.8 &&
    pa(suPlace2.state).table.find((c) => c.id === drawn3Id)?.tablePos?.y === 0.2 &&
    pa(suPlace2B.state).table.find((c) => c.id === drawn3Id)?.tablePos?.x === 0.8,
);

// Out-of-range input is clamped into [0..1]²
a.drain();
b.drain();
a.send({ type: 'place_card', instanceId: drawn3Id, x: 1.5, y: -0.5 });
const suPlace3 = await a.expect((m) => m.type === 'state_update', 'A state_update after clamped place');
await b.expect((m) => m.type === 'state_update', 'B sees clamped place');
check(
  'play: place_card clamps out-of-range input',
  pa(suPlace3.state).table.find((c) => c.id === drawn3Id)?.tablePos?.x === 1 &&
    pa(suPlace3.state).table.find((c) => c.id === drawn3Id)?.tablePos?.y === 0,
);

// B can't place A's card (ownership + zone check)
a.drain();
b.drain();
b.send({ type: 'place_card', instanceId: drawn3Id, x: 0.5, y: 0.5 });
const errPlaceB = await b.expect((m) => m.type === 'error', 'B error on foreign place');
check("play: B can't place A's card (error)", /not found/i.test(errPlaceB.message), errPlaceB.message);

// Leaving the table clears the stored position
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawn3Id, from: 'table', to: 'hand' });
const suClearPos = await a.expect((m) => m.type === 'state_update', 'A state_update after table→hand');
await b.expect((m) => m.type === 'state_update', 'B sees table→hand');
check('play: leaving the table clears tablePos', pa(suClearPos.state).hand.find((c) => c.id === drawn3Id)?.tablePos === undefined);

// A move_card table→deck, then draw → same instance returns (top-of-deck proof)
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawnId, from: 'table', to: 'deck' });
await a.expect((m) => m.type === 'state_update', 'A state_update after table→deck');
a.drain();
b.drain();
a.send({ type: 'draw' });
const suRedraw = await a.expect((m) => m.type === 'state_update', 'A state_update after redraw');
// draw appends to the end of the hand — A's hand already holds drawn3Id (from
// the placement block), so the top-of-deck card must be the LAST one in hand.
check('play: table→deck then draw returns same instance (top of deck)', pa(suRedraw.state).hand.at(-1)?.id === drawnId);

// deckPosition (Step 10.10): 'bottom' appends — the card is drawn LAST.
// A's state here: deck = [Forest, Forest] (2), hand = [C3, C1], table = [Birthing Pod].
const bpTableId = pa(msA.state).table.find((c) => c.name === 'Birthing Pod')?.id;
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawnId, from: 'hand', to: 'deck', deckPosition: 'bottom' });
const suBottom = await a.expect((m) => m.type === 'state_update', 'A state_update after bottom move');
await b.expect((m) => m.type === 'state_update', 'B sees bottom move');
check(
  'play: deckPosition bottom → appended behind the rest (top unchanged)',
  pa(suBottom.state).deck.length === 3 && pa(suBottom.state).deck.at(-1)?.id === drawnId && pa(suBottom.state).deck[0]?.id !== drawnId,
);
// Draw the two Forests off the top — C1 must still be sitting at the bottom.
a.drain();
b.drain();
a.send({ type: 'draw' });
const suBotDraw1 = await a.expect((m) => m.type === 'state_update', 'A draw after bottom move (top first)');
await b.expect((m) => m.type === 'state_update', 'B sees draw after bottom move');
a.drain();
b.drain();
a.send({ type: 'draw' });
const suBotDraw2 = await a.expect((m) => m.type === 'state_update', 'A draw after bottom move (bottom last)');
await b.expect((m) => m.type === 'state_update', 'B sees 2nd draw after bottom move');
check(
  'play: deckPosition bottom → still in the deck after two top draws, now on top',
  pa(suBotDraw1.state).hand.at(-1)?.id !== drawnId &&
    pa(suBotDraw2.state).hand.at(-1)?.id !== drawnId &&
    pa(suBotDraw2.state).deck.length === 1 &&
    pa(suBotDraw2.state).deck[0]?.id === drawnId,
);

// A numeric depth beyond max (deck now holds 1 card → max 2) → error, card untouched
// (the successful depth-2 move below proves the card was not stranded).
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: bpTableId, from: 'table', to: 'deck', deckPosition: 3 });
const errDepth = await a.expect((m) => m.type === 'error', 'A error on out-of-range depth');
check('play: deckPosition beyond max → "Position must be between 1 and N"', /between 1 and 2/.test(errDepth.message), errDepth.message);

// Depth 2 with a 1-card deck → second from top (behind the existing card).
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: bpTableId, from: 'table', to: 'deck', deckPosition: 2 });
const suDepth = await a.expect((m) => m.type === 'state_update', 'A state_update after depth-2 move');
await b.expect((m) => m.type === 'state_update', 'B sees depth-2 move');
check(
  'play: deckPosition 2 → inserted behind the top card',
  pa(suDepth.state).deck.length === 2 && pa(suDepth.state).deck[0]?.id === drawnId && pa(suDepth.state).deck[1]?.id === bpTableId,
);

// deckPosition on a non-deck destination is ignored (no error, normal move).
a.drain();
b.drain();
a.send({ type: 'move_card', instanceId: drawn3Id, from: 'hand', to: 'table', deckPosition: 'bottom' });
const suIgnored = await a.expect((m) => m.type === 'state_update', 'A state_update after non-deck move with deckPosition');
await b.expect((m) => m.type === 'state_update', 'B sees non-deck move with deckPosition');
check('play: deckPosition ignored when to !== deck (card lands on table)', pa(suIgnored.state).table.some((c) => c.id === drawn3Id));

// --- roll_dice (Step 10.11) -------------------------------------------------
a.drain();
b.drain();
a.send({ type: 'roll_dice', sides: 6 });
const suRollA = await a.expect((m) => m.type === 'state_update', 'A state_update after d6 roll');
const suRollB = await b.expect((m) => m.type === 'state_update', "B sees A's d6 roll");
check(
  'play: roll_dice d6 → value 1..6 on A, broadcast to B',
  pa(suRollA.state).lastRoll?.sides === 6 &&
    Number.isInteger(pa(suRollA.state).lastRoll?.value) &&
    pa(suRollA.state).lastRoll.value >= 1 &&
    pa(suRollA.state).lastRoll.value <= 6 &&
    // B's copy of the state must show A's identical roll (B's own entry stays null — B didn't roll)
    pa(suRollB.state).lastRoll?.value === pa(suRollA.state).lastRoll.value,
);

// Invalid sides → error, no state change (the d6 result is still there)
a.drain();
b.drain();
a.send({ type: 'roll_dice', sides: 5 });
const errDie = await a.expect((m) => m.type === 'error', 'A error on invalid die');
check('play: roll_dice with sides=5 → "Invalid die" error', /Invalid die/.test(errDie.message), errDie.message);

// A's next action (draw) clears their roll — both players see it gone
a.drain();
b.drain();
a.send({ type: 'draw' });
const suRollClear = await a.expect((m) => m.type === 'state_update', 'A state_update after draw');
await b.expect((m) => m.type === 'state_update', "B sees A's draw");
check('play: next action (draw) clears A lastRoll', pa(suRollClear.state).lastRoll === undefined);

// B rolls d20; then A rolls d2 → both rolls coexist in the broadcast state
a.drain();
b.drain();
b.send({ type: 'roll_dice', sides: 20 });
const suRollB2 = await b.expect((m) => m.type === 'state_update', 'B state_update after d20 roll');
check(
  'play: B roll_dice d20 → value 1..20 on B',
  pb(suRollB2.state).lastRoll?.sides === 20 && pb(suRollB2.state).lastRoll.value >= 1 && pb(suRollB2.state).lastRoll.value <= 20,
);
a.drain();
b.drain();
a.send({ type: 'roll_dice', sides: 2 });
const suBoth = await a.expect((m) => m.type === 'state_update', 'A state_update after d2 roll');
check(
  'play: A and B rolls coexist (d2 + d20)',
  pa(suBoth.state).lastRoll?.sides === 2 && pb(suBoth.state).lastRoll?.sides === 20,
);

// B's next action (draw) clears only B's roll; A's remains
a.drain();
b.drain();
b.send({ type: 'draw' });
const suTapClear = await b.expect((m) => m.type === 'state_update', 'B state_update after draw');
check(
  "play: B's draw clears only B lastRoll (A's remains)",
  pb(suTapClear.state).lastRoll === undefined && pa(suTapClear.state).lastRoll?.sides === 2,
);

// B attempts to move A's card → error
a.drain();
b.drain();
b.send({ type: 'move_card', instanceId: drawnId, from: 'hand', to: 'table' });
const errB = await b.expect((m) => m.type === 'error', 'B error on foreign move');
check("play: B can't move A's card (error)", /not found/i.test(errB.message), errB.message);

// B leave_lobby → ghosted; A gets state_update with B connected:false
a.drain();
b.drain();
b.send({ type: 'leave_lobby' });
const suGhost = await a.expect((m) => m.type === 'state_update', 'A state_update after B leaves');
check('play: B ghosted (connected=false in A\'s view)', pb(suGhost.state).connected === false);

// Idle sweep (3 s timeout + 3 s tick): both get session_end { idle_timeout }.
// B's socket stays open on purpose — closeLobby notifies every seat that still
// has a live socket (sendToUser no-ops for dead ones).
let endA;
let endB;
const sweepT0 = Date.now();
while (Date.now() - sweepT0 < 20000) {
  if (!endA) {
    const i = a.inbox.findIndex((m) => m.type === 'session_end');
    if (i !== -1) endA = a.inbox.splice(i, 1)[0];
  }
  if (!endB) {
    const j = b.inbox.findIndex((m) => m.type === 'session_end');
    if (j !== -1) endB = b.inbox.splice(j, 1)[0];
  }
  if (endA && endB) break;
  await sleep(200);
}
check('play: idle sweep → A gets session_end idle_timeout', endA?.reason === 'idle_timeout', endA);
check('play: idle sweep → B gets session_end idle_timeout', endB?.reason === 'idle_timeout', endB);

a.close();
b.close();

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
