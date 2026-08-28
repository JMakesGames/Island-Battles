// Diplomacy & trade (spec §12). Player-initiated actions resolve immediately —
// the target civ (usually AI) decides synchronously from its opinion of the
// actor plus the actor's public reputation. AI-initiated offers are queued as
// Proposals for the player to answer. Every outcome adjusts opinion, may shift
// the actor's reputation (§12 reputations), and is written to the Chronicle.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import type { Reputation, ResourceOffer, Proposal } from "../core/types.ts";

export interface DiploResult {
  accepted: boolean;
  message: string;
}

// Opinion thresholds an AI needs (after reputation bias) to say yes.
const NEED_ALLIANCE = 40;
const NEED_PACT = 15;
const NEED_PEACE = -45;

function addRep(civ: Civ, key: keyof Reputation, n: number): void {
  civ.reputation[key] = (civ.reputation[key] ?? 0) + n;
}

/** How an actor's public reputation sways others' willingness to deal (§12). */
function reputationBias(actor: Civ): number {
  const r = actor.reputation;
  return (
    (r.honorable ?? 0) * 4 +
    (r.diplomatic ?? 0) * 4 +
    (r.generous ?? 0) * 3 -
    (r.warmonger ?? 0) * 6 -
    (r.unreliable ?? 0) * 5
  );
}

/** Effective standing the target `to` grants the actor `from`. */
function standing(state: GameState, from: Civ, to: Civ): number {
  return state.relations.opinion(to.id, from.id) + reputationBias(from);
}

function nameOf(civ: Civ): string {
  return civ.isAI ? civ.name : "You";
}

// ---- Player/actor-initiated actions --------------------------------------

export function proposePact(state: GameState, from: Civ, to: Civ, bus: EventBus): DiploResult {
  if (state.relations.stance(from.id, to.id) === "war") {
    return decline(state, to, from, "won't sign a pact while at war");
  }
  if (standing(state, from, to) < NEED_PACT) {
    return decline(state, to, from, "doesn't trust you enough yet");
  }
  state.relations.setStance(from.id, to.id, "pact");
  state.relations.addOpinion(to.id, from.id, 8);
  state.relations.addOpinion(from.id, to.id, 8);
  if (!from.isAI) addRep(from, "diplomatic", 1);
  return accept(state, bus, `${nameOf(to)} signed a non-aggression pact with ${nameOf(from)}.`);
}

export function proposeAlliance(state: GameState, from: Civ, to: Civ, bus: EventBus): DiploResult {
  if (state.relations.stance(from.id, to.id) === "war") {
    return decline(state, to, from, "you are at war");
  }
  if (standing(state, from, to) < NEED_ALLIANCE) {
    return decline(state, to, from, "isn't ready to ally with you");
  }
  state.relations.setStance(from.id, to.id, "alliance");
  state.relations.addOpinion(to.id, from.id, 20);
  state.relations.addOpinion(from.id, to.id, 20);
  if (!from.isAI) addRep(from, "diplomatic", 2);
  from.alliancesFormed++; // Chronicle-worthy stat (spec §15)
  return accept(state, bus, `⚔ ${nameOf(to)} formed an alliance with ${nameOf(from)}!`);
}

/** Immediately throw both sides' armed citizens (soldiers + archers) at the
 * nearest enemy — a surprise skirmish that erupts the instant war is declared
 * (spec: "when calling for war, half of the time it should be a surprise
 * attack"). Combat then resolves normally via updateCombat. */
function surpriseRaid(state: GameState, a: Civ, b: Civ, bus: EventBus): void {
  const engage = (attacker: Civ, defender: Civ): void => {
    for (const c of attacker.citizens) {
      if (c.job !== "guard" && c.job !== "archer") continue;
      let best: { id: number } | null = null;
      let bestD = Infinity;
      for (const e of defender.citizens) {
        const d = Math.hypot(e.pos.x - c.pos.x, e.pos.y - c.pos.y);
        if (d < bestD) { bestD = d; best = e; }
      }
      if (best) { c.attackCiv = defender.id; c.attackId = best.id; }
    }
  };
  engage(a, b);
  engage(b, a);
  if (!a.isAI) bus.emit({ type: "toast", text: "⚔ Surprise attack — your warriors strike at once!" });
  if (!b.isAI) bus.emit({ type: "toast", text: "⚔ Surprise attack — enemy warriors are upon you!" });
  state.log(`A surprise raid erupts between ${nameOf(a)} and ${nameOf(b)}!`);
}

