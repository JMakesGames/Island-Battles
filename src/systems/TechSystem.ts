// Technology / research (spec §10). Deliberately simple "spend banked
// Knowledge to instantly complete a tech" model rather than a timed queue —
// era techs advance civ.era (which gates buildings, see BuildingSystem), bonus
// techs are optional side investments read by the relevant system (farmYield
// in SurvivalSystem, buildSpeed in BuildingSystem). Not every player follows
// the same path: bonus techs are never required to advance eras.

import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { Techs, getTech, eraRank } from "../game/config.ts";
import { grantBattlePassXp } from "./BattlePass.ts";

export interface ResearchResult {
  ok: boolean;
  message: string;
}

export function canResearch(civ: Civ, techId: string): ResearchResult {
  const tech = getTech(techId);
  if (!tech) return { ok: false, message: "Unknown technology." };
  if (civ.researched.includes(techId)) return { ok: false, message: "Already researched." };
  if (tech.requires && !civ.researched.includes(tech.requires)) {
    return { ok: false, message: `Requires ${getTech(tech.requires)?.name ?? tech.requires} first.` };
  }
  if (tech.type === "era" && eraRank(tech.era) !== eraRank(civ.era) + 1) {
    return { ok: false, message: "That era isn't next in your progression." };
  }
  if ((civ.stock.knowledge ?? 0) < tech.cost) {
    return { ok: false, message: `Needs ${tech.cost} Knowledge.` };
  }
  return { ok: true, message: "" };
}

export function startResearch(civ: Civ, techId: string, bus: EventBus): ResearchResult {
  const check = canResearch(civ, techId);
  if (!check.ok) return check;
  const tech = getTech(techId)!;

  civ.add("knowledge", -tech.cost);
  civ.researched.push(techId);
  if (tech.type === "era") civ.era = tech.era;
  grantBattlePassXp(civ, 15, bus); // spec §25
  if (!civ.isAI) {
    bus.emit({ type: "researchComplete", civ: civ.id, techId });
    bus.emit({ type: "toast", text: `📜 Research complete: ${tech.name}.` });
    bus.emit({ type: "resourceChanged" });
  }
  return { ok: true, message: `Completed ${tech.name}.` };
}

/** A civ-wide modifier from completed bonus techs (spec §10 strategic choices). */
export function techBonus(civ: Civ, bonus: string): number {
  let total = 0;
  for (const id of civ.researched) {
    const t = getTech(id);
    if (t?.bonus === bonus) total += 1;
  }
  return total;
}

/** Very simple AI research: whatever's affordable and next, era techs first. */
export function updateAIResearch(civ: Civ, bus: EventBus): void {
  if (!civ.isAI || !civ.started) return;
  const candidates = Techs.filter((t) => canResearch(civ, t.id).ok);
  if (candidates.length === 0) return;
  const eraTech = candidates.find((t) => t.type === "era");
  startResearch(civ, (eraTech ?? candidates[0]).id, bus);
}
