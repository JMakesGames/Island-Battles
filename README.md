# Founders of the Giant Isle

A multiplayer civilization-building strategy game — 4X + RTS + colony survival
with a directly-controllable Leader, AI rivals, diplomacy & trade, technology
& victory conditions, real networked multiplayer, persistent Chronicles, and a
cosmetic-only live-service economy — rendered in procedural pixel art.

**This repo covers Phases 1–9 plus a substantial player-driven expansion**
(playable Leader character, tech tree, victory conditions, pixel-art renderer,
main menu). See [DESIGN.md](DESIGN.md) for the stack rationale, module map,
data schemas, and the full phase-by-phase history — §17 covers everything
beyond the original 9-phase roadmap.

## Quick start (solo, offline)

```bash
npm install
npm run dev   # http://localhost:5190
```

Pick a mode and name your leader on the main menu, then found your **Camp** on
a lit tile near wood, water and food. Click the map (or use WASD) to walk your
leader around and press **E** to rally nearby citizens. Named citizens
auto-gather, haul, and build. Research technology, survive the seasons, meet a
stranger from the sea, and discover the rival civilizations sharing the isle.
Press **1-4** to jump between character/settlement/regional/world zoom.

## Real multiplayer

```bash
npm run server   # ws://localhost:8790 — one shared authoritative match
npm run dev      # in another terminal
```

Open `http://localhost:5190/?server=ws://localhost:8790` in multiple tabs or
machines — each connection claims its own civilization on the same island in
real time. AI plays any civ nobody has claimed yet.

## Legacy Market

Click **🏪 Legacy Market** in-game to browse cosmetic bundles and items by
category, priced in Legacy Tokens (LT). Every item is cosmetic-only — nothing
sold there ever changes a gameplay number (spec §22/§26). There's no real
payment processor in this build, so the "Get Legacy Tokens" section is a
clearly-labelled **sandbox** stand-in for a real purchase; see
[DESIGN.md §13](DESIGN.md) for what a production integration would need.

## Cosmetics & Chronicles

Owned items can be **equipped** (Equip/Unequip toggle in the Market) — a
crown or mount renders live on your leader, visible to every other player who
can see your civilization. Your Legacy Token balance, owned items, and equip
choices persist across sessions (no login needed — just the same browser or
`?server=` connection), and the Chronicle panel keeps a record of past
civilizations you've played: days survived, peak population, wars, alliances.

## Share it with a friend

```bash
npm run build:standalone
```
Produces `founders-of-the-giant-isle.html` — one file, ~87 KB, nothing else
needed. Send it to anyone and they can double-click it open and play the full
solo game (AI rivals, diplomacy, the Legacy Market, research, everything)
right in their browser. Real multiplayer still needs a hosted `npm run server`
someone can connect to — this file just doesn't include one.

## Scripts

- `npm run dev` — Vite dev server with HMR
- `npm run server` — headless multiplayer server (Node + WebSocket)
- `npm run build:standalone` — single shareable HTML file (solo play)
- `npm run typecheck` — strict TypeScript, no emit (covers client, server, data)
- `npm run build` — typecheck + static production client bundle

## Design principles baked into the code

- **Data-driven**: all balance and economy live in `/data/*.json`; nothing is
  hard-coded (spec §34).
- **Cosmetic-only monetization**: `data/economy` items are `cosmeticOnly` and
  never touch gameplay numbers in `data/game` (no pay-to-win, spec §22/§26).
- **Server-authoritative**: the client (`game/Game.ts`) never mutates state —
  it sends serializable `Command`s through a `Transport` to an authoritative
  `Simulation`, and renders read-only `Snapshot`s back (spec §35, §36).
- **One client, two transports**: the exact same client code drives a solo
  in-tab match (`LocalTransport`) or a real WebSocket match
  (`NetworkTransport`) — swapping transports required zero client logic
  changes, proving the client/server boundary is real.
