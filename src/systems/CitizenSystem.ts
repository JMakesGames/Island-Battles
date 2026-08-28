// Citizen behaviour: assign work, move, gather, haul home, and build. Runs once
// per Civ (player and AI alike, spec §6). Resource nodes are shared across the
// isle, so civs naturally compete for them (spec §7) — a node claimed by any
// civ's gatherer is skipped by everyone else.
//
// The leader is different: for a HUMAN civ, the leader is the player's
// physical character (spec §5) and is never swept into the auto-worker pool —
// they only move where the player sends them (civ.leaderTarget, set by the
// setLeaderTarget command) and can trigger site discoveries by walking onto
// ruins/caves. An AI civ's leader still behaves like an autonomous citizen,
// since nobody is there to drive it manually.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { Citizen, Direction8, Vec2, ResourceId } from "../core/types.ts";
import type { EventBus } from "../core/events.ts";
import { getBiome, getCitizenTrait, getLeaderTrait } from "../game/config.ts";
import { grantBattlePassXp } from "./BattlePass.ts";
import { gatherToolMult } from "./Blacksmith.ts";
import { MOUNT_SPEED_MULT } from "./CombatSystem.ts";
import { companionSpeedMult, companionRevealBonus } from "./Companions.ts";
import { moveWithCollision } from "./BuildingSystem.ts";
import { forecastEconomy } from "./SurvivalSystem.ts";

const CARRY_CAP = 8;
const GATHER_PER_TICK = 0.12;
const BASE_SPEED = 0.05; // tiles per tick before biome modifier
const REACH = 0.5;
const FARM_CAP = 3; // max citizens boosting any one farm's output
const ROLE_RESOURCE: Record<string, ResourceId[]> = {
  woodcutter: ["wood"],
  miner: ["stone", "iron", "crystal"],
  fisherman: ["water"],
};

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function walkSpeedAt(state: GameState, pos: Vec2): number {
  const t = state.world.tileAt(Math.round(pos.x), Math.round(pos.y));
  if (!t) return BASE_SPEED;
  const road = t.road ? 1.35 : 1; // roads speed movement (spec §9)
  return BASE_SPEED * Math.max(0.35, getBiome(t.biome).walkSpeed) * road;
}

// Clockwise from +x (world x increases right, y increases down), matching
// the extracted 8-frame walk sheet's row order (render/ImageSpriteAtlas.ts).
const DIR_RING: Direction8[] = ["right", "downright", "down", "downleft", "left", "upleft", "up", "upright"];

function directionFromDelta(dx: number, dy: number): Direction8 {
  const angle = Math.atan2(dy, dx);
  const idx = (Math.round(angle / (Math.PI / 4)) + 8) % 8;
  return DIR_RING[idx];
}

function moveToward(state: GameState, c: Citizen, target: Vec2, speedMult = 1): boolean {
  const d = dist(c.pos, target);
  if (d <= REACH) return true;
  const spd = walkSpeedAt(state, c.pos) * speedMult;
  const dx = target.x - c.pos.x;
  const dy = target.y - c.pos.y;
  if (Math.hypot(dx, dy) > 0.05) c.facing = directionFromDelta(dx, dy);
  // Walls block movement (spec: "make walls actually block/slow
  // movement") — a hard stop, not pathfinding; see moveWithCollision.
  moveWithCollision(state, c.pos, (dx / d) * spd, (dy / d) * spd);
  return false;
}

/** A citizen's gather output per tick, scaled by skill + traits + owned
 * Blacksmith tools (spec: "buy axes, pick axes... " — axes/pickaxes speed up
 * gathering the resource they're forged for). */
function gatherRate(c: Citizen, civ: Civ, resource: ResourceId): number {
  let mult = 0.6 + (c.skill / 100) * 0.9; // skill 0 -> 0.6x, 100 -> 1.5x
  for (const id of c.traits) {
    const t = getCitizenTrait(id);
    if (t?.gatherMult) mult *= t.gatherMult;
  }
  mult *= gatherToolMult(civ, resource);
  return GATHER_PER_TICK * mult;
}