export function declareWar(state: GameState, from: Civ, to: Civ, bus: EventBus): DiploResult {
  const prior = state.relations.stance(from.id, to.id);
  state.relations.setStance(from.id, to.id, "war");
  state.relations.addOpinion(to.id, from.id, -60);
  from.warsDeclared++; // Chronicle-worthy stat (spec §15)
  if (!from.isAI) {
    addRep(from, "warmonger", 1);
    // Breaking a standing treaty is dishonourable and everyone notices (§12).
    if (prior === "alliance" || prior === "pact") addRep(from, "unreliable", 2);
  }
  // A war declaration lowers the aggressor's standing with every other civ.
  for (const other of state.civs) {
    if (other.id !== from.id && other.id !== to.id) {
      state.relations.addOpinion(other.id, from.id, -12);
    }
  }
  const betrayal = prior === "alliance" || prior === "pact" ? " Treaties lie broken." : "";
  state.log(`${nameOf(from)} declared war on ${nameOf(to)}.${betrayal}`);
  bus.emit({ type: "chronicle", text: `War declared on ${to.name}.` });
  bus.emit({ type: "diplomacyChanged" });
  // Half of all war declarations open with a surprise raid rather than a slow
  // mobilisation (spec) — armed citizens on both sides charge immediately.
  if (state.rng.chance(0.5)) surpriseRaid(state, from, to, bus);
  return { accepted: true, message: `War declared on ${nameOf(to)}.` };
}

export function makePeace(state: GameState, from: Civ, to: Civ, bus: EventBus): DiploResult {
  if (state.relations.stance(from.id, to.id) !== "war") {
    return { accepted: false, message: `${nameOf(to)} is not at war with you.` };
  }
  if (standing(state, from, to) < NEED_PEACE) {
    return decline(state, to, from, "still thirsts for war");
  }
  state.relations.setStance(from.id, to.id, "neutral");
  state.relations.addOpinion(to.id, from.id, 15);
  if (!from.isAI) addRep(from, "honorable", 1);
  return accept(state, bus, `☮ ${nameOf(to)} agreed to peace with ${nameOf(from)}.`);
}

export function sendGift(
  state: GameState,
  from: Civ,
  to: Civ,
  offer: ResourceOffer,
  bus: EventBus,
): DiploResult {
  if (!from.has({ [offer.resource]: offer.amount })) {
    return { accepted: false, message: "You don't have that to give." };
  }
  from.spend({ [offer.resource]: offer.amount });
  to.add(offer.resource, offer.amount);
  const goodwill = Math.min(30, Math.ceil(offer.amount / 3));
  state.relations.addOpinion(to.id, from.id, goodwill);
  if (!from.isAI) {
    addRep(from, "generous", 1);
    bus.emit({ type: "resourceChanged" });
  }
  state.log(`${nameOf(from)} sent ${offer.amount} ${offer.resource} to ${to.name} (+${goodwill} goodwill).`);
  bus.emit({ type: "diplomacyChanged" });
  return { accepted: true, message: `${to.name}'s goodwill rose by ${goodwill}.` };
}

/** Actor offers `give`, wants `want` in return. Target accepts if it's fair. */
export function proposeTrade(
  state: GameState,
  from: Civ,
  to: Civ,
  give: ResourceOffer,
  want: ResourceOffer,
  bus: EventBus,
): DiploResult {
  if (!from.has({ [give.resource]: give.amount })) {
    return { accepted: false, message: "You don't have what you offered." };
  }
  if (!willTrade(state, from, to, give, want)) {
    return decline(state, to, from, "declined the trade");
  }
  from.spend({ [give.resource]: give.amount });
  to.add(give.resource, give.amount);
  to.spend({ [want.resource]: want.amount });
  from.add(want.resource, want.amount);
  state.relations.addOpinion(to.id, from.id, 4);
  if (!from.isAI) bus.emit({ type: "resourceChanged" });
  state.log(`${nameOf(from)} traded ${give.amount} ${give.resource} to ${to.name} for ${want.amount} ${want.resource}.`);
  bus.emit({ type: "diplomacyChanged" });
  return { accepted: true, message: `${to.name} accepted the trade.` };
}

/** Whether `to` is willing to give `want` in exchange for `give`. */
export function willTrade(
  state: GameState,
  from: Civ,
  to: Civ,
  give: ResourceOffer,
  want: ResourceOffer,
): boolean {
  if (state.relations.stance(from.id, to.id) === "war") return false;
  if (!to.has({ [want.resource]: want.amount })) return false;
  // Won't trade away what it needs to survive.
  const survival = to.citizens.length * 3;
  const consumable = want.resource === "food" || want.resource === "water";
  if (consumable && (to.stock[want.resource] ?? 0) - want.amount < survival) return false;
  // Roughly fair or generous to the AI, and it doesn't dislike the actor.
  const favourable = give.amount >= want.amount * 0.9;
  return favourable && standing(state, from, to) >= -10;
}

// ---- AI-initiated proposal resolution ------------------------------------

