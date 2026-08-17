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

## Getting started

```bash
npm install
npm run dev
```

Client: http://localhost:5173
Server API: http://localhost:4000

## Scripts

| Script          | Description                             |
|-----------------|-----------------------------------------|
| `npm run dev`   | Run server + client in watch mode       |
| `npm run build` | Build server and client                 |
| `npm start`     | Run the compiled server                 |

## Card images

Card images are served from https://gatherer.wizards.com/Handlers/Image.ashx?type=card&multiverseid=<multiverseId>.