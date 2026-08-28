// The Leader as a controllable character (spec §5): gains experience, levels
// up, and earns traits. Manual movement lives in CitizenSystem (it's just
// another citizen's position); this file covers what makes the leader special
// — XP/leveling and the "rally" interaction with nearby villagers.

import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { LeaderTraits, getLeaderTrait } from "../game/config.ts";

/** Succession (spec: "leader death shouldn't unfairly ruin a normal run —
 * implement a clear recovery flow, such as promoting a new leader"). Called
 * whenever a civ's leader has just died and at least one citizen survives —
 * picks the most experienced survivor (a believable "second-in-command"
 * rather than a random pick) and hands them the role, so the settlement
 * carries on instead of the run ending outright. Named leader persistence
 * (spec §15) already treats a leader as "just a citizen with isLeader=true",
 * so promotion is a flag flip plus a name tweak, not a new code path. */
export function promoteNewLeader(civ: Civ, bus: EventBus): void {
  if (civ.citizens.length === 0) return;
  let heir = civ.citizens[0];
  for (const c of civ.citizens) {
    if (c.skill > heir.skill) heir = c;
  }
  heir.isLeader = true;
  if (!civ.isAI && !heir.name.endsWith("(You)")) heir.name = `${heir.name} (You)`;
  if (!civ.isAI) {
    bus.emit({ type: "toast", text: `${heir.name} steps up to lead your people onward.` });
  }
}

const RALLY_RADIUS = 2.5;
const RALLY_COOLDOWN_TICKS = 180; // ~3s at 60Hz, so it can't be spammed

/** XP required to reach the next level (100, 250, 450, ... — gently steepening). */
function xpForLevel(level: number): number {
  return level * 150;
}

/** Grant leader XP and roll level-ups (spec §5: "Gains experience"). */
export function grantLeaderXp(civ: Civ, amount: number, bus: EventBus): void {
  const leader = civ.leader;
  if (!leader) return;
  civ.leaderXp += amount;
  while (civ.leaderXp >= xpForLevel(civ.leaderLevel)) {
    civ.leaderXp -= xpForLevel(civ.leaderLevel);
    civ.leaderLevel += 1;
    const pool = LeaderTraits.filter((t) => !civ.leaderTraits.includes(t.id));
    if (pool.length > 0) {
      const trait = pool[Math.floor(Math.random() * pool.length)];
      civ.leaderTraits.push(trait.id);
      if (!civ.isAI) {
        bus.emit({ type: "leaderLevelUp", civ: civ.id, level: civ.leaderLevel, traitId: trait.id });
        bus.emit({ type: "toast", text: `⭐ Your leader reached level ${civ.leaderLevel}! Gained: ${trait.name}.` });
      }
    }
  }
}

/** The leader rallies nearby citizens — a spirited pep talk (spec §5 leader
 * interacting with citizens). Server-validated proximity + cooldown. */
export function rally(civ: Civ, bus: EventBus, tick: number): boolean {
  const leader = civ.leader;
  if (!leader) return false;
  if (tick - (civ.lastRallyTick ?? -Infinity) < RALLY_COOLDOWN_TICKS) return false;

  let orator = 0;
  for (const id of civ.leaderTraits) orator += getLeaderTrait(id)?.rallyBonus ?? 0;
  const moraleBoost = 6 + orator;

  let affected = 0;
  for (const c of civ.citizens) {
    if (c.isLeader) continue;
    const d = Math.hypot(c.pos.x - leader.pos.x, c.pos.y - leader.pos.y);
    if (d <= RALLY_RADIUS) {
      c.morale = Math.min(100, c.morale + moraleBoost);
      c.loyalty = Math.min(100, c.loyalty + 4);
      affected++;
    }
  }
  civ.lastRallyTick = tick;
  grantLeaderXp(civ, 5, bus);
  if (affected > 0) {
    bus.emit({ type: "toast", text: `You rallied ${affected} citizen${affected === 1 ? "" : "s"}!` });
  } else {
    bus.emit({ type: "toast", text: "No one was close enough to hear you." });
  }
  return true;
}