/** The leader sees further; the Explorer trait extends it further still (spec §5). */
function revealRadius(civ: Civ, c: Citizen): number {
  if (!c.isLeader) return 3.5;
  let r = 6;
  for (const id of civ.leaderTraits) r += getLeaderTrait(id)?.revealBonus ?? 0;
  r += companionRevealBonus(civ); // the keen hawk scouts further (spec)
  return r;
}

/** Practicing a trade slowly builds skill and experience (spec §6). */
function gainExperience(c: Citizen, amount: number): void {
  let mult = 1;
  for (const id of c.traits) mult *= getCitizenTrait(id)?.xpMult ?? 1;
  c.experience += amount * mult;
  c.skill = Math.min(100, c.skill + amount * mult * 0.4);
}

/** Node indices currently claimed by any citizen of any civ (contested world). */
export function globalClaims(state: GameState): Set<number> {
  const claimed = new Set<number>();
  for (const civ of state.civs) {
    for (const c of civ.citizens) if (c.workNode >= 0) claimed.add(c.workNode);
  }
  return claimed;
}

/** Nearest node an idle citizen should pick up. Ponds hold ~999 water and
 * never deplete, so if one is simply the closest node a worker would camp
 * on it forever — gather 8, haul home, go idle, pick the same pond again —
 * and never once touch the wood/stone that buildings actually need (bug:
 * "the building still does not work" — the real cause was every worker
 * stuck shuttling water). Finite resources are always preferred; water is
 * only picked when nothing else depletable is in reach. */
