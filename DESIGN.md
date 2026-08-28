# Founders of the Giant Isle — Engineering Design & Roadmap

This is the technical companion to the master game spec. It records the stack
choice, the module architecture, the data schemas, and the phase roadmap that
carries a single-player slice toward a live-service multiplayer game **without
rewrites** (spec §30, §34, §36).

Scope of the current repo: **Phases 1–5** — a playable civilization slice with
real AI opponents, diplomacy & trade, and real networked multiplayer — plus the
architecture and economy data model for every later phase.

---

## 1. Tech stack & why

| Layer | Choice | Rationale |
|---|---|---|
| Language | **TypeScript (strict)** | One typed language client→(future)server; serializable domain types become the network contract. |
| Rendering | **HTML5 Canvas 2D** | Zero-dependency, fast to iterate, runs anywhere a browser does. No engine lock-in; a WebGL/Pixi swap later touches only `render/`. |
| Build/dev | **Vite** | Instant HMR, trivial static build. Runtime is dependency-free, so the shipped bundle is portable. |
| Data | **JSON in `/data`** | Single source of truth for balance + economy (spec §21, §34). Code reads it; nothing is hard-coded. |
| Sim clock | **Fixed-timestep accumulator on a timer** | Deterministic ticks, decoupled from the render/rAF cadence — the exact seam a server-authoritative tick replaces in Phase 5. |

**Why not a game engine (Unity/Godot/Phaser) yet?** The spec's hard requirement
is a *networkable, data-driven, live-service* architecture. A thin TS core keeps
the domain model pure and serializable, which is what multiplayer and anti-cheat
(spec §35) actually depend on. Rendering is deliberately the *replaceable* layer.

---

## 2. Module architecture

Every subsystem the spec calls out (§34) is its own module. Systems never call
each other directly — they read/write `GameState` and communicate through the
typed `EventBus`. That decoupling is what lets AI, diplomacy, trade and the
network layer bolt on later.

```
src/
  core/         Engine primitives, no game rules
    types.ts        Serializable domain types (the future network contract)
    events.ts       Typed EventBus (systems stay decoupled; net layer taps here)
    rng.ts          Seeded deterministic RNG (reproducible maps + replays)
  world/
    World.ts        Seeded island gen, biomes, resource nodes, fog, hidden rival
  entities/
    names.ts        Named citizens (spec §6 attachment)
  systems/          Pure functions over (state, bus)
    CitizenSystem.ts    Job AI: gather → haul → build, movement, fog reveal
    SurvivalSystem.ts   Daily production/consumption, seasons, morale, growth
    BuildingSystem.ts   Data-driven placement validation + construction start
    EventSystem.ts      Narrative events with consequential, logged choices
    stubs.ts            AI / Diplomacy / Trade / Tech / Combat seams (Phase 2+)
  render/           View only — holds no game truth
    Camera.ts, Renderer.ts
  ui/
    Hud.ts          DOM overlay (reused later by store/Chronicle/menus)
  game/
    GameState.ts    The full serializable match state (save/load + net snapshot)
    config.ts       Loads all /data JSON; getters; NO inline balance/prices
    Game.ts         Orchestrator: owns state, sequences the core loop, input
  main.ts           Boot one local match

data/
  economy/   legacy-tokens.json · items.json · bundles.json · battlepass.json
  game/      resources.json · buildings.json · biomes.json · events.json
```

### Core loop sequencing (spec §3)
`Game.tick()` is the single place the loop is ordered:
`updateCitizens` → (event triggers) → `advanceDay` (on day boundary). Rendering
and HUD update happen once per timer wake, after simulation. Replacing the local
stepping with received server ticks is a one-file change in `Game`.

---

## 3. Data schemas (source of truth)

All balance and monetization live in JSON so designers/live-ops change them
without code edits (spec §34). Shapes are documented inline via each file's
`$schema` field. Highlights:

- **`resources.json`** — `{id, tier, icon, color, carriable, consumedPerCitizenPerDay?}`.
- **`buildings.json`** — `{id, era, cost:{res:amt}, buildTicks, provides:{...}}`.
  `provides` is a generic effect bag (`housing`, `storage`, `foodPerDay`,
  `waterPerDay`, `isTownCenter`…) read by systems — no per-building code.
