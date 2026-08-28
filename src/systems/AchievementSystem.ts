// Achievements (spec: "achievements tied to the existing Battle Pass XP
// economy") — data-driven milestones (data/game/achievements.json) checked
// once per day against a civ's own already-tracked stats. Each is earned at
// most once and grants a flat Battle Pass XP reward on the day it's crossed.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { Achievements } from "../game/config.ts";
import { grantBattlePassXp } from "./BattlePass.ts";

function statFor(state: GameState, civ: Civ, type: string): number {
  switch (type) {
    case "founded": return civ.foundedDay != null ? 1 : 0;
    case "peakPopulation": return civ.peakPopulation;
    case "warsDeclared": return civ.warsDeclared;
    case "alliancesFormed": return civ.alliancesFormed;
    case "researched": return civ.researched.length;
    case "daysSurvived": return civ.foundedDay != null ? state.day - civ.foundedDay : 0;
    case "buildingsComplete": return civ.buildings.filter((b) => b.complete).length;
    case "scoutedRivals": return civ.scoutedRivals.length;
    default: return 0;
  }
}

export function updateAchievements(state: GameState, civ: Civ, bus: EventBus): void {
  if (!civ.started) return;
  for (const a of Achievements) {
    if (civ.achievementsEarned.includes(a.id)) continue;
    if (statFor(state, civ, a.check.type) < a.check.value) continue;
    civ.achievementsEarned.push(a.id);
    grantBattlePassXp(civ, a.xp, bus);
    state.log(`Achievement unlocked: ${a.name} (+${a.xp} Battle Pass XP).`);
    if (!civ.isAI) bus.emit({ type: "toast", text: `🏆 ${a.name} — +${a.xp} Battle Pass XP!` });
  }
}
