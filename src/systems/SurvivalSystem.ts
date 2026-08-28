// Runs once per in-game day for every civ: production, consumption, seasons,
// morale, growth (spec §8 survival, §6 citizens). Seasons are shared world state;
// everything else is per-civ. Player-facing threats are telegraphed via toasts so
// a loss always feels preventable (spec §8).

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { getBuilding, getLeaderTrait, Resources } from "../game/config.ts";
import { techBonus } from "./TechSystem.ts";
import { grantLeaderXp } from "./LeaderSystem.ts";
import { grantBattlePassXp } from "./BattlePass.ts";
import type { Season, Stockpile } from "../core/types.ts";

// Hunger pacing (spec: "citizens are able to eat instead of going hungry").
// A citizen gains this much hunger per day; one meal wipes it clean. At 45/day
// it takes roughly three foodless days (0 → 45 → 90 → capped 100) before
// anyone actually starves — enough slack that a short shortage isn't fatal.
const HUNGER_PER_DAY = 45;
const MEAL_RELIEF = 100;
// Pressing "T" has the leader eat: a meal that also patches them up a little,
// so food doubles as battlefield rations (spec: "when the player clicks T
// they can eat as well").
const LEADER_EAT_HEAL = 15;

// Farms yield less as the year turns cold (spec §8: "Seasons affect production").
const SEASON_FARM_MULT: Record<Season, number> = {
  spring: 1.0,
  summer: 1.2,
  autumn: 0.7,
  winter: 0.25,
};

// Winter exposure (spec: "seasonal hazards with real teeth... chip away at
// exposed citizens") — on top of the farm penalty above, anyone your
// housing can't cover takes real cold damage each winter day. A real reason
// to keep housing ahead of population, not just a render-only season.
const WINTER_EXPOSURE_DAMAGE = 4;

// Aging & succession (spec: "named citizen persistence — aging, eventually
// retire/die of old age, and a named heir carries the family forward").
// 1 in-game day = 1 year (see Citizen.age) — past OLD_AGE_START the risk of
// a peaceful death climbs each year, capped well short of certain.
const OLD_AGE_START = 65;
const OLD_AGE_DEATH_STEP = 0.03;
const OLD_AGE_DEATH_CAP = 0.4;

function sumProvides(civ: Civ, key: string): number {
  let total = 0;
  for (const b of civ.buildings) {
    if (!b.complete) continue;
    const v = getBuilding(b.id).provides[key];
    if (typeof v === "number") total += v;
  }
  return total;
}

