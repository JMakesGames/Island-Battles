// Turns the Renderer's decorative wildlife (hash-placed, no networked state
// — see render/Renderer.ts) into a real hunting target (spec: "same thing
// for... animals" as chopping wood/mining stone). Deliberately reuses the
// exact same hash01(x,y,salt) placement rule the Renderer uses to decide
// "is there an animal on this tile", so hunting needs no new spawn list or
// per-animal state — only a respawn cooldown, keyed by tile.
//
// Wolves and bears are the one exception (spec: "make the bear and the wolf
// chase the player"): once a leader wanders close enough to notice one, it
// wakes into a real `state.monsters` entry with its own moving position —
// see wakeNearbyMonsters/updateMonsters below. Every other animal (deer,
// sheep, ...) stays the original stateless tile lookup.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { Vec2, Monster, ResourceId } from "../core/types.ts";
import type { EventBus } from "../core/events.ts";
import { getBiome } from "../game/config.ts";
import { hash01 } from "../core/hash.ts";
import { TICKS_PER_DAY } from "../game/GameState.ts";
import { grantLeaderXp, promoteNewLeader } from "./LeaderSystem.ts";
import { companionBuff, DOG_BITE_DAMAGE } from "./Companions.ts";

const FOREST_ANIMALS = ["deer", "wolf", "boar"];
// Bears and alpha wolves are a rare sub-pool of forest spawns (spec: "fix
// the other leaders... bear and wolf") rather than equal-weight entries —
// at full weight a quarter of all forest wildlife would be a dangerous
// bear, which reads as unfair rather than a rare, real threat. Alpha wolves
// (spec: "wildlife variety... a rarer alpha tier") are rarer still — see the
// split inside animalAt below, not an equal three-way pick.
const RARE_FOREST_CHANCE = 0.15;
const ALPHA_SHARE_OF_RARE = 0.25; // of the "rare" roll, this fraction is an alpha wolf, the rest bear
const GRASS_ANIMALS = ["sheep", "chicken", "cow", "horse"];
const SCAN_RADIUS = 3;
const HUNT_RANGE = 1.5;
const RESPAWN_TICKS = TICKS_PER_DAY; // a hunted tile's animal returns the next day
const FOOD_PER_HUNT = 12;
// Bears and alpha wolves drop extra loot on top of the usual meat (spec:
// "make the bear drop extra loot when killed") — a hide and a trophy worth
// trading, on top of the danger and rarity already earning them a tougher
// fight than a plain wolf.
const BONUS_LOOT: Partial<Record<string, Partial<Record<ResourceId, number>>>> = {
  bear: { food: 18, fiber: 10, gold: 8 },
  alphawolf: { food: 20, fiber: 6, gold: 15 },
};

// Display-only: kind identifiers stay simple/single-word for use as object
// keys everywhere above; toast text runs them through these two so "alpha
// wolf" reads naturally ("An alpha wolf attacks you!") instead of literally
// printing the identifier.
const DISPLAY_NAME: Partial<Record<string, string>> = { alphawolf: "alpha wolf" };
function animalName(kind: string): string {
  return DISPLAY_NAME[kind] ?? kind;
}
function article(kind: string): string {
  return /^[aeiou]/i.test(animalName(kind)) ? "An" : "A";
}

// Wolves, alpha wolves, and bears fight back and chase (spec: "make the
// bear and the wolf fight the player when in range" / "chase the player")
// and take hits to put down (spec: "make these two animals 2 shots") —
// every other animal stays a passive, one-hit, stand-still hunt exactly as
// before. A regular wolf sometimes runs with a small pack (spec: "wildlife
// variety... a wolf pack, multiple chasing one target") — see
// WOLF_PACK_CHANCE in wakeNearbyMonsters.
const AGGRESSIVE_ANIMALS = new Set(["wolf", "bear", "alphawolf"]);
export const HITS_TO_KILL: Record<string, number> = { wolf: 2, bear: 2, alphawolf: 3 };
// Tuned down from an earlier pass that felt too punishing (spec: "make it
// easier to fight them off") — lower per-hit damage, more breathing room
// between an animal's own attacks, and see STAGGER_TICKS below: landing a
// hit interrupts its attack timer, so fighting back is actively rewarded
// rather than just tanking hits while you wait out your own cooldown.
const ANIMAL_DAMAGE: Record<string, number> = { wolf: 4, bear: 8, alphawolf: 11 };
const ANIMAL_ATTACK_RANGE = HUNT_RANGE; // if you can reach them, they can reach you
const ANIMAL_ATTACK_COOLDOWN = 120; // ~2s between an animal's own hits
const STAGGER_TICKS = 75; // landing a hit resets its attack timer to at least this
const DETECT_RANGE = 5; // a sleeping wolf/bear wakes once a leader gets this close
const LEASH_RANGE = 9; // gives up and heads home once dragged this far from its spawn tile
const CHASE_SPEED = 0.07; // tiles/tick while chasing or returning home
// A wolf (or alpha wolf) waking up has a real chance of not being alone —
// small, genuine clusters rather than relying on incidental tile density.
const WOLF_PACK_CHANCE = 0.4;
const WOLF_PACK_MIN = 1;
const WOLF_PACK_MAX = 2;

