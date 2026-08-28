// Combat (spec: "the player should attack as well", "add soldiers"). Kept
// deliberately simple: only between civs at "war" stance (see
// systems/Diplomacy.ts — declare war before you can fight). A citizen with a
// live attack target walks straight at them and, once in range, trades hits
// on a cooldown until one side dies or the target is no longer valid (fled,
// at peace again, already dead). Movement here is a dumb straight line, not
// the terrain-aware CitizenSystem.moveToward — combat engagements are short
// and this avoids a circular import between the two systems.
//
// Two job types fight: "guard" (melee, full damage, has to close to
// ATTACK_RANGE) and "archer" (spec: "unit variety... archers" — ranged,
// weaker per hit, never has to close past ARCHER_RANGE). Equipping the
// MOUNTS cosmetic (spec: "cavalry — the mount cosmetics... purely visual")
// now gives the leader real speed/damage, not just a different sprite.
//
// The leader can die like anyone else (spec: "when the leader of that
// country dies, all citizens from the other country come and join my
// army") — killing a leader routs their whole civilization: every
// surviving citizen defects to the killer's civ instead of being left
// leaderless. A human player whose own leader falls loses control the same
// way (their citizens defect away too) — there's still no dedicated
// game-over screen, but every UI element that reads civ.leader already
// treats "no leader" as a valid state (see Hud.updateLeaderBar).

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { Citizen, Vec2 } from "../core/types.ts";
import type { EventBus } from "../core/events.ts";
import { combatToolMult } from "./Blacksmith.ts";
import { moveWithCollision, findEnemyWallNear, damageWall } from "./BuildingSystem.ts";
import { promoteNewLeader } from "./LeaderSystem.ts";

const ATTACK_RANGE = 0.9;
const ATTACK_COOLDOWN = 45; // ticks between hits
const BASE_DAMAGE = 5;
const COMBAT_SPEED = 0.055;
const GUARD_ENGAGE_RADIUS = 6;

// Archers (spec: "unit variety beyond the single soldier job... archers")
// never need to close to melee range, but trade weaker hits for that safety
// — a real tactical choice against a guard's full-damage brawling.
const ARCHER_RANGE = 3.5;
const ARCHER_DAMAGE_MULT = 0.65;

// Cavalry (spec: "cavalry — the mount cosmetics already exist but are purely
// visual") — equipping a MOUNTS cosmetic now gives the leader a real speed
// and damage edge, not just a different sprite. Citizens don't ride mounts,
// only the leader (mounts render on the leader alone — see Renderer.ts).
export const MOUNT_SPEED_MULT = 1.3;
const MOUNT_DAMAGE_MULT = 1.2;

/** The leader's own attack delay (spec: "the player has an attack delay,
 * maybe .5 seconds") — gates the interact key (attack/hunt/gather/rally all
 * share it) so mashing E can't chain actions instantly. 60 ticks/sec. */
export const LEADER_INTERACT_COOLDOWN = 30;

// Siege (spec: "break into a fortified rival camp") — flat, not scaled by
// skill/tools like citizen combat, so a wall's toughness is predictable
// regardless of who's swinging at it.
const SIEGE_DAMAGE = 8;

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export type CommandResult = { ok: boolean; message: string };

/** Player intent: send one of your citizens (often the leader) to fight a
 * specific enemy citizen. Requires an active war with their civ. */
export function attackTarget(
  state: GameState,
  civ: Civ,
  citizenId: number,
  targetCivId: number,
  targetCitizenId: number,
): CommandResult {
  const attacker = civ.citizens.find((c) => c.id === citizenId);
  if (!attacker) return { ok: false, message: "That citizen is no longer here." };
  if (targetCivId === civ.id) return { ok: false, message: "You can't attack your own people." };
  const targetCiv = state.civs[targetCivId];
  if (!targetCiv) return { ok: false, message: "That civilization is gone." };
  if (state.relations.stance(civ.id, targetCivId) !== "war") {
    return { ok: false, message: "You're not at war with them — declare war first." };
  }
  const target = targetCiv.citizens.find((c) => c.id === targetCitizenId);
  if (!target) return { ok: false, message: "That target is gone." };
  attacker.attackCiv = targetCivId;
  attacker.attackId = targetCitizenId;
  return { ok: true, message: `${attacker.name} moves to attack ${target.name}!` };
}

