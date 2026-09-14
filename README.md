# MTG Deck Builder

A Magic: The Gathering deck editor.

- **Frontend:** React + TypeScript (Vite)
- **Backend:** Node.js + Express + TypeScript

## Features

- Full card search against `AtomicCards.json` (min 3 characters, 300ms debounce, top 50 closest results)
- User registration & login (JWT auth, scrypt-hashed passwords)
- Save decks to your account (explicit Save button — no auto-save)
- Text view: hovering a card row shows the card image
- Image view: the whole deck rendered as card images
- Plus button to add cards, minus button to remove them, running card total
- Play tab: mock matches (fully local game logic) or multiplayer via 6-character lobby codes — up to 4 players, drag & drop between hand/table/deck/graveyard, free-form table placement with tap/untap, card counters on your table cards (right-click → Counters...), player-made tokens (+ button left of your deck; destroyed if dragged off the table), editable life totals (own pill is a textbox, opponents see a number), graveyard lists, lobbies close after 10 minutes of inactivity

## Getting started

```bash
npm install
npm run pull-card-info
npm run dev
```

Client: http://localhost:5173
Server API: http://localhost:4000
Play websocket: `ws://localhost:4000/play` (JWT passed as the `token` query param)

## Scripts

| Script          | Description                             |
|-----------------|-----------------------------------------|
| `npm run dev`   | Run server + client in watch mode       |
| `npm run build` | Build server and client                 |
| `npm start`     | Run the compiled server                 |
| `npm run prod`  | Build, then run the production server on one port (UI + API + websocket). Generates a random JWT secret on first run (saved to `server/data/.jwt-secret`, reused afterwards so logins survive restarts). Optional: `npm run prod -- -Port 5000` |
| `npm run pull-card-info` | Download latest AtomicCards.json from MTGJSON |
| `node smoke-test.mjs` | REST + play-websocket smoke test (the play section needs a server started with `PLAY_IDLE_TIMEOUT_MS=3000`; see the comment in the file) |

## Card images

Card images are served from https://gatherer.wizards.com/Handlers/Image.ashx?type=card&multiverseid=<multiverseId>.