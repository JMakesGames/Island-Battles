// Animal-companion buffs (spec: "the animals should have effects/buffs...
// dogs hunt wolfs attacking the player, cat scares wolfs and bears away at
// night, Dragon increases the player's speed by 50% when hp is below 50").
// One companion is active at a time, stored in the civ's wallet under the
// "companion" equip slot (a companion id from config.Companions). Because the
// wallet lives in server-authoritative civ state, these buffs work identically
// in solo and multiplayer.

import type { Civ } from "../game/Civ.ts";
import { getCompanion, type CompanionBuff } from "../game/config.ts";

/** The active companion's buff key, or null if none equipped. */
export function companionBuff(civ: Civ): CompanionBuff | null {
  const id = civ.wallet?.equipped?.companion;
  if (!id) return null;
  return getCompanion(id)?.buff ?? null;
}

/** Leader movement multiplier from the companion (horse always, dragon when
 * the leader is badly hurt). 1 when no speed companion is active. */
export function companionSpeedMult(civ: Civ): number {
  const buff = companionBuff(civ);
  if (buff === "horse") return 1.2;
  if (buff === "dragon") {
    const hp = civ.leader?.health ?? 100;
    return hp < 50 ? 1.5 : 1;
  }
  return 1;
}

/** Extra fog-of-war reveal radius from the hawk. */
export function companionRevealBonus(civ: Civ): number {
  return companionBuff(civ) === "hawk" ? 2.5 : 0;
}

/** Per-tick wound the loyal hound deals to a monster attacking its master. */
export const DOG_BITE_DAMAGE = 0.6;
