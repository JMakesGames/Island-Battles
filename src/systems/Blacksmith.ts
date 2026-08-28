// The Blacksmith (spec: "add a blacksmith character that the player can buy
// axes, pick axes, swords, iron, etc"). Tools are bought once per civ with
// regular resources (wood/stone/iron/gold) — real gameplay power, unlike the
// Legacy Market's purely cosmetic items (spec §22/§26) — so this has no
// business being gated behind LT or moved to the main menu; it's a normal
// mid-match purchase, same posture as placing a building.

import type { Civ } from "../game/Civ.ts";
import type { ResourceId } from "../core/types.ts";
import { Tools, getTool } from "../game/config.ts";

export type CommandResult = { ok: boolean; message: string };

function hasBlacksmith(civ: Civ): boolean {
  return civ.buildings.some((b) => b.id === "blacksmith" && b.complete);
}

export function purchaseTool(civ: Civ, toolId: string): CommandResult {
  const tool = getTool(toolId);
  if (!tool) return { ok: false, message: "No such tool." };
  if (!hasBlacksmith(civ)) return { ok: false, message: "Build a Blacksmith first." };
  if (civ.tools.includes(toolId)) return { ok: false, message: "You already own that." };
  if (!civ.has(tool.cost)) return { ok: false, message: `Not enough resources for a ${tool.name}.` };
  civ.spend(tool.cost);
  civ.tools.push(toolId);
  return { ok: true, message: `Forged a ${tool.name}!` };
}

/** Combined multiplier for gathering a resource, from every owned tool that
 * applies to it (spec: axes speed up wood, pickaxes speed up stone/iron). */
export function gatherToolMult(civ: Civ, resource: ResourceId): number {
  let mult = 1;
  for (const id of civ.tools) {
    const tool = getTool(id);
    if (tool?.effect.type === "gatherMult" && tool.effect.resources?.includes(resource)) {
      mult *= tool.effect.mult;
    }
  }
  return mult;
}

/** Combined combat damage multiplier from every owned tool (spec: swords hit
 * harder). */
export function combatToolMult(civ: Civ): number {
  let mult = 1;
  for (const id of civ.tools) {
    const tool = getTool(id);
    if (tool?.effect.type === "combatMult") mult *= tool.effect.mult;
  }
  return mult;
}

export { Tools };