export type CommandResult = { ok: boolean; message: string };

/** Which animal (if any) currently lives on this tile — the single source
 * of truth both the server (hunting/waking) and the Renderer (decorative
 * wildlife) use, so what you see always matches what you can fight. A tile
 * whose wolf/bear is already awake (a live `monsters` entry) reports empty
 * here — the Renderer draws that one at its real, moving position instead. */
export function animalAt(state: GameState, x: number, y: number): string | null {
  const t = state.world.tileAt(x, y);
  if (!t || !t.explored || t.node >= 0) return null;
  const biome = getBiome(t.biome);
  const isForest = biome.sprite === "forest" || biome.sprite === "jungle";
  const isGrass = biome.sprite === "grass";
  if (!isForest && !isGrass) return null;
  if (hash01(x, y, 7331) > 0.025) return null;
  const key = `${x},${y}`;
  if ((state.huntedAnimals[key] ?? 0) > state.tick) return null;
  if (state.monsters.some((m) => m.home.x === x && m.home.y === y)) return null;
  if (isForest && hash01(x, y, 7335) < RARE_FOREST_CHANCE) {
    return hash01(x, y, 7338) < ALPHA_SHARE_OF_RARE ? "alphawolf" : "bear";
  }
  const pool = isForest ? FOREST_ANIMALS : GRASS_ANIMALS;
  return pool[Math.floor(hash01(x, y, 7332) * pool.length)];
}

/** Nearest live animal tile within `range` of `from`, or null. */
export function findAnimalNear(
  state: GameState,
  from: Vec2,
  range: number,
): { x: number; y: number; kind: string } | null {
  const cx = Math.round(from.x);
  const cy = Math.round(from.y);
  let best: { x: number; y: number; kind: string } | null = null;
  let bestD = range;
  for (let y = cy - SCAN_RADIUS; y <= cy + SCAN_RADIUS; y++) {
    for (let x = cx - SCAN_RADIUS; x <= cx + SCAN_RADIUS; x++) {
      const kind = animalAt(state, x, y);
      if (!kind) continue;
      const d = Math.hypot(x - from.x, y - from.y);
      if (d <= bestD) {
        bestD = d;
        best = { x, y, kind };
      }
    }
  }
  return best;
}

/** The leader hunts whatever's closest in range (spec: chop/mine/attack
 * "when the player is in range") — a live, already-awake wolf/bear (if any)
 * takes priority over the static tile system, so a hit always lands on
 * whichever one the player is actually facing down. Wolves/bears (spec:
 * "2 shots") survive a first hit wounded. */
export function huntNearby(state: GameState, civ: Civ, bus: EventBus): CommandResult {
  const leader = civ.leader;
  if (!leader) return { ok: false, message: "" };

  let nearestMonster: Monster | null = null;
  let bestD = HUNT_RANGE;
  for (const m of state.monsters) {
    const d = Math.hypot(m.pos.x - leader.pos.x, m.pos.y - leader.pos.y);
    if (d <= bestD) {
      bestD = d;
      nearestMonster = m;
    }
  }
  if (nearestMonster) {
    const needed = HITS_TO_KILL[nearestMonster.kind] ?? 1;
    nearestMonster.wounds += 1;
    // A hit interrupts its own attack timer (spec: "easier to fight them
    // off") — striking first buys you a window it can't hit back in.
    nearestMonster.attackCooldown = Math.max(nearestMonster.attackCooldown, STAGGER_TICKS);
    if (nearestMonster.wounds < needed) {
      return { ok: true, message: `You wound the ${animalName(nearestMonster.kind)}!` };
    }
    const loot = killMonster(state, civ, nearestMonster, bus);
    return { ok: true, message: `Hunted ${article(nearestMonster.kind).toLowerCase()} ${animalName(nearestMonster.kind)} — ${loot}.` };
  }

  const found = findAnimalNear(state, leader.pos, HUNT_RANGE);
  if (!found) return { ok: false, message: "" };
  const key = `${found.x},${found.y}`;
  const needed = HITS_TO_KILL[found.kind] ?? 1;
  const wounds = (state.animalWounds[key] ?? 0) + 1;
  if (wounds < needed) {
    state.animalWounds[key] = wounds;
    return { ok: true, message: `You wound the ${animalName(found.kind)}!` };
  }
  delete state.animalWounds[key];
  const loot = grantHuntLoot(civ, found.kind);
  state.huntedAnimals[key] = state.tick + RESPAWN_TICKS;
  grantLeaderXp(civ, 3, bus);
  if (!civ.isAI) bus.emit({ type: "resourceChanged" });
  return { ok: true, message: `Hunted ${article(found.kind).toLowerCase()} ${animalName(found.kind)} — ${loot}.` };
}