export function resolveProposal(
  state: GameState,
  proposal: Proposal,
  accepted: boolean,
  bus: EventBus,
): DiploResult {
  const ai = state.civs[proposal.fromCiv];
  const player = state.civs[proposal.toCiv];
  if (!accepted) {
    state.relations.addOpinion(ai.id, player.id, -6);
    bus.emit({ type: "diplomacyChanged" });
    return { accepted: false, message: `You declined ${ai.name}'s offer.` };
  }
  switch (proposal.action) {
    case "alliance":
      state.relations.setStance(ai.id, player.id, "alliance");
      state.relations.addOpinion(ai.id, player.id, 15);
      addRep(player, "diplomatic", 2);
      player.alliancesFormed++; // Chronicle-worthy stat (spec §15)
      break;
    case "pact":
      state.relations.setStance(ai.id, player.id, "pact");
      state.relations.addOpinion(ai.id, player.id, 8);
      addRep(player, "diplomatic", 1);
      break;
    case "peace":
      state.relations.setStance(ai.id, player.id, "neutral");
      state.relations.addOpinion(ai.id, player.id, 12);
      addRep(player, "honorable", 1);
      break;
    case "trade":
      if (proposal.give && proposal.want) {
        // AI gives `give`, player pays `want`.
        if (!player.has({ [proposal.want.resource]: proposal.want.amount })) {
          return { accepted: false, message: "You can't afford that trade." };
        }
        player.spend({ [proposal.want.resource]: proposal.want.amount });
        ai.add(proposal.want.resource, proposal.want.amount);
        ai.spend({ [proposal.give.resource]: proposal.give.amount });
        player.add(proposal.give.resource, proposal.give.amount);
        state.relations.addOpinion(ai.id, player.id, 4);
        bus.emit({ type: "resourceChanged" });
      }
      break;
  }
  state.log(`You accepted ${ai.name}'s ${proposal.action}.`);
  bus.emit({ type: "diplomacyChanged" });
  return { accepted: true, message: `Agreement reached with ${ai.name}.` };
}

// ---- AI diplomacy brain (runs once per day) ------------------------------

/** Daily opinion drift by stance, then maybe an AI reaches out to the player. */
export function updateDiplomacy(state: GameState, bus: EventBus): void {
  const rel = state.relations;
  // Relationships evolve with their stance (spec §12: reputations matter).
  for (let a = 0; a < state.civs.length; a++) {
    for (let b = 0; b < state.civs.length; b++) {
      if (a === b) continue;
      switch (rel.stance(a, b)) {
        case "war": rel.addOpinion(a, b, -1); break;
        case "alliance": rel.addOpinion(a, b, 1); break;
        case "pact": rel.addOpinion(a, b, 1); break;
        default: {
          const cur = rel.opinion(a, b); // neutral drifts gently to 0
          rel.addOpinion(a, b, cur > 0 ? -1 : cur < 0 ? 1 : 0);
        }
      }
    }
  }

  // A networked match may seat several humans; each AI civ can court any of
  // them independently (spec §36 Phase 5).
  const humans = state.civs.filter((c) => !c.isAI);
  for (const ai of state.aiCivs) {
    if (!ai.ai?.discoveredByPlayer) continue;
    for (const human of humans) {
      if (state.pendingProposals.some((p) => p.fromCiv === ai.id && p.toCiv === human.id)) continue;

      const op = rel.opinion(ai.id, human.id);
      const stance = rel.stance(ai.id, human.id);
      let proposal: Proposal | null = null;

      if (stance === "war") {
        if (state.rng.chance(0.14)) {
          proposal = { fromCiv: ai.id, toCiv: human.id, action: "peace", text: `${ai.name} is weary of war and sues for peace.` };
        }
      } else if (stance === "neutral") {
        if (op >= 35 && state.rng.chance(0.12)) {
          proposal = { fromCiv: ai.id, toCiv: human.id, action: "alliance", text: `${ai.name} admires your civilization and proposes an alliance.` };
        } else if (op >= 12 && state.rng.chance(0.12)) {
          proposal = { fromCiv: ai.id, toCiv: human.id, action: "pact", text: `${ai.name} offers a non-aggression pact.` };
        }
      } else if (stance === "pact" && op >= 45 && state.rng.chance(0.1)) {
        proposal = { fromCiv: ai.id, toCiv: human.id, action: "alliance", text: `${ai.name} wishes to deepen your pact into a full alliance.` };
      }

      if (proposal) {
        state.pendingProposals.push(proposal);
        bus.emit({ type: "proposalReceived", fromCiv: ai.id, toCiv: human.id });
      }
    }
  }
}

// ---- helpers --------------------------------------------------------------

function accept(state: GameState, bus: EventBus, text: string): DiploResult {
  state.log(text);
  bus.emit({ type: "chronicle", text });
  bus.emit({ type: "diplomacyChanged" });
  return { accepted: true, message: text };
}

function decline(state: GameState, to: Civ, from: Civ, reason: string): DiploResult {
  state.relations.addOpinion(to.id, from.id, -2);
  return { accepted: false, message: `${to.name} ${reason}.` };
}