- **`biomes.json`** — biomes (`walkSpeed`, `buildable`) + node spawn table.
- **`events.json`** — `{title, body, trigger, choices:[{label, effects, log}]}`.
  `effects` is a flat data bag (resource deltas, `morale`, `reputation`,
  `revealRival`, `spawnCitizens`) so events are pure content.
- **`legacy-tokens.json`** — LT packages `{id, lt, usd, bonusLt}` (spec §18–19).
- **`items.json`** — Legacy Market catalog; **every item `cosmeticOnly: true`**
  (enforced intent from spec §22, §26 — cosmetics sell identity, never power).
- **`bundles.json`** — bundles reference item ids (spec §24).
- **`battlepass.json`** — dual free/premium track, `premiumPriceLt`, levels.

---

## 4. Cosmetic / no-pay-to-win invariant (spec §22, §26)

Encoded structurally, not just by policy:
- Gameplay-affecting numbers live **only** in `data/game/*`.
- Monetizable content lives **only** in `data/economy/*` and is `cosmeticOnly`.
- The two never cross-reference. A cosmetic can change a sprite/skin id; it can
  never appear in a `cost`, `provides`, or combat/production calculation.
- Real-money grants (spec §35) will be **server-authoritative**; the client will
  never mint LT. `Economy` is loaded for display only in this slice.

---

## 5. Phase roadmap (maps to spec §36)

| Phase | Deliverable | Where it lands | Status |
|---|---|---|---|
| **1** | Single-player civ slice | this repo | **✅ done** |
| **2** | AI civilizations | `systems/AISystem.ts::updateAI`; multi-`Civ` state; shared contested world | **✅ done** |
| **3** | Diplomacy & trade | `systems/Diplomacy.ts`; `game/Relations.ts`; opinion+reputation-driven | **✅ done** |
| **4** | Multiplayer architecture | `net/`: Command protocol, authoritative `Simulation`, `Transport` (+`LocalTransport`); `Game` is now a client | **✅ done** |
| **5** | Real multiplayer | `server/index.ts` (Node/WebSocket) + `net/NetworkTransport.ts` + `net/serialize.ts`; multiple humans share one match | **✅ done** |
| **6** | Legacy Market | `ui/Hud.ts` market panel over `data/economy/items.json`/`bundles.json` | **✅ done** |
| **7** | Legacy Token economy | `systems/Economy.ts`; server-authoritative `Wallet`; sandbox purchase seam | **✅ done** |
| **8** | Cosmetics | `wallet.equipped`; `equipCosmetic` command; `Renderer` draws crown/mount/building-skin | **✅ done** |
| **9** | Chronicles | `core/profile.ts`; localStorage (solo) / `server/profileStore.ts` (multiplayer) | **✅ done** |
| 10 | Battle Pass | Season progression over `data/economy/battlepass.json` | data ready |
| 11 | Live events | New `events.json` + seasonal content; no code change | data-driven |

---

## 6. What Phase 1 actually implements

The first-10-minutes loop from spec §2/§33, verified end-to-end in-browser:

1. Seeded island with biomes, fog of war, resource nodes, a **hidden rival**.
2. Choose a landing site and **found a Camp** (town center).
3. Named citizens auto **gather → haul → build**; construction is visible and
   raises housing/storage caps.
4. **Survival**: daily food/water consumption, seasons that cut farm yield,
   morale, telegraphed hunger/winter warnings, population growth when fed+housed.
5. A **narrative event** ("A Sailor from the Sea") with consequential choices
   that move resources, **reputation**, and can reveal the rival.
6. Every beat is written to the **Chronicle** (spec §15).

### Known limitations (intentional)
- Pathfinding is straight-line (no obstacle avoidance) — fine at this scale.
- Combat/tech/diplomacy are stubs (Phase 3+).
- No persistence yet — `GameState` is shaped for save/load but not wired.
- Single hard-coded event trigger for the opener; the trigger system generalizes
  alongside more events.

## 8. Phase 2 — AI civilizations (added)

The single hidden rival marker became **real simulated civilizations** sharing
the isle (spec §4). The refactor that made this clean:

- **`Civ`** (`game/Civ.ts`) owns all per-civilization state + methods
  (stock, citizens, buildings, home, morale, reputation, `add/has/spend/spawn`).
- **`GameState`** now holds `civs: Civ[]` + `playerIndex` and the *shared* world,
  clock, seasons, and Chronicle. `state.player` / `state.aiCivs` are getters.