function findNearestNode(state: GameState, from: Vec2, claimed: Set<number>): number {
  let best = -1;
  let bestD = Infinity;
  let bestWater = -1;
  let bestWaterD = Infinity;
  for (let i = 0; i < state.world.nodes.length; i++) {
    const n = state.world.nodes[i];
    if (n.remaining <= 0 || claimed.has(i)) continue;
    const d = dist(from, n.tile);
    if (n.resource === "water") {
      if (d < bestWaterD) {
        bestWaterD = d;
        bestWater = i;
      }
      continue;
    }
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best >= 0 ? best : bestWater;
}

function findNearestNodeOfResource(
  state: GameState,
  from: Vec2,
  resources: readonly string[],
  claimed: Set<number>,
): number {
  let best = -1;
  let bestD = Infinity;
  for (let i = 0; i < state.world.nodes.length; i++) {
    const n = state.world.nodes[i];
    if (n.remaining <= 0 || claimed.has(i) || !resources.includes(n.resource)) continue;
    const d = dist(from, n.tile);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

const INTERACT_RANGE = 1.5;
const INTERACT_GATHER_AMOUNT = 6;

/** The leader chops/mines/forages directly (spec: "when the player is in
 * range of a tree they can chop down the tree for wood, same thing for
 * stone") — an instant, one-off take from whatever node is closest in
 * range, on top of (not instead of) assigning a citizen to work it. */
export function gatherNearbyNode(state: GameState, civ: Civ): { ok: boolean; message: string } {
  const leader = civ.leader;
  if (!leader) return { ok: false, message: "" };
  let best = -1;
  let bestD = INTERACT_RANGE;
  for (let i = 0; i < state.world.nodes.length; i++) {
    const n = state.world.nodes[i];
    if (n.remaining <= 0) continue;
    const d = dist(leader.pos, n.tile);
    if (d <= bestD) {
      bestD = d;
      best = i;
    }
  }
  if (best < 0) return { ok: false, message: "" };
  const node = state.world.nodes[best];
  // One interact = one node, full stop (bug: this used to only take a 6-unit
  // bite per hit, so mashing the interact key on a single tree could drain
  // its whole 60-wood pool in ~10 rapid hits, then spill onto the next tree
  // over — reading as "one tree gave 180 wood"). Consuming the entire node
  // for a flat reward makes "one tree = one chop = 6 wood" literally true.
  node.remaining = 0;
  const amount = Math.round(INTERACT_GATHER_AMOUNT * gatherToolMult(civ, node.resource));
  civ.add(node.resource, amount);
  gainExperience(leader, amount * 0.5);
  return { ok: true, message: `Gathered ${amount} ${node.resource}.` };
}

function findBuildSite(civ: Civ): number {
  const claimed = new Set(civ.citizens.map((c) => c.buildTarget).filter((b) => b >= 0));
  for (let i = 0; i < civ.buildings.length; i++) {
    if (!civ.buildings[i].complete && !claimed.has(i)) return i;
  }
  for (let i = 0; i < civ.buildings.length; i++) {
    if (!civ.buildings[i].complete) return i; // allow a second builder to help
  }
  return -1;
}

/** Re-targets a citizen at their own `assignedRole`'s work, the same
 * targeting logic assignRole uses for a manual pick — used when a locked
 * citizen's current task runs out (spec: "job locking so the player can
 * choose whether a citizen's job can be automatically changed"). Locking
 * means "only this role, or wait" rather than "whatever's globally
 * nearest," so unlike the generic idle fallback this never touches build
 * sites or resources outside the citizen's own role. Returns false (leaving
 * the citizen idle) if nothing matching is available right now. */
function tryReacquireRole(state: GameState, civ: Civ, c: Citizen, claimed: Set<number>): boolean {
  const role = c.assignedRole;
  if (!role) return false;
  if (role === "builder") {
    const site = findBuildSite(civ);
    if (site < 0) return false;
    c.job = "build";
    c.buildTarget = site;
    c.buildTargetCiv = undefined;
    c.workNode = -1;
    return true;
  }
  if (role === "soldier") {
    c.job = "guard";
    c.workNode = -1;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return true;
  }
  if (role === "archer") {
    c.job = "archer";
    c.workNode = -1;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return true;
  }
  if (role === "farmer") {
    let bestFarm = -1;
    let bestD = Infinity;
    for (let i = 0; i < civ.buildings.length; i++) {
      const b = civ.buildings[i];
      if (b.id !== "farm" || !b.complete) continue;
      const assigned = civ.citizens.filter((x) => x.job === "farm" && x.buildTarget === i).length;
      if (assigned >= FARM_CAP) continue;
      const d = dist(c.pos, b.tile);
      if (d < bestD) {
        bestD = d;
        bestFarm = i;
      }
    }
    if (bestFarm >= 0) {
      c.job = "farm";
      c.buildTarget = bestFarm;
      c.buildTargetCiv = undefined;
      c.workNode = -1;
      return true;
    }
    const node = findNearestNodeOfResource(state, c.pos, ["food"], claimed);
    if (node < 0) return false;
    c.job = "gather";
    c.workNode = node;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    claimed.add(node);
    return true;
  }
  const resources = ROLE_RESOURCE[role];
  if (!resources) return false;
  const node = findNearestNodeOfResource(state, c.pos, resources, claimed);
  if (node < 0) return false;
  c.job = "gather";
  c.workNode = node;
  c.buildTarget = -1;
  c.buildTargetCiv = undefined;
  claimed.add(node);
  return true;
}

/** Manual leader movement + site discovery (spec §5, §13). Returns true if a
 * previously-undiscovered site was just reached this tick. */
const LEADER_SPEED_MULT = 1.5; // the player-controlled leader moves faster than auto-walking citizens

/** The manually-driven leader's pure movement step — held-key steering or
 * click-to-walk — with no site-discovery side effect, so it's safe to also
 * run purely LOCALLY on a multiplayer client for input prediction (see
 * Game.ts's predictLeaderStep): the server is the only place that may ever
 * discover a site, but movement math is just math, and running the exact
 * same formula client-side the instant a key is pressed — instead of
 * waiting for the round trip to the server and the next throttled snapshot
 * — is what actually fixes "my inputs felt delayed" in real multiplayer
 * (bug report). Returns the target to keep tracking (null once reached, so
 * callers know to stop). */
export function moveLeaderManual(
  state: GameState,
  civ: Civ,
  c: Citizen,
  moveDir: Vec2 | null,
  target: Vec2 | null,
): Vec2 | null {
  // Cavalry (spec: "the mount cosmetics... purely visual, no mechanical
  // benefit") — a real speed edge on top of the base leader boost, not just
  // a different sprite riding along.
  const mountMult = civ.wallet.equipped.MOUNTS ? MOUNT_SPEED_MULT : 1;
  // Companion speed buffs (spec: warhorse always faster, dragon +50% when
  // badly hurt) stack multiplicatively on top of the mount cosmetic.
  const speedMult = LEADER_SPEED_MULT * mountMult * companionSpeedMult(civ);
  if (moveDir) {
    // Held-key steering (spec: smooth walking): a constant unit vector
    // applied every tick, not a lookahead waypoint the client has to keep
    // re-aiming. Both axes are normalized together up front (see
    // Simulation's setLeaderMove handler), so every one of the 8 directions
    // — including diagonals — covers exactly the same distance per tick.
    const spd = walkSpeedAt(state, c.pos) * speedMult;
    moveWithCollision(state, c.pos, moveDir.x * spd, moveDir.y * spd);
    c.facing = directionFromDelta(moveDir.x, moveDir.y);
    return target;
  }
  if (target) {
    return moveToward(state, c, target, speedMult) ? null : target;
  }
  return target;
}

function updateLeaderManual(state: GameState, civ: Civ, c: Citizen, bus: EventBus): void {
  civ.leaderTarget = moveLeaderManual(state, civ, c, civ.leaderMoveDir, civ.leaderTarget);
  const t = state.world.tileAt(Math.round(c.pos.x), Math.round(c.pos.y));
  if (t && t.site >= 0) {
    const site = state.world.sites[t.site];
    if (!site.discovered) {
      site.discovered = true;
      bus.emit({ type: "eventTriggered", eventId: site.eventId, civ: civ.id });
    }
  }
}

export function updateCitizens(
  state: GameState,
  civ: Civ,
  bus: EventBus,
  ticks: number,
  revealFog: boolean,
  // Node claims across every civ's citizens, shared across this whole
  // Simulation tick's civ loop rather than rebuilt per civ — a full
  // O(all citizens) scan repeated once per civ was pure waste (perf pass:
  // "repeated searches through all citizens"). Callers that don't care
  // (tests, etc.) can omit it and pay the old per-call cost.
  claimedIn?: Set<number>,
): void {
  if (!civ.home) return;
  const home = civ.home;

  for (let step = 0; step < ticks; step++) {
    const claimed = claimedIn ?? globalClaims(state);
    for (const c of civ.citizens) {
      // Only the player's citizens lift the player's fog of war (spec §13).
      if (revealFog) state.world.reveal(c.pos.x, c.pos.y, revealRadius(civ, c));

      if (c.isLeader && !civ.isAI) {
        // Player-driven, but not exclusively manual anymore (spec: "the
        // player should also be able to do Jobs") — WASD/click-to-walk
        // always wins the tick it's actively steering them; only once
        // there's no live manual target does an assigned job (from the job
        // menu, same as any citizen) get to run. Idle stays purely manual —
        // nothing gets auto-assigned to the leader.
        const wasWalking = !!civ.leaderTarget || !!civ.leaderMoveDir;
        updateLeaderManual(state, civ, c, bus);
        if (wasWalking || c.job === "idle") continue;
        // else: no live manual target and a job is assigned — fall through
        // to the same switch every other citizen uses.
      }
      // AI civs' leaders fall through here too, same as any other citizen —
      // nobody is there to drive them manually (see file header).

      switch (c.job) {
        case "idle": {
          // Job locking (spec: "let the player choose whether a citizen's
          // job can be automatically changed") — a locked citizen only ever
          // retries their own assigned role, never the generic pick below,
          // and simply waits if that role has nothing available right now.
          if (c.jobLocked && c.assignedRole) {
            tryReacquireRole(state, civ, c, claimed);
            break;
          }
          // Automation modes (spec: "Manual, Smart Automation, Full
          // Automation"). Manual: idle citizens do nothing on their own.
          if (civ.automationMode === "manual") break;
          // Smart/Full: an unlocked citizen with a role still prefers going
          // back to it (a woodcutter whose tree just gave out should look
          // for another tree first, not drift to whatever's globally
          // nearest) before falling back to the fully generic pick.
          if (c.assignedRole && tryReacquireRole(state, civ, c, claimed)) break;
          // Full automation additionally steers idle citizens toward
          // whichever survival resource is in the worse deficit, so a
          // settlement drifting toward a food/water shortage self-corrects
          // without the player having to notice and reassign it manually.
          if (civ.automationMode === "full") {
            const econ = forecastEconomy(civ, state.season);
            const worst = econ.food.netPerDay <= econ.water.netPerDay ? "food" : "water";
            if (econ[worst].netPerDay < 0) {
              const role = worst === "food" ? "farmer" : "fisherman";
              const prevRole = c.assignedRole;
              c.assignedRole = role;
              if (tryReacquireRole(state, civ, c, claimed)) break;
              c.assignedRole = prevRole; // nothing available right now — don't mislabel them
            }
          }
          const site = findBuildSite(civ);
          if (site >= 0) {
            c.job = "build";
            c.buildTarget = site;
            c.buildTargetCiv = undefined;
          } else {
            const node = findNearestNode(state, c.pos, claimed);
            if (node >= 0) {
              c.job = "gather";
              c.workNode = node;
              claimed.add(node);
            }
          }
          break;
        }
        case "gather": {
          const node = state.world.nodes[c.workNode];
          if (!node || node.remaining <= 0) {
            c.job = "idle";
            c.workNode = -1;
            break;
          }
          if (moveToward(state, c, node.tile)) {
            const rate = gatherRate(c, civ, node.resource);
            const take = Math.min(rate, node.remaining, CARRY_CAP - (c.carry?.amount ?? 0));
            node.remaining -= take;
            c.carry = { resource: node.resource, amount: (c.carry?.amount ?? 0) + take };
            gainExperience(c, take * 0.5);
            if (c.carry.amount >= CARRY_CAP || node.remaining <= 0) {
              c.job = "haul";
              c.workNode = -1;
            }
          }
          break;
        }
        case "haul": {
          if (moveToward(state, c, home)) {
            if (c.carry) {
              civ.add(c.carry.resource, Math.round(c.carry.amount));
              if (!civ.isAI) bus.emit({ type: "resourceChanged" });
              c.carry = null;
            }
            c.job = "idle";
          }
          break;
        }
        case "build": {
          // Joint building (spec: "joint building for allied civs") — a
          // citizen can be helping an ally's construction instead of their
          // own; ends the moment the alliance does, same as a citizen
          // recalled from a broken war truce elsewhere in this file.
          const targetCiv = c.buildTargetCiv != null ? state.civs[c.buildTargetCiv] : civ;
          const alliedOk = c.buildTargetCiv == null || state.relations.stance(civ.id, c.buildTargetCiv) === "alliance";
          const b = targetCiv?.buildings[c.buildTarget];
          if (!targetCiv || !b || b.complete || !alliedOk) {
            c.job = "idle";
            c.buildTarget = -1;
            c.buildTargetCiv = undefined;
            break;
          }
          if (moveToward(state, c, b.tile)) {
            b.buildRemaining -= 1;
            gainExperience(c, 0.3);
            if (b.buildRemaining <= 0) {
              b.buildRemaining = 0;
              b.complete = true;
              if (!targetCiv.isAI) bus.emit({ type: "buildingComplete", id: b.id });
              grantBattlePassXp(civ, 20, bus); // spec §25 — reward goes to whoever's citizen did the work
              c.job = "idle";
              c.buildTarget = -1;
              c.buildTargetCiv = undefined;
            }
          }
          break;
        }
        case "farm": {
          // Assigned farmhand (spec: "add farming"): a farm building already
          // produces food passively every day (SurvivalSystem sums
          // foodPerDay across complete buildings) — this is the player
          // choosing to put a citizen's labor into boosting one specific
          // farm's output, tracked as a per-day bonus in SurvivalSystem
          // rather than a per-tick action here. Once a farmer reaches their
          // assigned farm they just stay there working.
          const b = civ.buildings[c.buildTarget];
          if (!b || b.id !== "farm" || !b.complete) {
            c.job = "idle";
            c.buildTarget = -1;
            break;
          }
          moveToward(state, c, b.tile);
          break;
        }
        case "guard":
        case "archer": {
          // Assigned soldier (spec: "add soldiers", "when I declare war...
          // they should battle") — archers (spec: "unit variety... archers")
          // march and hold the line exactly like a guard; only their range
          // and damage differ, entirely in CombatSystem. Already engaged?
          // CombatSystem drives their
          // position every tick while attackCiv is set — moving them here
          // too would fight that movement and jitter them in place.
          if (c.attackCiv !== undefined) break;
          // Otherwise, at war means marching on the enemy instead of idly
          // guarding: find a war target whose home is known (AI civs plan on
          // full knowledge already; a human's guards need the enemy
          // discovered first, same fog rule AI discovery uses elsewhere) and
          // head there — CombatSystem's engage-radius picks the fight up
          // automatically the moment an enemy is close enough. No known war
          // target just means "hold the line" near home, same as before.
          let marchTarget = home;
          for (const other of state.civs) {
            if (other.id === civ.id || !other.home) continue;
            if (state.relations.stance(civ.id, other.id) !== "war") continue;
            if (civ.isAI || other.ai?.discoveredByPlayer) {
              marchTarget = other.home;
              break;
            }
          }
          moveToward(state, c, marchTarget);
          break;
        }
        case "explore":
          break;
      }
    }
  }
}

export interface CommandResult {
  ok: boolean;
  message: string;
}

/**
 * Manual job assignment (spec §6): override a citizen's auto-picked work.
 * Clicking a resource node sends them gathering it; an unfinished building of
 * their own civ sends them building it; anywhere else just clears their
 * current task and lets the auto-worker AI take back over next tick.
 */
export function commandCitizen(state: GameState, civ: Civ, citizenId: number, tile: Vec2): CommandResult {
  const c = civ.citizens.find((x) => x.id === citizenId);
  if (!c) return { ok: false, message: "That citizen is no longer here." };
  if (c.isLeader) return { ok: false, message: "The leader is controlled directly — click the map to walk." };

  const tx = Math.round(tile.x);
  const ty = Math.round(tile.y);
  const t = state.world.tileAt(tx, ty);
  if (!t) return { ok: false, message: "That's off the island." };

  if (t.node >= 0 && state.world.nodes[t.node].remaining > 0) {
    c.job = "gather";
    c.workNode = t.node;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return { ok: true, message: `${c.name} is heading to gather.` };
  }

  const bIdx = civ.buildings.findIndex((b) => !b.complete && b.tile.x === tx && b.tile.y === ty);
  if (bIdx >= 0) {
    c.job = "build";
    c.buildTarget = bIdx;
    c.buildTargetCiv = undefined;
    c.workNode = -1;
    return { ok: true, message: `${c.name} is heading to build.` };
  }

  // Joint building (spec: "shared vision/joint building for allied civs in
  // multiplayer") — an ally's unfinished building on this tile can be
  // helped along too, not just your own. Ends automatically the moment the
  // alliance does (see the "build" case's alliedOk check below).
  for (const other of state.civs) {
    if (other.id === civ.id) continue;
    if (state.relations.stance(civ.id, other.id) !== "alliance") continue;
    const allyIdx = other.buildings.findIndex((b) => !b.complete && b.tile.x === tx && b.tile.y === ty);
    if (allyIdx >= 0) {
      c.job = "build";
      c.buildTarget = allyIdx;
      c.buildTargetCiv = other.id;
      c.workNode = -1;
      return { ok: true, message: `${c.name} rushes to help ${other.name} build.` };
    }
  }

  const farmIdx = civ.buildings.findIndex((b) => b.id === "farm" && b.complete && b.tile.x === tx && b.tile.y === ty);
  if (farmIdx >= 0) {
    const assigned = civ.citizens.filter((x) => x.job === "farm" && x.buildTarget === farmIdx).length;
    if (assigned < FARM_CAP) {
      c.job = "farm";
      c.buildTarget = farmIdx;
      c.buildTargetCiv = undefined;
      c.workNode = -1;
      return { ok: true, message: `${c.name} is heading to farm.` };
    }
    return { ok: false, message: "That farm already has enough hands." };
  }

  // Nothing to do there — release them back to the auto-worker AI.
  c.job = "idle";
  c.workNode = -1;
  c.buildTarget = -1;
  c.buildTargetCiv = undefined;
  return { ok: true, message: `${c.name} will pick their own task.` };
}

export type JobRole = "idle" | "farmer" | "woodcutter" | "miner" | "fisherman" | "builder" | "soldier" | "archer";

/** Job locking toggle (spec §3: "the player should be able to choose
 * whether a citizen's job can be automatically changed"). */
export function setJobLock(civ: Civ, citizenId: number, locked: boolean): CommandResult {
  const c = civ.citizens.find((x) => x.id === citizenId);
  if (!c) return { ok: false, message: "That citizen is no longer here." };
  if (locked && !c.assignedRole) {
    return { ok: false, message: "Assign a duty first, then lock it." };
  }
  c.jobLocked = locked;
  return { ok: true, message: locked ? `${c.name}'s duty is locked in.` : `${c.name}'s duty can be reassigned freely.` };
}

/** Civ-wide automation mode (spec: "Manual, Smart Automation, Full
 * Automation"). Never overrides a jobLocked citizen either way. */
export function setAutomationMode(civ: Civ, mode: "manual" | "smart" | "full"): CommandResult {
  civ.automationMode = mode;
  const label = mode === "manual" ? "Manual" : mode === "full" ? "Full Automation" : "Smart Automation";
  return { ok: true, message: `Automation set to ${label}.` };
}

/**
 * The job menu's direct role picker (spec: "add a job menu... pick the job
 * they want"), as an alternative to clicking a specific tile — the server
 * finds a sensible target for the chosen role itself, same server-
 * authoritative pattern as every other command.
 */
export function assignRole(state: GameState, civ: Civ, citizenId: number, role: JobRole): CommandResult {
  const c = civ.citizens.find((x) => x.id === citizenId);
  if (!c) return { ok: false, message: "That citizen is no longer here." };
  // Unlike commandCitizen (tile clicks always mean "leader, walk here"), the
  // job menu is allowed to put the leader to work too (spec: "the player
  // should also be able to do Jobs") — WASD/click-to-walk still always takes
  // priority the moment the player steers them (see CitizenSystem's tick).

  if (role === "idle") {
    c.job = "idle";
    c.workNode = -1;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return { ok: true, message: `${c.name} will pick their own task.` };
  }

  if (role === "soldier") {
    c.job = "guard";
    c.workNode = -1;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return { ok: true, message: `${c.name} is standing guard.` };
  }

  if (role === "archer") {
    c.job = "archer";
    c.workNode = -1;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return { ok: true, message: `${c.name} takes up a bow.` };
  }

  if (role === "builder") {
    const site = findBuildSite(civ);
    if (site < 0) return { ok: false, message: "Nothing to build right now." };
    c.job = "build";
    c.buildTarget = site;
    c.buildTargetCiv = undefined;
    c.workNode = -1;
    return { ok: true, message: `${c.name} is heading to build.` };
  }

  if (role === "farmer") {
    let bestFarm = -1;
    let bestD = Infinity;
    for (let i = 0; i < civ.buildings.length; i++) {
      const b = civ.buildings[i];
      if (b.id !== "farm" || !b.complete) continue;
      const assigned = civ.citizens.filter((x) => x.job === "farm" && x.buildTarget === i).length;
      if (assigned >= FARM_CAP) continue;
      const d = dist(c.pos, b.tile);
      if (d < bestD) {
        bestD = d;
        bestFarm = i;
      }
    }
    if (bestFarm >= 0) {
      c.job = "farm";
      c.buildTarget = bestFarm;
      c.buildTargetCiv = undefined;
      c.workNode = -1;
      return { ok: true, message: `${c.name} is heading to farm.` };
    }
    const claimed = globalClaims(state);
    const node = findNearestNodeOfResource(state, c.pos, ["food"], claimed);
    if (node < 0) return { ok: false, message: "Build a Farm, or find food nodes nearby." };
    c.job = "gather";
    c.workNode = node;
    c.buildTarget = -1;
    c.buildTargetCiv = undefined;
    return { ok: true, message: `${c.name} is heading to gather food.` };
  }

  const claimed = globalClaims(state);
  const node = findNearestNodeOfResource(state, c.pos, ROLE_RESOURCE[role], claimed);
  if (node < 0) return { ok: false, message: "No suitable resource found nearby." };
  c.job = "gather";
  c.workNode = node;
  c.buildTarget = -1;
  c.buildTargetCiv = undefined;
  return { ok: true, message: `${c.name} is heading to gather.` };
}
