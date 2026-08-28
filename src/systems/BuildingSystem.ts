// Placement + construction start, per civ. Validation is data-driven from
// buildings.json / biomes.json (spec §9, §34). The player is gated by their fog
// of war; an AI civ builds on its own knowledge. Occupancy is checked across
// every civ so settlements never overlap.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import type { Vec2 } from "../core/types.ts";
import { getBuilding, getBiome, eraRank } from "../game/config.ts";
import { techBonus } from "./TechSystem.ts";

export interface PlaceResult {
  ok: boolean;
  reason?: string;
}

/** Siege HP (spec: "break into a fortified rival camp") — enough hits at
 * CombatSystem's SIEGE_DAMAGE to take real, noticeable effort, without a
 * defended camp being flatly unbreakable. */
export const WALL_MAX_HEALTH = 60;

function occupied(state: GameState, tile: Vec2): boolean {
  return state.civs.some((civ) =>
    civ.buildings.some((b) => b.tile.x === tile.x && b.tile.y === tile.y),
  );
}

/** True if any civ has a completed wall standing on this tile (spec: "make
 * walls actually block/slow movement"). A hard stop, not pathfinding — see
 * moveWithCollision, which is what actually keeps citizens/the leader off
 * these tiles while still letting them slide around one. */
export function isWallTile(state: GameState, x: number, y: number): boolean {
  const tx = Math.round(x);
  const ty = Math.round(y);
  return state.civs.some((civ) =>
    civ.buildings.some((b) => b.id === "wall" && b.complete && b.tile.x === tx && b.tile.y === ty),
  );
}

/** True past the coastline — open ocean or off the world grid entirely (bug
 * report: "stop the player from moving past the island lines"). Inland
 * lakes stay crossable (they're a deliberate early water source, spec §8),
 * only the surrounding sea and the grid edge count as out of bounds. */
export function isOutOfBounds(state: GameState, x: number, y: number): boolean {
  const t = state.world.tileAt(Math.round(x), Math.round(y));
  return !t || t.biome === "ocean";
}

/** Applies a movement delta to `pos`, refusing to step onto a walled tile or
 * past the island's coastline — each axis is tried independently so
 * movement slides along the obstacle instead of getting fully stuck the
 * instant either component would cross one. */
export function moveWithCollision(state: GameState, pos: Vec2, dx: number, dy: number): void {
  if (!isWallTile(state, pos.x + dx, pos.y) && !isOutOfBounds(state, pos.x + dx, pos.y)) pos.x += dx;
  if (!isWallTile(state, pos.x, pos.y + dy) && !isOutOfBounds(state, pos.x, pos.y + dy)) pos.y += dy;
}

export function canPlace(
  state: GameState,
  civ: Civ,
  typeId: string,
  tile: Vec2,
  requireExplored = true,
): PlaceResult {
  const t = state.world.tileAt(tile.x, tile.y);
  if (!t) return { ok: false, reason: "Off the island." };
  if (!getBiome(t.biome).buildable) return { ok: false, reason: `Can't build on ${t.biome}.` };
  if (requireExplored && !t.explored) return { ok: false, reason: "You haven't explored there yet." };
  if (occupied(state, tile)) return { ok: false, reason: "Something is already here." };
  const def = getBuilding(typeId);
  if (eraRank(def.era) > eraRank(civ.era)) {
    return { ok: false, reason: `Requires the ${def.era} era — research it first.` };
  }
  if (!civ.has(def.cost)) {
    const missing = Object.entries(def.cost)
      .filter(([r, a]) => (civ.stock[r as keyof typeof civ.stock] ?? 0) < (a ?? 0))
      .map(([r, a]) => `${Math.ceil((a ?? 0) - (civ.stock[r as keyof typeof civ.stock] ?? 0))} more ${r}`)
      .join(", ");
    return { ok: false, reason: `Not enough resources — need ${missing}.` };
  }
  return { ok: true };
}

export function place(
  state: GameState,
  civ: Civ,
  bus: EventBus,
  typeId: string,
  tile: Vec2,
  requireExplored = true,
): PlaceResult {
  const check = canPlace(state, civ, typeId, tile, requireExplored);
  if (!check.ok) return check;

  const def = getBuilding(typeId);
  civ.spend(def.cost);
  // Engineering (spec §10) shaves 25% off every build from here on.
  const speedMult = techBonus(civ, "buildSpeed") > 0 ? 0.75 : 1;
  const buildTicks = Math.round(def.buildTicks * speedMult);
  const complete = buildTicks <= 0;
  civ.buildings.push({
    id: typeId,
    tile: { ...tile },
    color: def.color,
    buildRemaining: buildTicks,
    complete,
    health: typeId === "wall" ? WALL_MAX_HEALTH : undefined,
  });

  if (typeId === "road") {
    // Roads aren't a "structure" to build toward — they just pave the tile
    // (spec §9). Mark it immediately rather than leaving a phantom building.
    state.world.tileAt(tile.x, tile.y)!.road = true;
    civ.buildings[civ.buildings.length - 1].complete = true;
    civ.buildings[civ.buildings.length - 1].buildRemaining = 0;
  }

  if (def.provides.isTownCenter) {
    civ.home = { ...tile };
    civ.started = true;
    civ.foundedDay = state.day;
  }
  if (!civ.isAI) {
    bus.emit({ type: "buildingPlaced", id: typeId });
    bus.emit({ type: "resourceChanged" });
    state.log(`Construction of a ${def.name} began.`);
  }
  return { ok: true };
}

/** Nearest enemy wall within range that this civ is at war with (spec:
 * "break into a fortified rival camp") — mirrors CombatSystem.findEnemyNear
 * but for a wall tile instead of a citizen. */
export function findEnemyWallNear(
  state: GameState,
  civ: Civ,
  from: Vec2,
  range: number,
): { civId: number; tile: Vec2 } | null {
  let best: { civId: number; tile: Vec2 } | null = null;
  let bestD = range;
  for (const other of state.civs) {
    if (other.id === civ.id) continue;
    if (state.relations.stance(civ.id, other.id) !== "war") continue;
    for (const b of other.buildings) {
      if (b.id !== "wall" || !b.complete) continue;
      const d = Math.hypot(b.tile.x - from.x, b.tile.y - from.y);
      if (d <= bestD) {
        bestD = d;
        best = { civId: other.id, tile: { ...b.tile } };
      }
    }
  }
  return best;
}

/** Damages the wall at `tile` for `targetCiv`; destroys and removes it once
 * health hits 0, opening the breach. Returns true once it's gone (already
 * gone counts too, so callers can always clear a siege target on `true`). */
export function damageWall(state: GameState, targetCiv: Civ, tile: Vec2, dmg: number, bus: EventBus): boolean {
  const b = targetCiv.buildings.find((x) => x.id === "wall" && x.tile.x === tile.x && x.tile.y === tile.y);
  if (!b) return true;
  b.health = Math.max(0, (b.health ?? WALL_MAX_HEALTH) - dmg);
  if (b.health > 0) return false;
  targetCiv.buildings = targetCiv.buildings.filter((x) => x !== b);
  state.log(`A wall of ${targetCiv.name}'s has been breached!`);
  if (!targetCiv.isAI) bus.emit({ type: "toast", text: "Your wall has been breached!" });
  return true;
}
