const BASE = 'http://localhost:4000/api';

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

// Register a fresh user
const reg = await req('POST', '/auth/register', { body: { username: 'smoketest', password: 'password123' } });
check('register returns token', reg.status === 200 && reg.data.token);
const token = reg.data.token;

// Duplicate register should 409
const dup = await req('POST', '/auth/register', { body: { username: 'smoketest', password: 'password123' } });
check('duplicate register 409', dup.status === 409);

// Login
const login = await req('POST', '/auth/login', { body: { username: 'smoketest', password: 'password123' } });
check('login returns token', login.status === 200 && login.data.token);

// me
const me = await req('GET', '/auth/me', { token });
check('me returns username', me.status === 200 && me.data.username === 'smoketest');

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

// Heart deck
const heart = await req('POST', `/decks/${deckId}/heart`, { token });
check('heart deck 201', heart.status === 201 && heart.data.isCommunity === true);

// Community top
const top = await req('GET', '/community/top?page=1&limit=40', { token });
check('community top returns decks', top.status === 200 && Array.isArray(top.data.decks) && top.data.total >= 1);

// Community search by username
const search = await req('GET', `/community/search?type=username&q=smoketest`, { token });
check('community search by username', search.status === 200 && search.data.length >= 1);

// Community deck detail
const detail = await req('GET', `/community/decks/${deckId}`, { token });
check('community deck detail', detail.status === 200 && detail.data.name === 'Smoke Deck v2');

// Delete deck
const del = await req('DELETE', `/decks/${deckId}`, { token });
check('delete deck 204', del.status === 204);

// Verify deleted
const after = await req('GET', '/decks', { token });
check('deck removed after delete', after.status === 200 && !after.data.some((d) => d.id === deckId));

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