/** Player intent: send one of your citizens (often the leader) to besiege a
 * specific enemy wall tile (spec: "break into a fortified rival camp").
 * Requires an active war with their civ, same as attacking a citizen. */
export function attackWall(
  state: GameState,
  civ: Civ,
  citizenId: number,
  targetCivId: number,
  tile: Vec2,
): CommandResult {
  const attacker = civ.citizens.find((c) => c.id === citizenId);
  if (!attacker) return { ok: false, message: "That citizen is no longer here." };
  const targetCiv = state.civs[targetCivId];
  if (!targetCiv) return { ok: false, message: "That civilization is gone." };
  if (state.relations.stance(civ.id, targetCivId) !== "war") {
    return { ok: false, message: "You're not at war with them — declare war first." };
  }
  attacker.attackWallCiv = targetCivId;
  attacker.attackWallTile = { ...tile };
  return { ok: true, message: `${attacker.name} lays siege to the wall!` };
}

/** Nearest enemy citizen within range that this civ is at war with, if any
 * (spec: "the player should attack... when in range" — used by the
 * interact key so you don't have to click the exact tile). */
export function findEnemyNear(
  state: GameState,
  civ: Civ,
  from: Vec2,
  range: number,
): { civId: number; citizenId: number } | null {
  let best: { civId: number; citizenId: number } | null = null;
  let bestD = range;
  for (const other of state.civs) {
    if (other.id === civ.id) continue;
    if (state.relations.stance(civ.id, other.id) !== "war") continue;
    for (const c of other.citizens) {
      const d = dist(c.pos, from);
      if (d <= bestD) {
        bestD = d;
        best = { civId: other.id, citizenId: c.id };
      }
    }
  }
  return best;
}

function damageFor(attacker: Citizen, civ: Civ): number {
  let dmg = BASE_DAMAGE * (0.6 + attacker.skill / 80) * combatToolMult(civ);
  if (attacker.job === "archer") dmg *= ARCHER_DAMAGE_MULT;
  if (attacker.isLeader && civ.wallet.equipped.MOUNTS) dmg *= MOUNT_DAMAGE_MULT;
  return dmg;
}

function killCitizen(state: GameState, civ: Civ, killerCiv: Civ, target: Citizen, bus: EventBus): void {
  civ.citizens = civ.citizens.filter((c) => c.id !== target.id);
  state.log(`${target.name} of ${civ.name} fell in battle.`);
  if (!civ.isAI) bus.emit({ type: "toast", text: `${target.name} has fallen in battle.` });

  if (!target.isLeader) return;

  // A human civ's leader falling shouldn't unfairly end a normal run (spec:
  // "leader death — implement a clear recovery flow" by default; keep the
  // old permadeath-and-defect behavior only for those who opt into hardcore
  // mode). AI rivals always use the original conquest behavior below —
  // sieging down a rival's leader is the whole reward for going to war with
  // them, and softening that would gut the mechanic for the player as the
  // aggressor.
  if (!civ.isAI && !state.hardcoreLeaderDeath) {
    if (civ.citizens.length > 0) {
      promoteNewLeader(civ, bus);
    } else {
      bus.emit({ type: "toast", text: "Your leader has fallen, and no one remains to carry your people forward." });
    }
    return;
  }

  // Conquest: the losing civ's whole remaining population defects.
  const defectors = civ.citizens;
  civ.citizens = [];
  for (const c of defectors) {
    c.attackCiv = undefined;
    c.attackId = undefined;
    c.attackWallCiv = undefined;
    c.attackWallTile = undefined;
    c.job = "idle";
  }
  killerCiv.citizens.push(...defectors);
  state.log(`${civ.name} has fallen — their people join ${killerCiv.name}.`);
  const msg = `${civ.name}'s leader has fallen! ${defectors.length} of their citizens join your civilization.`;
  if (!killerCiv.isAI) bus.emit({ type: "toast", text: msg });
  if (!civ.isAI) bus.emit({ type: "toast", text: `Your leader has fallen — your people have defected to ${killerCiv.name}.` });
}

/** Runs once per tick for one civ: resolve every citizen's live attack
 * intent, and let guarding soldiers pick a fight with a nearby enemy at war
 * on their own (spec: "add soldiers") without the player clicking each one. */