/** Grants the base meat plus any kind-specific bonus loot (spec: "make the
 * bear drop extra loot"), returning a display string for the hunt toast. */
function grantHuntLoot(civ: Civ, kind: string): string {
  const totals: Partial<Record<ResourceId, number>> = { food: FOOD_PER_HUNT };
  const bonus = BONUS_LOOT[kind];
  if (bonus) {
    for (const [resource, amount] of Object.entries(bonus)) {
      totals[resource as ResourceId] = (totals[resource as ResourceId] ?? 0) + amount!;
    }
  }
  const parts: string[] = [];
  for (const [resource, amount] of Object.entries(totals)) {
    civ.add(resource as ResourceId, amount!);
    parts.push(`+${amount} ${resource}`);
  }
  return parts.join(", ");
}

function killMonster(state: GameState, civ: Civ, m: Monster, bus: EventBus): string {
  const key = `${m.home.x},${m.home.y}`;
  state.monsters = state.monsters.filter((x) => x.id !== m.id);
  const loot = grantHuntLoot(civ, m.kind);
  state.huntedAnimals[key] = state.tick + RESPAWN_TICKS;
  delete state.animalWounds[key];
  grantLeaderXp(civ, 3, bus);
  if (!civ.isAI) bus.emit({ type: "resourceChanged" });
  return loot;
}

/** Wakes any sleeping wolf/bear tile within DETECT_RANGE of this civ's
 * leader into a real, chasing `monsters` entry (spec: "chase the player").
 * Throttled at the call site — waking doesn't need checking every tick. */
export function wakeNearbyMonsters(state: GameState, civ: Civ): void {
  const leader = civ.leader;
  if (!leader) return;
  const cx = Math.round(leader.pos.x);
  const cy = Math.round(leader.pos.y);
  for (let y = cy - DETECT_RANGE; y <= cy + DETECT_RANGE; y++) {
    for (let x = cx - DETECT_RANGE; x <= cx + DETECT_RANGE; x++) {
      const kind = animalAt(state, x, y);
      if (!kind || !AGGRESSIVE_ANIMALS.has(kind)) continue;
      if (Math.hypot(x - leader.pos.x, y - leader.pos.y) > DETECT_RANGE) continue;
      const key = `${x},${y}`;
      state.monsters.push({
        id: state.nextMonsterId++,
        kind,
        pos: { x, y },
        home: { x, y },
        wounds: state.animalWounds[key] ?? 0,
        attackCooldown: 0,
        targetCiv: civ.id,
      });
      delete state.animalWounds[key];

      // Wolf packs (spec: "a wolf pack — multiple chasing one target") — a
      // waking wolf (or alpha) sometimes isn't alone. These packmates are
      // pure bonus encounters, not backed by their own hash-placed tile, so
      // they share the anchor's home (same respawn bookkeeping) and simply
      // vanish for good once killed or given up rather than respawning.
      if ((kind === "wolf" || kind === "alphawolf") && state.rng.chance(WOLF_PACK_CHANCE)) {
        const packSize = state.rng.int(WOLF_PACK_MIN, WOLF_PACK_MAX);
        for (let i = 0; i < packSize; i++) {
          state.monsters.push({
            id: state.nextMonsterId++,
            kind: "wolf",
            pos: { x: x + state.rng.range(-1.2, 1.2), y: y + state.rng.range(-1.2, 1.2) },
            home: { x, y },
            wounds: 0,
            attackCooldown: state.rng.int(0, ANIMAL_ATTACK_COOLDOWN / 2),
            targetCiv: civ.id,
          });
        }
      }
    }
  }
}

function nearestLeaderTarget(state: GameState, from: Vec2, range: number): { civ: Civ; dist: number } | null {
  let best: { civ: Civ; dist: number } | null = null;
  for (const civ of state.civs) {
    const leader = civ.leader;
    if (!leader) continue;
    const d = Math.hypot(leader.pos.x - from.x, leader.pos.y - from.y);
    if (d <= range && (!best || d < best.dist)) best = { civ, dist: d };
  }
  return best;
}

