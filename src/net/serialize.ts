// Snapshot rehydration for NetworkTransport (spec §36 Phase 5). A snapshot
// crosses the wire as plain JSON — `JSON.parse` gives back POJOs, not class
// instances, so `state.relations.stance(...)`, `civ.storageCap`, and
// `world.tileAt(...)` would all be missing. Rehydration re-attaches each
// class's prototype (via Object.create + Object.assign) WITHOUT re-running its
// constructor — re-running World's constructor, for instance, would regenerate
// a completely different island instead of restoring the real one.

import { GameState } from "../game/GameState.ts";
import { World } from "../world/World.ts";
import { Civ } from "../game/Civ.ts";
import { Relations } from "../game/Relations.ts";
import { RNG } from "../core/rng.ts";

function attach<T extends object>(proto: T, raw: unknown): T {
  return Object.assign(Object.create(proto as object), raw as object) as T;
}

/** Backfill fields a save/snapshot might be missing — either an older save
 * made before a feature (Battle Pass, quests, wolf packs, ...) existed, or
 * any other partial/malformed payload. `Object.assign` only copies what's
 * actually present in `raw`; a field simply absent from an old save stays
 * fully undefined after rehydration, not merely empty — so `for (const m of
 * state.monsters)` throws "not iterable" instead of just running zero times.
 * One missing optional property should never crash a loaded game (spec:
 * save/load must gracefully handle older data). */
function backfillCiv(civ: Civ): void {
  civ.stock ??= {};
  civ.citizens ??= [];
  civ.buildings ??= [];
  civ.reputation ??= {};
  civ.tools ??= [];
  civ.wallet ??= { lt: 0, inventory: [], processedRequests: [], equipped: {} };
  civ.wallet.inventory ??= [];
  civ.wallet.processedRequests ??= [];
  civ.wallet.equipped ??= {};
  civ.scoutedRivals ??= [];
  civ.achievementsEarned ??= [];
  civ.tasksCompleted ??= [];
  civ.leaderTraits ??= [];
  civ.researched ??= [];
  civ.battlePassClaimed ??= [];
  civ.automationMode ??= "smart";
  for (const c of civ.citizens) {
    c.traits ??= [];
    c.carry ??= null;
    c.jobLocked ??= false;
  }
}

function backfillState(state: GameState): void {
  state.chronicle ??= [];
  state.pendingProposals ??= [];
  state.huntedAnimals ??= {};
  state.animalWounds ??= {};
  state.monsters ??= [];
  state.nextMonsterId ??= 1;
  state.pendingQuestSteps ??= [];
  state.hardcoreLeaderDeath ??= false;
  for (const civ of state.civs) backfillCiv(civ);
}

export function rehydrateSnapshot(raw: unknown): GameState {
  const r = raw as {
    world: unknown;
    relations: unknown;
    civs: unknown[];
  };
  // Compute the rehydrated civ list before touching state.civs — attach()
  // copies the raw `civs` array by reference, so clearing state.civs first
  // would clear r.civs out from under this map.
  const civs = (r.civs ?? []).map((c) => attach(Civ.prototype, c));
  const state = attach(GameState.prototype, raw);
  // `world` is a readonly field on GameState; Object.assign (a function call,
  // not a property write) sidesteps that compile-time check the same way the
  // server's own construction logic is exempt from it inside the constructor.
  Object.assign(state, {
    world: attach(World.prototype, r.world),
    relations: attach(Relations.prototype, r.relations),
  });
  state.civs.length = 0;
  state.civs.push(...civs);
  backfillState(state);
  return state;
}

/** Like rehydrateSnapshot, but also re-attaches every RNG prototype so the
 * restored state can keep TICKING locally (a saved solo game resumes in the
 * same tab — unlike a network snapshot, where the client never ticks and so
 * never needs a working RNG). JSON gives each RNG back as a plain `{state:n}`;
 * we reattach RNG.prototype in place. The three streams (world.rng, state.rng,
 * per-civ rng) become independent after a save/load round-trip rather than the
 * shared references they were at runtime — harmless for solo continue, which
 * doesn't need cross-stream determinism. */
export function rehydrateSave(raw: unknown): GameState {
  const state = rehydrateSnapshot(raw);
  const asRng = (o: { rng?: unknown }): void => {
    if (o && o.rng) o.rng = attach(RNG.prototype, o.rng);
  };
  asRng(state as unknown as { rng?: unknown });
  asRng(state.world as unknown as { rng?: unknown });
  for (const civ of state.civs) asRng(civ as unknown as { rng?: unknown });
  return state;
}