function advanceCivDay(state: GameState, civ: Civ, bus: EventBus, season: Season): void {
  if (!civ.started || !civ.home) return;

  // Chronicle-worthy stat (spec §15): highest population this civ ever reached.
  civ.peakPopulation = Math.max(civ.peakPopulation, civ.citizens.length);

  // Aging & succession — resolved before production/consumption below so a
  // death-and-heir this same day is reflected in today's population count.
  for (const c of [...civ.citizens]) {
    c.age += 1;
    if (c.isLeader || c.age <= OLD_AGE_START) continue;
    const deathChance = Math.min(OLD_AGE_DEATH_CAP, (c.age - OLD_AGE_START) * OLD_AGE_DEATH_STEP);
    if (!state.rng.chance(deathChance)) continue;
    civ.citizens = civ.citizens.filter((x) => x.id !== c.id);
    if (civ.home) {
      const heir = civ.spawnCitizen(civ.home, false, c.name);
      state.log(`${c.name} passed peacefully at ${c.age}. Their kin ${heir.name} joins the settlement.`);
      if (!civ.isAI) {
        bus.emit({ type: "toast", text: `${c.name} lived a long life — ${heir.name} carries the family forward.` });
      }
    } else {
      state.log(`${c.name} passed peacefully at ${c.age}.`);
    }
  }

  // Production from completed buildings, plus researched/trait bonuses.
  const farmMult = techBonus(civ, "farmYield") > 0 ? 1.5 : 1;
  // Assigned farmhands (spec: "add farming" — a citizen the player put to
  // work at a specific farm, via the job menu or clicking the farm tile
  // directly) add on top of the farm's own passive output, same seasonal
  // swing as the rest of food production.
  const assignedFarmers = civ.citizens.filter((c) => c.job === "farm").length;
  const farmFood = (sumProvides(civ, "foodPerDay") + assignedFarmers * 4) * SEASON_FARM_MULT[season] * farmMult;
  const wellWater = sumProvides(civ, "waterPerDay");
  if (farmFood > 0) civ.add("food", farmFood);
  if (wellWater > 0) civ.add("water", wellWater);

  // Knowledge income (spec §10): libraries, plus a Scholar leader's own study.
  let knowledgePerDay = sumProvides(civ, "knowledgePerDay");
  for (const id of civ.leaderTraits) knowledgePerDay += getLeaderTrait(id)?.knowledgePerDay ?? 0;
  if (knowledgePerDay > 0) civ.add("knowledge", knowledgePerDay);

  // Temples lift morale civilization-wide (spec §9).
  const moraleFromBuildings = sumProvides(civ, "moralePerDay");

  // Consumption. Water (and any other flat daily-drain resource) is a civ-wide
  // drain; food is handled through the per-citizen hunger loop below so people
  // visibly "eat" from the granary rather than the stock silently evaporating.
  const pop = civ.citizens.length;
  let thirsty = false;
  for (const res of Resources) {
    if (res.id === "food") continue; // food handled via hunger/eating, below
    const per = res.consumedPerCitizenPerDay ?? 0;
    if (per <= 0) continue;
    const need = per * pop;
    const have = civ.stock[res.id] ?? 0;
    if (have >= need) civ.add(res.id, -need);
    else {
      civ.add(res.id, -have);
      if (res.id === "water") thirsty = true;
    }
  }

  // Eating (spec: "make it so citizens are able to eat instead of them going
  // hungry"). Every citizen grows hungrier each day; if there's food in store
  // they sit down to a meal — spend one food and their hunger is sated. Only
  // someone who is already hungry AND finds nothing to eat actually starves
  // and loses health, so a settlement can weather a lean day or two instead
  // of everyone taking damage the instant the granary dips.
  let anyStarving = false;
  for (const c of civ.citizens) {
    c.hunger = Math.min(100, c.hunger + HUNGER_PER_DAY);
    if (c.hunger > 0 && (civ.stock.food ?? 0) >= 1) {
      civ.add("food", -1); // a meal
      c.hunger = Math.max(0, c.hunger - MEAL_RELIEF);
      c.health = Math.min(100, c.health + 2);
    } else if (c.hunger >= 100) {
      c.health = Math.max(0, c.health - 8); // truly starving — nothing to eat
      anyStarving = true;
    }
  }

  // Winter exposure (spec: "seasonal hazards... chip away at exposed
  // citizens") — whoever your housing can't cover takes cold damage; a
  // well-housed civ is fully sheltered and takes none. Proportional risk
  // per citizen rather than an all-or-nothing hit, so a settlement just
  // shy of enough housing isn't punished as harshly as a fully homeless one.
  if (season === "winter" && civ.housing < pop) {
    const exposedShare = (pop - civ.housing) / pop;
    let anyExposed = false;
    for (const c of civ.citizens) {
      if (state.rng.chance(exposedShare)) {
        c.health = Math.max(0, c.health - WINTER_EXPOSURE_DAMAGE);
        anyExposed = true;
      }
    }
    if (anyExposed && !civ.isAI) {
      bus.emit({ type: "toast", text: "Winter's cold bites at those without shelter — build more housing." });
    }
  }

  // Morale swings on whether the settlement is fed and watered.
  if (anyStarving || thirsty) {
    civ.morale = Math.max(0, civ.morale - 8 + moraleFromBuildings);
    if (!civ.isAI) {
      bus.emit({
        type: "toast",
        text: anyStarving
          ? "Your people are starving — find more food!"
          : "Your people are parched — they need water!",
      });
    }
  } else {
    civ.morale = Math.min(100, civ.morale + 2 + moraleFromBuildings);
  }
  // Citizens' loyalty drifts toward the civ's morale — happy settlements keep
  // their people (spec §6 loyalty). Birth-trait loyaltyBonus already biases
  // their starting value (see Civ.spawnCitizen); this is just the daily pull.
  for (const c of civ.citizens) {
    c.morale = civ.morale;
    const pull = (civ.morale - c.loyalty) * 0.1;
    c.loyalty = Math.max(0, Math.min(100, c.loyalty + pull));
  }

  // The leader gains a trickle of experience just for leading (spec §5).
  if (civ.leader) grantLeaderXp(civ, 4, bus);

  // Battle Pass XP (spec §25): a small trickle just for surviving the day.
  grantBattlePassXp(civ, 10, bus);

  // Growth: recruit when fed, watered and housed (spec §6).
  const fed = (civ.stock.food ?? 0) > pop * 3;
  const watered = (civ.stock.water ?? 0) > pop * 3;
  if (fed && watered && civ.housing > pop && civ.morale > 50) {
    if (state.rng.chance(0.5)) {
      const c = civ.spawnCitizen(civ.home);
      if (!civ.isAI) {
        bus.emit({ type: "citizenRecruited", name: c.name });
        state.log(`${c.name} joined the settlement.`);
      }
    }
  }
}

/** Food/water production forecast (spec: "make resource shortages obvious
 * before they become catastrophic" — produced/consumed/net/days-remaining
 * for the two survival resources). Shares the exact constants/formulas
 * advanceCivDay actually runs, rather than a second, drift-prone copy of
 * the math living in the HUD. Food consumption is an estimate: eating is
 * event-driven (hunger crosses 0, a meal is spent), not a flat daily drain
 * like water, so this reports the steady-state rate a settlement converges
 * toward rather than a number the sim reads directly. */
export interface EconomyForecast {
  producedPerDay: number;
  consumedPerDay: number;
  netPerDay: number;
  stock: number;
  /** null = not shrinking (net >= 0), so there's no "runs out" day. */
  daysRemaining: number | null;
}