/** Moves every awake wolf/bear toward its target leader, attacks once
 * adjacent, and gives up (heading home, then vanishing) once nothing's
 * nearby or it's been dragged too far from where it woke up. Global, once
 * per tick — not per civ, since a monster only ever chases one target. */
export function updateMonsters(state: GameState, bus: EventBus): void {
  for (const m of [...state.monsters]) {
    const distFromHome = Math.hypot(m.pos.x - m.home.x, m.pos.y - m.home.y);
    const target = distFromHome <= LEASH_RANGE ? nearestLeaderTarget(state, m.pos, LEASH_RANGE) : null;

    if (!target) {
      m.targetCiv = null;
      const dx = m.home.x - m.pos.x, dy = m.home.y - m.pos.y;
      const d = Math.hypot(dx, dy);
      if (d < 0.15) {
        state.monsters = state.monsters.filter((x) => x.id !== m.id);
      } else {
        m.pos.x += (dx / d) * CHASE_SPEED;
        m.pos.y += (dy / d) * CHASE_SPEED;
      }
      continue;
    }

    m.targetCiv = target.civ.id;
    const leader = target.civ.leader!;

    // Companion interventions (spec: "cat scares wolfs and bears away at
    // night", "dogs hunt wolfs attacking the player").
    const buff = companionBuff(target.civ);
    const isNight = state.timeOfDay < 0.22 || state.timeOfDay > 0.78;
    if (buff === "cat" && isNight) {
      // The prowling cat spooks it — break off the hunt and slink home.
      m.targetCiv = null;
      const dx = m.home.x - m.pos.x, dy = m.home.y - m.pos.y;
      const d = Math.hypot(dx, dy) || 1;
      m.pos.x += (dx / d) * CHASE_SPEED;
      m.pos.y += (dy / d) * CHASE_SPEED;
      continue;
    }
    if (buff === "dog") {
      // The loyal hound harries the attacker, wearing it down until it drops.
      m.wounds += DOG_BITE_DAMAGE;
      if (m.wounds >= (HITS_TO_KILL[m.kind] ?? 1)) {
        if (!target.civ.isAI) {
          bus.emit({ type: "toast", text: `Your hound brings down ${article(m.kind).toLowerCase()} ${animalName(m.kind)}!` });
        }
        killMonster(state, target.civ, m, bus);
        continue;
      }
    }

    if (target.dist > ANIMAL_ATTACK_RANGE) {
      const dx = leader.pos.x - m.pos.x, dy = leader.pos.y - m.pos.y;
      const len = Math.hypot(dx, dy) || 1;
      m.pos.x += (dx / len) * CHASE_SPEED;
      m.pos.y += (dy / len) * CHASE_SPEED;
      if (m.attackCooldown > 0) m.attackCooldown--;
      continue;
    }

    if (m.attackCooldown > 0) {
      m.attackCooldown--;
      continue;
    }
    m.attackCooldown = ANIMAL_ATTACK_COOLDOWN;
    const dmg = ANIMAL_DAMAGE[m.kind] ?? 5;
    leader.health = Math.max(0, leader.health - dmg);
    if (!target.civ.isAI) {
      bus.emit({ type: "toast", text: `${article(m.kind)} ${animalName(m.kind)} attacks you! -${dmg} health.` });
    }
    if (leader.health <= 0) leaderFallsToWildlife(state, target.civ, m.kind, bus);
  }
}

/** The leader can die to wildlife same as in battle (see CombatSystem's
 * killCitizen). Unless the player opted into hardcore mode, a surviving
 * citizen steps up (spec: "leader death — implement a clear recovery flow")
 * instead of leaving a run-ending, unrecoverable civ — losing your leader to
 * a random wolf mid-explore is exactly the "unexpected" case that shouldn't
 * unfairly end a normal run. With no one left, or in hardcore mode, the civ
 * carries on leaderless (every UI element that reads civ.leader already
 * treats that as valid — see Hud.updateLeaderBar), which is what actually
 * ends the run (Game.ts watches for "started but no leader"). */
function leaderFallsToWildlife(state: GameState, civ: Civ, kind: string, bus: EventBus): void {
  const leader = civ.leader;
  if (!leader) return;
  civ.citizens = civ.citizens.filter((c) => c.id !== leader.id);
  const name = animalName(kind);
  state.log(`${leader.name} of ${civ.name} was slain by a ${name}.`);
  if (!civ.isAI) bus.emit({ type: "toast", text: `${leader.name} was slain by a ${name}!` });
  if (!civ.isAI && !state.hardcoreLeaderDeath && civ.citizens.length > 0) {
    promoteNewLeader(civ, bus);
  }
}
