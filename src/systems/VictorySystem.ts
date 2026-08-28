// Victory conditions (spec §16). Checked once per day; the first civ to meet
// any condition wins and the match keeps running afterward (so players can
// keep exploring/playing) rather than hard-stopping — state.victory is set
// once and never overwritten, and the client shows a victory screen off it.
//
// Conquest victory is intentionally not implemented: there is no combat
// system yet (spec §11 is a documented future phase), so "capture all
// capitals" has no mechanism to execute. Shipping a fake conquest condition
// would be worse than being honest that it isn't here yet.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { Techs, getBuilding } from "../game/config.ts";

const PROSPERITY_POP = 15;
const PROSPERITY_MORALE = 75;
const PROSPERITY_MIN_DAYS = 20;

function checkProsperity(civ: Civ, day: number): boolean {
  if (!civ.foundedDay) return false;
  return (
    civ.peakPopulation >= PROSPERITY_POP &&
    civ.morale >= PROSPERITY_MORALE &&
    day - civ.foundedDay >= PROSPERITY_MIN_DAYS
  );
}

function checkKnowledge(civ: Civ): boolean {
  return civ.researched.length >= Techs.length; // completed the entire tree
}

function checkLegacy(civ: Civ): boolean {
  return civ.buildings.some(
    (b) => b.complete && getBuilding(b.id).provides.victoryMonument === true,
  );
}

function checkDiplomatic(state: GameState, civId: number): boolean {
  const others = state.civs.filter((c) => c.id !== civId);
  if (others.length === 0) return false;
  return others.every((o) => state.relations.stance(civId, o.id) === "alliance");
}

export function updateVictory(state: GameState, bus: EventBus): void {
  if (state.victory) return; // already decided

  for (const civ of state.civs) {
    if (!civ.started) continue;
    let kind: "prosperity" | "knowledge" | "diplomatic" | "legacy" | null = null;

    if (checkLegacy(civ)) kind = "legacy";
    else if (checkKnowledge(civ)) kind = "knowledge";
    else if (checkDiplomatic(state, civ.id)) kind = "diplomatic";
    else if (checkProsperity(civ, state.day)) kind = "prosperity";

    if (kind) {
      state.victory = { kind, civId: civ.id, civName: civ.name, day: state.day };
      state.log(`${civ.name} achieved a ${kind} victory!`);
      bus.emit({ type: "victory", kind, civId: civ.id, civName: civ.name, day: state.day });
      return;
    }
  }
}
