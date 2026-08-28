// Deferred-phase system seams (spec §36). These are intentionally thin: they
// establish the module boundaries now so later phases (AI, diplomacy, trade,
// tech, combat, multiplayer) bolt on without rewrites (spec §30, §34). Each
// takes the same (state, bus) shape the live systems use.

import type { GameState } from "../game/GameState.ts";
import type { EventBus } from "../core/events.ts";

// Phase 2 AI now lives in systems/AISystem.ts (updateAI).
// Phase 3 diplomacy + trade now live in systems/Diplomacy.ts.

/** Technology eras gate buildings/units (spec §10). */
export function updateTech(_state: GameState, _bus: EventBus): void {
  // TODO: knowledge accrual -> era unlocks (survival->settlement->iron->...).
}

/** Readable, terrain-aware combat (spec §11). */
export function updateCombat(_state: GameState, _bus: EventBus): void {
  // TODO(phase-3+): unit stances, terrain modifiers, leader bonuses.
}
