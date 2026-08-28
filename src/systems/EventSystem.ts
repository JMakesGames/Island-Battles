// Narrative events with consequential choices (spec §14). Effects are a flat
// data bag so designers can author events in JSON without touching code, and
// every resolution is written to the Chronicle (spec §15).

import type { GameState } from "../game/GameState.ts";
import type { EventBus } from "../core/events.ts";
import type { GameEvent, EventChoice } from "../game/config.ts";
import { Events } from "../game/config.ts";
import type { ResourceId, Reputation } from "../core/types.ts";
import { grantLeaderXp } from "./LeaderSystem.ts";
import { grantBattlePassXp } from "./BattlePass.ts";

const RESOURCE_KEYS: ResourceId[] = [
  "wood", "stone", "food", "water", "fiber",
  "iron", "gold", "medicine", "knowledge", "relic", "salt", "crystal",
];

export function getEvent(id: string): GameEvent | undefined {
  return Events.find((e) => e.id === id);
}

function nearestUndiscovered(state: GameState, from: { x: number; y: number } | null) {
  let best = null;
  let bestD = Infinity;
  for (const civ of state.aiCivs) {
    if (!civ.home || civ.ai?.discoveredByPlayer) continue;
    const d = from ? Math.hypot(civ.home.x - from.x, civ.home.y - from.y) : 0;
    if (d < bestD) {
      bestD = d;
      best = civ;
    }
  }
  return best;
}

/** `civId` is the human civ whose event this is — a networked match may seat
 * several humans at once, so effects must land on the right one (spec §36). */
export function resolveChoice(
  state: GameState,
  bus: EventBus,
  event: GameEvent,
  choiceIndex: number,
  civId: number,
): void {
  const choice: EventChoice | undefined = event.choices[choiceIndex];
  if (!choice) return;
  const fx = choice.effects;
  const player = state.civs[civId];

  for (const key of RESOURCE_KEYS) {
    if (typeof fx[key] === "number") player.add(key, fx[key] as number);
  }
  if (typeof fx.morale === "number") {
    player.morale = Math.max(0, Math.min(100, player.morale + (fx.morale as number)));
  }
  if (typeof fx.health === "number") {
    for (const c of player.citizens) c.health = Math.max(0, Math.min(100, c.health + (fx.health as number)));
  }
  if (typeof fx.leaderXp === "number") {
    grantLeaderXp(player, fx.leaderXp as number, bus);
  }
  if (typeof fx.battlePassXp === "number") {
    grantBattlePassXp(player, fx.battlePassXp as number, bus);
  }
  if (fx.reputation && typeof fx.reputation === "object") {
    for (const [k, v] of Object.entries(fx.reputation as Reputation)) {
      const key = k as keyof Reputation;
      player.reputation[key] = (player.reputation[key] ?? 0) + (v ?? 0);
    }
  }
  if (fx.revealRival === true) {
    // Reveal the nearest as-yet-undiscovered AI settlement (spec §14 map hint).
    const target = nearestUndiscovered(state, player.home);
    if (target) {
      state.world.reveal(target.home!.x, target.home!.y, 5);
      target.ai!.discoveredByPlayer = true;
      bus.emit({ type: "rivalDiscovered" });
    }
  }
  if (typeof fx.spawnCitizens === "number" && player.home) {
    for (let i = 0; i < (fx.spawnCitizens as number); i++) player.spawnCitizen(player.home);
  }

  state.log(choice.log);
  bus.emit({ type: "chronicle", text: choice.log });
  bus.emit({ type: "resourceChanged" });

  // Quest chains (spec: "structured quest chains instead of one-off random
  // events") — this choice leads somewhere: fire it now, or queue it for
  // the day it's due.
  if (choice.next) {
    const delay = choice.nextDelayDays ?? 0;
    if (delay <= 0) {
      bus.emit({ type: "eventTriggered", eventId: choice.next, civ: civId });
    } else {
      state.pendingQuestSteps.push({ civId, eventId: choice.next, day: state.day + delay });
    }
  }
}
