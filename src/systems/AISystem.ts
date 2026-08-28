// Phase 2: AI civilizations (spec §4, §36). Each AI civ's citizens already
// gather/haul/build via CitizenSystem; this brain supplies the *decisions* —
// what to build next and where — by reading the same GameState the player acts
// on. It is deliberately a small utility planner so its behaviour is readable and
// tunable, and so a stronger planner can replace it without touching other
// systems.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import type { Vec2 } from "../core/types.ts";
import { canPlace, place } from "./BuildingSystem.ts";
import { getBuilding } from "../game/config.ts";

/** Count completed + in-progress buildings of a type. */
function countOf(civ: Civ, id: string): number {
  return civ.buildings.filter((b) => b.id === id).length;
}

/**
 * Decide the next building for an AI civ, in priority order. Returns a building
 * id or null if the civ should keep gathering. Priorities mirror what a human
 * learns: water first, then food security, then housing to grow, then storage.
 */
function chooseBuild(civ: Civ): string | null {
  const pop = civ.citizens.length;
  const wants: string[] = [];

  if (countOf(civ, "well") === 0) wants.push("well");
  if (countOf(civ, "farm") === 0) wants.push("farm");
  if (civ.housing <= pop + 1) wants.push("house");
  if (countOf(civ, "farm") < 2 && pop >= 5) wants.push("farm");
  if (civ.storageCap < 300) wants.push("granary");
  if (civ.housing <= pop) wants.push("house");

  // Build the highest-priority thing the civ can currently afford.
  for (const id of wants) {
    if (civ.has(getBuilding(id).cost)) return id;
  }
  return null;
}

/** Spiral outward from home for a buildable, unoccupied tile. */
function findSite(state: GameState, civ: Civ, typeId: string): Vec2 | null {
  const home = civ.home!;
  for (let r = 1; r <= 8; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring only
        const tile = { x: home.x + dx, y: home.y + dy };
        // AI plans on its own knowledge, so it isn't gated by the player's fog.
        if (canPlace(state, civ, typeId, tile, false).ok) return tile;
      }
    }
  }
  return null;
}

/** Fraction of population an AI civ puts on guard duty while at war (spec:
 * "when I declare war... they should battle") — enough to field a real
 * fight without emptying out the workforce that keeps the civ alive. */
const WARTIME_SOLDIER_SHARE = 0.35;

/** Keep each AI civ's soldier count matched to whether it's at war: promote
 * idle/gathering citizens to "guard" when a war starts, and stand any extra
 * (or all, once peace returns) back down to idle so they resume real work. */
function updateWarFooting(state: GameState, civ: Civ): void {
  const atWar = state.civs.some((o) => o.id !== civ.id && state.relations.stance(civ.id, o.id) === "war");
  const fighters = civ.citizens.filter((c) => !c.isLeader && (c.job === "guard" || c.job === "archer"));
  const wantFighters = atWar ? Math.max(1, Math.floor(civ.citizens.length * WARTIME_SOLDIER_SHARE)) : 0;

  if (fighters.length > wantFighters) {
    for (const c of fighters.slice(wantFighters)) c.job = "idle";
    return;
  }
  if (fighters.length < wantFighters) {
    const eligible = civ.citizens.filter(
      (c) => !c.isLeader && c.job !== "guard" && c.job !== "archer" && (c.job === "idle" || c.job === "gather"),
    );
    for (const c of eligible.slice(0, wantFighters - fighters.length)) {
      // Mixed force (spec: "unit variety... archers") — roughly a third of
      // an AI civ's recruits take up a bow instead of a sword, so its armies
      // aren't purely melee either.
      c.job = c.id % 3 === 0 ? "archer" : "guard";
      c.workNode = -1;
      c.buildTarget = -1;
    }
  }
}

/** Called once per in-game day, after the day's production is applied. */
export function updateAI(state: GameState, bus: EventBus): void {
  for (const civ of state.aiCivs) {
    if (!civ.started || !civ.ai) continue;
    updateWarFooting(state, civ);
    if (civ.ai.planCooldown > 0) {
      civ.ai.planCooldown -= 1;
      continue;
    }
    const choice = chooseBuild(civ);
    if (!choice) {
      civ.ai.goal = "gathering";
      continue;
    }
    const site = findSite(state, civ, choice);
    if (site) {
      place(state, civ, bus, choice, site, false);
      civ.ai.goal = `building ${choice}`;
      // Brief pause so it finishes hauling before starting the next project.
      civ.ai.planCooldown = 1;
    }
  }
}