- Every system took a `Civ` parameter — the same `CitizenSystem`,
  `BuildingSystem`, and `SurvivalSystem` run for player and AI alike. Zero
  gameplay logic was duplicated for the AI.
- **Shared, contested resource nodes**: a node claimed by *any* civ's gatherer is
  skipped by everyone else, so civs compete for the isle (spec §7).
- **`AISystem.updateAI`** is a small utility planner run once per day: it reads
  the same `GameState` and picks the next building by priority
  (water → food → housing → storage), places it near home, and lets the shared
  citizen AI construct it. Swappable for a stronger planner without touching
  other systems.
- **Per-player fog**: only the player's citizens lift the player's fog; AI
  settlements render (in their civ colour, with a ⚑) only once discovered. The
  "Take the map" event reveals the *nearest* undiscovered rival.

Verified in-browser: 3 civs seed on spread-out shores; AI civs (Thornhold,
Saltmere) autonomously gather, build camps→wells→farms→houses, grow population,
and are discovered by exploration or the map event.

## 9. Phase 3 — Diplomacy & trade (added)

Now that rivals exist and per-civ reputation is tracked, civilizations relate to
one another (spec §12):

- **`game/Relations.ts`** holds two matrices sized to the civ count: a symmetric
  **stance** (`neutral | pact | alliance | war`) and an asymmetric **opinion**
  (how much A likes B). Plain data → serializable for save/load + network sync.
- **`systems/Diplomacy.ts`** implements player-initiated actions (alliance, pact,
  declare war, make peace, gift, trade). The target civ decides synchronously
  from its **opinion of the actor + the actor's public reputation** — so a
  `generous` history helps deals, a `warmonger`/`unreliable` one hurts. Outcomes
  adjust opinion, may shift the actor's reputation, and log to the Chronicle.