export function updateCombat(state: GameState, civ: Civ, bus: EventBus): void {
  for (const c of [...civ.citizens]) {
    if ((c.job === "guard" || c.job === "archer") && c.attackCiv === undefined) {
      for (const other of state.civs) {
        if (other.id === civ.id) continue;
        if (state.relations.stance(civ.id, other.id) !== "war") continue;
        const near = other.citizens.find((o) => dist(o.pos, c.pos) <= GUARD_ENGAGE_RADIUS);
        if (near) {
          c.attackCiv = other.id;
          c.attackId = near.id;
          break;
        }
      }
    }

    if (c.attackCiv === undefined || c.attackId === undefined) continue;
    const targetCiv = state.civs[c.attackCiv];
    const target = targetCiv?.citizens.find((t) => t.id === c.attackId);
    if (!target || state.relations.stance(civ.id, c.attackCiv) !== "war") {
      c.attackCiv = undefined;
      c.attackId = undefined;
      continue;
    }

    const range = c.job === "archer" ? ARCHER_RANGE : ATTACK_RANGE;
    const speed = c.isLeader && civ.wallet.equipped.MOUNTS ? COMBAT_SPEED * MOUNT_SPEED_MULT : COMBAT_SPEED;
    const d = dist(c.pos, target.pos);
    if (d > range) {
      const dx = target.pos.x - c.pos.x;
      const dy = target.pos.y - c.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      moveWithCollision(state, c.pos, (dx / len) * speed, (dy / len) * speed);
      continue;
    }

    if (c.attackCooldown > 0) {
      c.attackCooldown -= 1;
      continue;
    }
    c.attackCooldown = ATTACK_COOLDOWN;

    const dmg = damageFor(c, civ);
    target.health = Math.max(0, target.health - dmg);
    if (target.health <= 0) {
      killCitizen(state, targetCiv!, civ, target, bus);
      c.attackCiv = undefined;
      c.attackId = undefined;
    }
  }
}

/** Runs once per tick for one civ: resolve every citizen's live wall-siege
 * intent (spec: "break into a fortified rival camp"), and let guarding
 * soldiers/archers pick up a nearby enemy wall on their own once there's no
 * living enemy to fight — the same auto-engage courtesy updateCombat gives
 * citizens, one step further into the enemy camp. Walls physically block
 * movement (see BuildingSystem.moveWithCollision), so an attacker marching
 * on a walled camp naturally ends up pressed right up against it — this is
 * what actually lets that siege happen instead of stalling forever outside. */
export function updateSiege(state: GameState, civ: Civ, bus: EventBus): void {
  for (const c of [...civ.citizens]) {
    if ((c.job === "guard" || c.job === "archer") && c.attackCiv === undefined && c.attackWallCiv === undefined) {
      const found = findEnemyWallNear(state, civ, c.pos, GUARD_ENGAGE_RADIUS);
      if (found) {
        c.attackWallCiv = found.civId;
        c.attackWallTile = found.tile;
      }
    }

    if (c.attackWallCiv === undefined || c.attackWallTile === undefined) continue;
    const targetCiv = state.civs[c.attackWallCiv];
    if (!targetCiv || state.relations.stance(civ.id, c.attackWallCiv) !== "war") {
      c.attackWallCiv = undefined;
      c.attackWallTile = undefined;
      continue;
    }
    const tile = c.attackWallTile;
    const stillStanding = targetCiv.buildings.some(
      (b) => b.id === "wall" && b.tile.x === tile.x && b.tile.y === tile.y,
    );
    if (!stillStanding) {
      c.attackWallCiv = undefined;
      c.attackWallTile = undefined;
      continue;
    }

    const range = c.job === "archer" ? ARCHER_RANGE : ATTACK_RANGE;
    const speed = c.isLeader && civ.wallet.equipped.MOUNTS ? COMBAT_SPEED * MOUNT_SPEED_MULT : COMBAT_SPEED;
    const d = dist(c.pos, tile);
    if (d > range) {
      const dx = tile.x - c.pos.x;
      const dy = tile.y - c.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      moveWithCollision(state, c.pos, (dx / len) * speed, (dy / len) * speed);
      continue;
    }

    if (c.attackCooldown > 0) {
      c.attackCooldown -= 1;
      continue;
    }
    c.attackCooldown = ATTACK_COOLDOWN;

    if (damageWall(state, targetCiv, tile, SIEGE_DAMAGE, bus)) {
      c.attackWallCiv = undefined;
      c.attackWallTile = undefined;
    }
  }
}
