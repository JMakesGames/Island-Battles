// Espionage (spec: "scout or sabotage a rival civ instead of only fighting/
// trading with them") — a third posture alongside open war and diplomacy.
// Scouting is low-risk recon (reveals their camp and current strength);
// sabotage is a real gamble (steals resources on success, but relations
// take a real hit if your agents are caught). Neither requires — or is
// blocked by — any particular Stance, unlike attackTarget which needs war.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import type { ResourceId } from "../core/types.ts";

export type CommandResult = { ok: boolean; message: string };

const SCOUT_COST = 15; // gold
const SABOTAGE_COST = 30; // gold
const SABOTAGE_SUCCESS_CHANCE = 0.6;
const SABOTAGE_STEAL_SHARE = 0.25; // fraction of the target's largest stock
const SABOTAGE_CAUGHT_OPINION_HIT = -20;
const SABOTAGE_POOL: ResourceId[] = ["wood", "stone", "food", "gold", "iron"];

/** Reveals the target's camp and current strength — cheap, no risk of being
 * caught, but costs a little gold to fund the scouts each time. */
export function scoutCiv(state: GameState, civ: Civ, targetCivId: number, bus: EventBus): CommandResult {
  if (targetCivId === civ.id) return { ok: false, message: "You can't spy on yourself." };
  const target = state.civs[targetCivId];
  if (!target) return { ok: false, message: "That civilization is gone." };
  if (!civ.has({ gold: SCOUT_COST })) {
    return { ok: false, message: `Need ${SCOUT_COST} gold to fund scouts.` };
  }
  civ.spend({ gold: SCOUT_COST });
  if (!civ.scoutedRivals.includes(targetCivId)) civ.scoutedRivals.push(targetCivId);
  if (target.home) state.world.reveal(target.home.x, target.home.y, 6);
  if (!civ.isAI) bus.emit({ type: "resourceChanged" });
  return {
    ok: true,
    message: `Scouts report on ${target.name}: ${target.citizens.length} citizens, ${Math.floor(target.stock.gold ?? 0)} gold.`,
  };
}

/** A gamble: on success, steals a share of whatever the target is richest
 * in; on failure, your agents are caught and the target's opinion of you
 * takes a real hit. Costs gold up front either way. */
export function sabotageCiv(state: GameState, civ: Civ, targetCivId: number, bus: EventBus): CommandResult {
  if (targetCivId === civ.id) return { ok: false, message: "You can't sabotage yourself." };
  const target = state.civs[targetCivId];
  if (!target) return { ok: false, message: "That civilization is gone." };
  if (!civ.has({ gold: SABOTAGE_COST })) {
    return { ok: false, message: `Need ${SABOTAGE_COST} gold to fund saboteurs.` };
  }
  civ.spend({ gold: SABOTAGE_COST });

  if (!state.rng.chance(SABOTAGE_SUCCESS_CHANCE)) {
    state.relations.addOpinion(targetCivId, civ.id, SABOTAGE_CAUGHT_OPINION_HIT);
    state.log(`${civ.name}'s saboteurs were caught targeting ${target.name}.`);
    if (!target.isAI) bus.emit({ type: "toast", text: `Saboteurs from ${civ.name} were caught red-handed!` });
    if (!civ.isAI) bus.emit({ type: "toast", text: "Your saboteurs were caught! Relations soured." });
    return { ok: true, message: "Your saboteurs were caught in the act!" };
  }

  const resource = SABOTAGE_POOL.reduce(
    (best, r) => ((target.stock[r] ?? 0) > (target.stock[best] ?? 0) ? r : best),
    SABOTAGE_POOL[0],
  );
  const amount = Math.floor((target.stock[resource] ?? 0) * SABOTAGE_STEAL_SHARE);
  if (amount > 0) {
    target.add(resource, -amount);
    civ.add(resource, amount);
  }
  state.log(`${civ.name}'s saboteurs struck ${target.name} undetected.`);
  if (!target.isAI) bus.emit({ type: "toast", text: `Your ${resource} stores were sabotaged — some go missing!` });
  if (!civ.isAI) bus.emit({ type: "resourceChanged" });
  return {
    ok: true,
    message: amount > 0
      ? `Your saboteurs stole ${amount} ${resource} from ${target.name}!`
      : `Your saboteurs struck but found little worth taking.`,
  };
}