function forecastFood(civ: Civ, season: Season): EconomyForecast {
  const farmMult = techBonus(civ, "farmYield") > 0 ? 1.5 : 1;
  const assignedFarmers = civ.citizens.filter((c) => c.job === "farm").length;
  const producedPerDay = (sumProvides(civ, "foodPerDay") + assignedFarmers * 4) * SEASON_FARM_MULT[season] * farmMult;
  // Steady-state: everyone gains HUNGER_PER_DAY worth of hunger daily, and
  // each full meal (1 food) clears MEAL_RELIEF of it — so on average each
  // citizen eats HUNGER_PER_DAY / MEAL_RELIEF meals a day.
  const consumedPerDay = civ.citizens.length * (HUNGER_PER_DAY / MEAL_RELIEF);
  const stock = civ.stock.food ?? 0;
  const netPerDay = producedPerDay - consumedPerDay;
  return { producedPerDay, consumedPerDay, netPerDay, stock, daysRemaining: netPerDay < 0 ? Math.max(0, Math.floor(stock / -netPerDay)) : null };
}

function forecastWater(civ: Civ): EconomyForecast {
  const producedPerDay = sumProvides(civ, "waterPerDay");
  const per = Resources.find((r) => r.id === "water")?.consumedPerCitizenPerDay ?? 0;
  const consumedPerDay = per * civ.citizens.length;
  const stock = civ.stock.water ?? 0;
  const netPerDay = producedPerDay - consumedPerDay;
  return { producedPerDay, consumedPerDay, netPerDay, stock, daysRemaining: netPerDay < 0 ? Math.max(0, Math.floor(stock / -netPerDay)) : null };
}

export function forecastEconomy(civ: Civ, season: Season): { food: EconomyForecast; water: EconomyForecast } {
  return { food: forecastFood(civ, season), water: forecastWater(civ) };
}

/** Returns true the day a new season begins, so Simulation can roll a
 * seasonal live event (spec §11, §27, §36 Phase 11) without this module
 * needing to know anything about events. */
export const DAYS_PER_SEASON = 30;

export function advanceDay(state: GameState, bus: EventBus): boolean {
  state.day += 1;
  const seasonChanged = state.day % DAYS_PER_SEASON === 0;
  if (seasonChanged) state.seasonIndex = (state.seasonIndex + 1) % 4;
  const season = state.season;

  for (const civ of state.civs) advanceCivDay(state, civ, bus, season);

  // Telegraphed winter warning the day before it arrives (player only).
  if ((state.day + 1) % DAYS_PER_SEASON === 0 && state.seasonIndex === 2) {
    bus.emit({ type: "toast", text: "Frost on the ridges — winter is nearly here. Stock food." });
  }

  bus.emit({ type: "dayPassed", day: state.day, season });
  return seasonChanged;
}

const RECRUIT_COST: Stockpile = { wood: 100 };

export type CommandResult = { ok: boolean; message: string };

/** Explicit, player-triggered growth (spec: "the player needs a way to add
 * more people to their country") — spends wood to welcome a settler on
 * demand, instead of only waiting on the daily passive-growth roll above.
 * Requires a House (spec: "1 house") so recruiting can't outrun shelter. */
export function recruitCitizen(state: GameState, civ: Civ, bus: EventBus): CommandResult {
  if (!civ.home) return { ok: false, message: "Found your camp first." };
  if (!civ.buildings.some((b) => b.id === "house" && b.complete)) {
    return { ok: false, message: "Build a House first." };
  }
  if (civ.citizens.length >= civ.housing) {
    return { ok: false, message: "No room — build more housing first." };
  }
  if (!civ.has(RECRUIT_COST)) {
    return { ok: false, message: "Not enough wood to recruit a settler." };
  }
  civ.spend(RECRUIT_COST);
  const c = civ.spawnCitizen(civ.home);
  bus.emit({ type: "citizenRecruited", name: c.name });
  bus.emit({ type: "resourceChanged" });
  state.log(`${c.name} joined the settlement.`);
  return { ok: true, message: `${c.name} has joined your civilization!` };
}

/** The leader takes a meal on command (spec: "when the player clicks T they
 * can eat as well") — spends one food to sate their hunger and mend a few
 * wounds, so food doubles as a way to recover between fights. */
export function leaderEat(civ: Civ, bus: EventBus): CommandResult {
  const leader = civ.leader;
  if (!leader) return { ok: false, message: "" };
  if ((civ.stock.food ?? 0) < 1) {
    return { ok: false, message: "No food to eat — hunt, gather berries, or grow crops first." };
  }
  if (leader.hunger <= 0 && leader.health >= 100) {
    return { ok: false, message: "You're already well fed." };
  }
  civ.spend({ food: 1 });
  leader.hunger = 0;
  leader.health = Math.min(100, leader.health + LEADER_EAT_HEAL);
  bus.emit({ type: "resourceChanged" });
  return { ok: true, message: "You eat a hearty meal. ❤" };
}