- **Emergent betrayal**: declaring war while allied/pacted adds `unreliable`
  reputation *and* lowers the aggressor's standing with every other civ — third
  parties remember (verified: a treaty-break dropped the uninvolved civ's opinion).
- **Trade**: `proposeTrade` exchanges resources if the deal is survivable and
  roughly fair to the target; gifts convert surplus into goodwill.
- **AI diplomacy brain** (`updateDiplomacy`, daily): opinion drifts by stance,
  and discovered AI civs proactively send the player **Proposals** (pact →
  alliance escalation, or suing for peace) surfaced as modals. A modal-busy
  guard queues offers behind events and each other.
- **UI**: a Diplomacy panel lists discovered rivals with a stance badge, an
  opinion bar, and stance-appropriate action buttons.

Verified in-browser end-to-end: gifts raised goodwill and `generous` reputation;
reputation bias pushed a borderline pact to acceptance; alliance formed; a trade
executed (+15 food for surplus); declaring war broke the alliance and turned a
third civ against the player; peace restored; and both AI civs sent their own
pact/alliance proposals which resolved through queued modals.

## 10. Phase 4 — Multiplayer architecture (added)

The client and the authoritative world are now separated by a transport seam
(spec §35 server-authority, §36 Phase 4). No wire yet — this is the structure
Phase 5 plugs a socket into.

- **`net/protocol.ts`** — the client⇄server contract as plain, serializable data:
  a **`Command`** union (foundCamp, placeBuilding, resolveEvent, diploAction,
  resolveProposal; each tagged with the acting `civ`), `ServerEvent` (= the
  existing signal bus), and `Snapshot`.
- **`net/Simulation.ts`** — the **server**: owns the one true `GameState`, is the
  *only* code that mutates it, runs the fixed tick (drain commands → apply →
  citizen/survival/AI/diplomacy systems), and emits decisions (`eventTriggered`,
  `proposalReceived`) rather than resolving them itself. No DOM/timer deps, so it
  can run headless in Node in Phase 5 unchanged. **AI civs are server-side logic,
  not clients** — only humans send commands.
- **`net/Transport.ts`** — the interface the client codes against, plus
  **`LocalTransport`** which runs the Simulation in-process and drives its clock
  on a wall-clock timer. Phase 5's `NetworkTransport` implements the same
  interface over a WebSocket; the client won't change.
- **`game/Game.ts` is now a thin client**: input → `Command`s sent through the
  transport; a render timer draws read-only snapshots; decision modals are driven
  off server events and their answers go back as commands. It holds no
  authoritative state and mutates nothing.

Why it matters (verified in-browser): clicking to found a camp left state
**unchanged until the next server tick** — proof the client can't mutate, only
request. Every path — founding, building, the opener event, and a diplomacy gift
— was exercised through the `Command → Simulation → Snapshot` loop, with AI and
diplomacy still running server-side.

### Anti-cheat posture (spec §35)
Because the server re-validates every command (placement legality, affordability,
diplomacy standing) and computes trade/gift amounts itself from authoritative
state, a client cannot grant itself resources, place illegal buildings, or force
a deal — it can only submit intents the server may reject.

## 11. Phase 5 — Real multiplayer (added)

`net/Simulation.ts` had no DOM/timer dependency by design (Phase 4), so it now
runs unmodified as a headless Node process. Three new pieces close the loop
(spec §36 Phase 5):

- **`server/index.ts`** — a small Node/WebSocket process. It owns exactly one
  `Simulation` (one match/"room"), runs the same 60Hz tick loop `LocalTransport`
  ran in-tab, and broadcasts snapshots to every connection at a throttled 10Hz
  (ticking stays fast for simulation fidelity; clients don't need world pushes
  that fast). Every inbound command is checked against the sending connection's
  *own* assigned civId before being enqueued — a client can only ever act as the
  civ the server gave it (spec §35).
- **Dynamic civ claiming** — `Simulation` gained `claimCiv`/`releaseCiv` and a
  `soloHuman` constructor option. In networked mode every civ starts
  AI-controlled and auto-founded; connecting browsers claim the next open
  AI-controlled slot (flip `isAI` false), and a disconnect hands the civ back to
  the AI brain rather than freezing it. `LocalTransport` still seats civ 0 as a
  built-in human immediately (`soloHuman: true`, the old single-player path,
  unchanged and regression-tested).
- **`net/NetworkTransport.ts` + `net/serialize.ts`** — the real client. It
  speaks the same `Command`/`ServerEvent`/`Snapshot` shapes as `LocalTransport`
  over a WebSocket, so `game/Game.ts` needed *zero* logic changes — only a
  constructor branch picks which `Transport` to use. `serialize.ts` solves the
  one real wire problem: `JSON.parse` returns plain objects, not `Civ`/`World`/
  `Relations`/`GameState` instances, so `civ.storageCap`, `world.tileAt(...)`,
  `relations.stance(...)` would all be missing. Rehydration re-attaches each
  class's prototype via `Object.create` + `Object.assign` **without re-running
  its constructor** — re-running `World`'s constructor, for instance, would
  regenerate a different island instead of restoring the real one.
- **Generalizing "the player" → "each human civ"** — the opener event and AI
  diplomacy proposals were hardcoded to a single `state.player`. Both now loop
  over every currently-human civ (`!civ.isAI`), each tracked independently
  (per-civ opener-event timers, `Proposal.toCiv`), so multiple humans on one
  island each get their own story beats and their own AI suitors.

### Verified in-browser: two independent tabs, one authoritative match
Ran `npm run server` and opened two separate browser tabs at
`?server=ws://localhost:8790`. Confirmed: each tab was assigned a **different**
civ (Thornhold / Saltmere) and each got its **own** independent opener event; a
building placed from one tab appeared in the *other* tab's raw snapshot within
one broadcast tick; a gift sent from one tab's civ updated opinion/reputation
and Chronicle entries visible from the other tab — all while the server rejected
a client-side attempt to fabricate resources (the command was validated against
the server's own stock, not the tampered client copy). A third tab with no
`?server=` param still ran the original solo `LocalTransport` path unaffected.

### Known Phase 5 simplifications (intentional, documented)
- **One room per server process.** No lobby/matchmaking (spec §29) yet — every
  connection joins the same match. Multi-room would be a `Map<roomId, Simulation>`
  in `server/index.ts`; the protocol doesn't need to change.
- **Shared fog of war.** `World.tiles[].explored` is one flag per tile, not
  per-civ — any human's exploration is visible to all humans. A true per-civ
  visibility matrix is a fast-follow, not required for this slice.
- **Ambient toasts broadcast to everyone.** Only the two decision-critical
  signals (`eventTriggered`, `proposalReceived`) carry a target civ and are
  filtered client-side; flavor toasts (citizen recruited, building complete)
  reach every connection regardless of whose civ they're about.
- **No human-vs-human diplomacy UI.** The Diplomacy panel only lists AI civs
  (`state.aiCivs`); the underlying `Diplomacy.ts` functions already accept any
  two civs, so wiring a human-to-human panel is additive, not a rewrite.

## 13. Phase 6+7 — Legacy Market & Legacy Token economy (added)

Built together since a storefront is inert without a wallet to spend from.
Server-authoritative end to end (spec §17-26, §35).

- **`Wallet`** (`core/types.ts`) — `{ lt, inventory: string[], processedRequests:
  string[] }` on every `Civ`. Deliberately plain **arrays**, not `Set`s: a `Set`
  serializes to `{}` over JSON and would silently vanish across the Phase 5
  network boundary (the same lesson `Relations`' matrices already taught).
- **`systems/Economy.ts`** — three server-only functions, all idempotent via a
  client-generated `requestId` (spec §35: "prevent double spending... replay
  attacks"):
  - `purchaseItem` / `purchaseBundle` — check ownership + balance, deduct LT,
    grant inventory entries, entirely against the *server's* `civ.wallet` —
    never a client-supplied number.
  - `grantLt` — a **sandbox stand-in for a real-money purchase**. This build
    has no payment processor wired up (no App Store/Play/Stripe integration),
    so there is nothing to actually validate a receipt against. `grantLt`
    computes the LT amount from the server's own `legacy-tokens.json` catalog
    by package id only — a client can request package `"kingdom"` but can
    never say "give me 999999 LT." The file header states in block caps that
    this must be replaced by real platform receipt validation before any real
    money could ever be accepted (spec §35).
- **Commands** (`net/protocol.ts`): `purchaseItem`, `purchaseBundle`,
  `mockGrantLt` — each carries the client-generated `requestId`. `Simulation`
  routes them to `Economy.ts` exactly like every other command, through the
  same validated, server-owned path (spec §34 no new architectural seam needed).
- **UI** (`ui/Hud.ts`): a "🏪 Legacy Market" panel (bundles first per spec §24,
  then items grouped by category, each showing rarity, price, and an owned/
  affordable state) plus a clearly-labelled **"sandbox — no real purchase"**
  section for granting LT, so nobody could mistake it for real IAP.
- **Cosmetic invariant holds structurally, not just by convention**: `Wallet`
  lives on `Civ` right next to `stock`/`buildings`, but no system anywhere
  reads `wallet.inventory` for a cost, a `provides`, or any production/combat
  calculation — the same non-cross-reference rule from §4 (no-pay-to-win) now
  has a second, independent implementation proving it out.

### Verified in-browser (solo mode)
Attempted a 1000 LT purchase at 0 LT → correctly rejected, gameplay stock
(wood/stone/fiber) completely untouched. Granted a Kingdom package via the
sandbox flow → **exactly** 2800 + 780 bonus = 3580 LT (server-catalog amount,
not a client number). Bought the Golden Crown → balance dropped by exactly
1000, item shows "Owned." **Replayed the identical purchase command 3 times**
→ balance never moved again, inventory never duplicated, and only genuinely
new request ids were tracked (a request that failed for insufficient funds was
correctly *not* recorded, so a legitimate retry after funding still succeeds).
Bought the Explorer Bundle → all bundle contents unlocked in one transaction;
repeating the purchase was blocked by the "already owned" check without a
second charge. Throughout, `housing`/`storageCap`/`morale`/resource stock kept
evolving normally from ordinary gameplay, untouched by any purchase.

### Known Phase 6-7 simplifications (intentional, documented)
- **No real payment processor.** `grantLt` is sandbox-only, loudly labelled in
  both code and UI; production would swap it for platform receipt validation
  behind the *same* `Wallet`/`Economy.ts` interface.
- **Match-scoped wallet.** Like reputation, `Wallet` lives and dies with the
  `Civ` — there's no account/auth/persistence layer yet (that's Phase 9
  Chronicles' job). A real launch needs LT/inventory tied to a persistent
  player account, not a single match's `Civ` instance.
- **Cosmetics aren't visually applied yet.** Owning `mount_brown_horse` doesn't
  yet change any sprite — that's Phase 8 ("skin ids on entities; render layer
  resolves them"), deliberately kept separate so this phase could focus on the
  economy mechanics being correct and safe.

## 15. Phase 8+9 — Cosmetics & Chronicles (added)

Built together: applying cosmetics visually needed somewhere to remember what
you've equipped, and persistence needed something worth remembering.

### Phase 8 — Cosmetics
- **`Wallet.equipped: Record<string, string>`** — one equipped item per
  `MarketItemDef.category` (e.g. `CROWNS -> "crown_golden"`). Toggling is a new
  `equipCosmetic` command, validated server-side against ownership
  (`systems/Economy.ts::equipCosmetic`) — not idempotency-tracked like a
  purchase, since equip/unequip is a reversible toggle, not money changing hands.
- **`items.json` gained an optional `icon` field** — a render hint, following
  the same pattern `buildings.json`/`resources.json` already use, instead of
  hardcoding glyphs in the renderer.
- **`Renderer`** draws equipped cosmetics only for entity types that actually
  exist in gameplay today: a crown/mount glyph over a leader citizen, and an
  equipped `BUILDINGS` skin (e.g. "Dragon Capital" 🐉) replacing the default
  town-center glyph. Visible to *every* civ that can see the tile — not just
  the owner (spec §23) — using the same fog rules buildings/citizens already
  follow. Categories without a renderable entity yet (PETS, MONUMENTS, BANNERS,
  EMOTES, VICTORY_ANIMATIONS, ...) stay inventory/equip-only for now.

### Phase 9 — Chronicles (persistence)
No account/auth system exists, so "identity" is an opaque id the client holds:
`localStorage` for solo play, sent to the server as a query param for
multiplayer. Same id back later → same wallet and history restored.

- **`core/profile.ts`** — pure, isomorphic logic (no fs/localStorage) shared by
  both sides of the Phase 5 network boundary: `PlayerProfile { wallet,
  history }`, `ChronicleRecord` (civ name, days survived, peak population,
  wars declared, alliances formed, when it ended), `buildChronicleRecord`,
  `restoreWallet`/`captureWallet`.
- **Four new stats on `Civ`** feed the record: `foundedDay` (set in
  `BuildingSystem.place` when the town center goes up), `peakPopulation`
  (updated daily in `SurvivalSystem`), `warsDeclared`/`alliancesFormed`
  (incremented in `Diplomacy.ts` at the exact call sites that cause them).
- **No database** — `server/profileStore.ts` is a single debounced JSON file
  (`server/data/players.json`), matching this project's "no unnecessary
  complexity" pattern (same reasoning as the Phase 7 sandbox LT grant).
  `net/profileStore.client.ts` mirrors it with `localStorage` for
  `LocalTransport`, so both paths behave identically from the UI's perspective.
- **When a record is written**: there's no victory-condition system yet, so a
  chronicle entry is an honest session summary, written when human control of
  a civ ends — a server disconnect, or the solo tab's `beforeunload`. The
  server also autosaves the wallet every 10s per connected player so a hard
  crash loses at most that much progress (accepted, documented trade-off).
- **UI**: the existing in-match Chronicle panel gained a live "N days survived
  · peak pop · wars · alliances" line for the current run, plus a "🏛 Past
  Civilizations" section listing prior `ChronicleRecord`s — no new floating
  panel needed. The Legacy Market's owned items show an Equip/Unequip toggle
  instead of a static "Owned" pill.

### Verified in-browser
**Solo**: bought and equipped a Golden Crown — the 👑 glyph rendered live over
the leader. Reloaded the page: wallet (LT + inventory + equipped state) came
back exactly as left, *and* the previous session was automatically finalized
into "Past Civilizations" (5 days survived, peak population 3) via
`beforeunload`. **Multiplayer**: connected to a real server, granted LT,
bought and equipped the same crown, inspected `server/data/players.json`
directly (wallet + a chronicle record for "Thornhold," 2 days survived) after
closing the tab, then reconnected from a fresh tab and confirmed the exact
same wallet, equipped cosmetic, and history came back from the server.

---

## 17. Player-driven expansion: playable Leader, tech, victory, pixel art, main menu (added)

Prompted by direct player feedback after Phase 9. Four substantial additions,
all wired through the existing architecture (new `Command`s, new systems, no
structural changes):

- **A physical, player-controlled Leader (spec §5).** The leader is no longer
  swept into the auto-worker pool for a human civ — `CitizenSystem` skips them
  entirely and instead moves them only where the player sends them
  (`setLeaderTarget`, click-to-move or WASD/arrows, throttled client-side to
  ~10 commands/sec). `leaderInteract` (E / Space, or the Rally button) boosts
  nearby citizens' morale/loyalty within a server-checked radius and cooldown
  (`systems/LeaderSystem.ts`). The leader gains XP (passively, from events,
  from rallying) and levels up into random `LeaderTraits` (explorer/scholar/
  orator/diplomat/warlord) that feed back into reveal radius, knowledge income,
  and rally strength. AI civs' leaders are unaffected — they still behave as
  autonomous citizens, since nobody is there to drive them.
- **Technology & victory (spec §10, §16).** `data/game/tech.json` defines a
  5-era tree (survival → settlement → iron → kingdom → legacy); `startResearch`
  spends banked Knowledge to instantly complete a tech (era techs advance
  `civ.era`, which now gates `BuildingSystem.canPlace`; bonus techs like
  Agriculture/Engineering apply real multipliers read via `techBonus()`). AI
  civs research too (`updateAIResearch`, era-first). `VictorySystem` checks
  four conditions daily — prosperity, knowledge (full tech tree), diplomatic
  (allied with every other civ), legacy (complete the Grand Monument) — and
  fires a `victory` signal without stopping the match. **Conquest victory is
  not implemented**, honestly: there's still no combat system, so "capture all
  capitals" has no mechanism to execute.
- **Procedural pixel-art rendering (`render/SpriteAtlas.ts`).** No image
  pipeline exists in this build — no PNGs to import — so every sprite (terrain,
  resource nodes, citizens, the leader, buildings, discoverable sites) is drawn
  once onto a small offscreen canvas at a fixed logical-pixel grid and cached;
  the renderer blits it scaled up with `imageSmoothingEnabled = false`. That
  combination is what actually produces a crisp "pixel art" look without hand-
  authored assets. Buildings/citizens are anchored at their tile's base and
  drawn taller than their footprint with a drop shadow — a lightweight 2.5D
  depth illusion, **not** true isometric projection (that would need reworking
  the tile-coordinate math and was out of scope for this pass). `Camera` gained
  named zoom tiers (character/settlement/regional/world, keys 1-4) that ease in
  via `tick()` rather than snapping, plus `follow()` so the camera can track the
  leader while walking.
- **A real main menu (`ui/MainMenu.ts`).** Title, solo-vs-multiplayer mode
  select (multiplayer reveals a server-address field, pre-filled from
  `?server=` if present), leader name entry, a banner-color picker for solo
  play (deliberately excluding the AI rivals' assigned colors so a human civ
  is never visually indistinguishable from an AI one), and a live view of
  "Your Past Civilizations" pulled from the same persistent profile Phase 9
  built. Customization threads through `Simulation`'s `leaderName`/`civColor`
  options for solo, and a `leaderName` query param the server reads at claim
  time for multiplayer (`Simulation.claimCiv` renames the already-spawned
  leader in networked mode, since every civ is pre-founded there).

### Verified in-browser
Solo: founded a camp as a custom-named, custom-colored leader ("Queen Nyra",
blue); clicked across the map and confirmed the leader walked there
server-side; hovered a citizen and got a live inspect tooltip (name, job,
health/morale/loyalty, skill/xp, trait); force-granted Knowledge and completed
the Settlement-era research, confirming `civ.era` advanced and cost was
deducted correctly. Multiplayer: the `?server=` link pre-selected multiplayer
mode with the address filled in, and connecting placed a leader ("Zeph the
Bold", auto-named) into a networked match already mid-flight with all of the
above systems active identically to solo.

### Honest scope boundaries (this pass)
The spec's full 40 sections were not all built to commercial polish in one
pass — that's genuinely multi-session work. Specifically still open: combat
and the conquest victory it would enable; several building types from spec §9
(gates, harbors, capitals, castles as distinct entities — the data model
supports adding them, no code changes needed); jungle/swamp are generated
biomes but don't yet have unique gameplay hooks beyond walk-speed/buildability;
true isometric "2.5D" (current depth cue is shadows + tall sprites, not
projected tiles); no audio engine (spec §37 lists "sound" as a quality
standard); Battle Pass and live seasonal events (Phases 10-11, still just data
schemas). None of these require restructuring what exists — they're additive,
same as every phase before it.

---

## 18. Bug fixes + Phase 10-11 (added)

Three player-reported issues fixed, plus the last two roadmap phases.

**Fixes:**
- **Citizens couldn't be given jobs.** There was no manual override — citizens
  were entirely auto-assigned. Added `commandCitizen` (spec §6):
  click a non-leader citizen to select them (a green ring marks the
  selection), then click a resource node to send them gathering it, an
  unfinished building to send them building it, or anywhere else to release
  them back to the auto-worker AI. `systems/CitizenSystem.ts::commandCitizen`
  validates server-side; `Renderer` draws the selection ring.
- **Camera lagged behind the moving leader.** `cam.follow()` was only called
  inside the throttled WASD pump (~every 100ms, weak lerp) and never during
  click-to-move at all. Now `Game.render()` calls it every frame, at a
  stronger lerp, whenever the leader has an active walk target — for both
  input methods.
- **WASD felt like it teleported ~3 tiles per tap.** The lookahead target was
  3 tiles ahead of the leader, re-sent every 100ms, but releasing the key
  never told the server to stop — the leader kept walking to the last
  lookahead point. Fixed two ways: the lookahead is now ~1 tile (finer-grained
  control), and releasing the last held movement key immediately sends
  `setLeaderTarget` with `target: null`, which halts the leader in place.
- **Diplomacy buttons "didn't work."** Direct testing (both cheat-assisted and
  the fully natural opener-event → discover → click flow) found the buttons
  functioning correctly. The real defect: the whole Diplomacy button was
  `display:none` until a rival was discovered — before that point there was
  nothing to click at all, which reads as "broken." The button is now always
  visible, with a helpful empty state ("No rivals discovered yet. Explore...")
  instead of disappearing entirely.

**Phase 10 — Battle Pass (spec §25):** `Civ` gained `battlePassXp/Level/
Premium/Claimed`. `systems/BattlePass.ts` — XP earned from real play (10/day
survived, 20/building completed, 15/research completed, plus seasonal event
choices), levels computed same style as leader leveling, `purchasePremiumPass`
(sandbox, same posture as `grantLt`) and `claimBattlePassReward` (validates
level reached, premium ownership, not already claimed). `data/economy/
battlepass.json`'s `sampleTrack` is a template with rewards at a handful of
milestone levels — claiming an unlisted level is a no-op, there's nothing
there. UI: a toggle panel with the season name, level/XP bar, a premium
purchase button, and free/premium claim cells per tier.

**Phase 11 — Live/seasonal events (spec §11, §27, §36 Phase 11):** proves the
"new content needs no code change" claim from the original roadmap. Added a
`trigger: "seasonal"` event type with a `season` field
(`events.json`); four new events (Planting Festival, Summer Fair, Harvest
Festival, Winter Solstice), each granting Battle Pass XP alongside their
regular effects. `SurvivalSystem.advanceDay` now returns whether the season
just changed; `Simulation.rollSeasonalEvents()` (called only then) rolls each
human civ a 70% chance to see a season-matching event. Adding more seasonal
content going forward is purely new `events.json` entries.

### Verified in-browser
Selected a citizen, watched the hint bar update, assigned them to a specific
tree tile, confirmed `job`/`workNode` on the server matched the exact node
clicked. Confirmed the Diplomacy button is now visible before any rival is
discovered, with the new empty-state copy. Watched "The Summer Fair" fire
naturally on a real spring→summer transition. Claimed Battle Pass rewards
(level 1 free banner, level 10 free 50 LT, exact balance math checked),
purchased the premium pass (950 LT, exact deduction), and confirmed both the
premium purchase and a reward claim are replay-safe (resending either command
did not double-grant or double-charge).

---

## 19. Running it

**Solo (offline, no server needed):**
```bash
npm install
npm run dev        # http://localhost:5190
```
Found your camp on a lit tile near wood, water and food; citizens do the rest.

**Real multiplayer:**
```bash
npm run server      # starts ws://localhost:8790 (one shared match)
npm run dev          # in another terminal
```
Open `http://localhost:5190/?server=ws://localhost:8790` in as many browser
tabs/machines as you want players — each claims its own civ on the same isle.

**Share a single file (solo only, no server):**
```bash
npm run build:standalone
```
Produces `founders-of-the-giant-isle.html` — one self-contained file (~87 KB)
with the built JS inlined via `scripts/build-standalone.mjs`. Send it to
anyone; they open it directly in a browser and play solo, no install or
server needed. It's still the same client, so choosing "Multiplayer" on its
menu works too *if* the recipient has a real server address to type in — this
build just doesn't ship one.

**Other commands:**
```bash
npm run typecheck  # strict, no emit (covers src/, server/, data/)
npm run build      # typecheck + static client bundle to dist/
```
