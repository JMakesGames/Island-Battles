// Translates a player's diplomacy-panel click into the right Diplomacy system
// call, computing sensible gift/trade offers from the player's stockpile so the
// UI can stay a set of simple buttons (spec §12). Pure glue; no game rules here.

import type { GameState } from "./GameState.ts";
import type { EventBus } from "../core/events.ts";
import type { Civ } from "./Civ.ts";
import type { DiploAction, ResourceId } from "../core/types.ts";
import {
  proposeAlliance, proposePact, declareWar, makePeace, sendGift, proposeTrade,
  type DiploResult,
} from "../systems/Diplomacy.ts";

const GIVE_POOL: ResourceId[] = ["wood", "stone", "fiber"];
const WANT_POOL: ResourceId[] = ["food", "water"];

function argmax(civ: Civ, pool: ResourceId[]): ResourceId {
  return pool.reduce((best, r) => ((civ.stock[r] ?? 0) > (civ.stock[best] ?? 0) ? r : best), pool[0]);
}

function argmin(civ: Civ, pool: ResourceId[]): ResourceId {
  return pool.reduce((worst, r) => ((civ.stock[r] ?? 0) < (civ.stock[worst] ?? 0) ? r : worst), pool[0]);
}

export function handleDiploAction(
  state: GameState,
  bus: EventBus,
  action: DiploAction,
  fromCivId: number,
  toCivId: number,
): DiploResult {
  const player = state.civs[fromCivId];
  const to = state.civs[toCivId];

  switch (action) {
    case "alliance": return proposeAlliance(state, player, to, bus);
    case "pact": return proposePact(state, player, to, bus);
    case "war": return declareWar(state, player, to, bus);
    case "peace": return makePeace(state, player, to, bus);
    case "gift": {
      const res = argmax(player, GIVE_POOL.concat(WANT_POOL) as ResourceId[]);
      const amount = Math.min(20, Math.floor(player.stock[res] ?? 0));
      if (amount <= 0) return { accepted: false, message: "You have nothing to gift." };
      return sendGift(state, player, to, { resource: res, amount }, bus);
    }
    case "trade": {
      const giveRes = argmax(player, GIVE_POOL);
      const wantRes = argmin(player, WANT_POOL);
      const giveAmt = Math.min(30, Math.floor(player.stock[giveRes] ?? 0));
      if (giveAmt < 10) return { accepted: false, message: "Not enough surplus to trade." };
      return proposeTrade(state, player, to, { resource: giveRes, amount: giveAmt }, { resource: wantRes, amount: 15 }, bus);
    }
  }
}
