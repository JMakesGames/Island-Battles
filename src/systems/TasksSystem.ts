// In-game tasks that pay out Legacy Tokens (spec: "add a tasks feature when
// in the game that the player can complete for LT"). Since LT can no longer be
// bought (spec: earn-only), these — plus battle-pass progress and match
// rewards — are how a player funds animal companions. Evaluated once per day
// per human civ; each task grants once, tracked in civ.tasksCompleted.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";

export interface TaskDef {
  id: string;
  desc: string;
  reward: number; // LT
  goal: number;
  /** Current progress toward `goal`, derived from live state. */
  progress: (civ: Civ, state: GameState) => number;
}

const completedBuildings = (civ: Civ): number => civ.buildings.filter((b) => b.complete).length;

export const Tasks: TaskDef[] = [
  { id: "task_recruit", desc: "Grow your people to 5 citizens", reward: 30, goal: 5,
    progress: (civ) => civ.citizens.length },
  { id: "task_build", desc: "Raise 3 buildings", reward: 40, goal: 3,
    progress: (civ) => completedBuildings(civ) },
  { id: "task_wood", desc: "Stockpile 120 wood", reward: 20, goal: 120,
    progress: (civ) => Math.floor(civ.stock.wood ?? 0) },
  { id: "task_research", desc: "Research a technology", reward: 35, goal: 1,
    progress: (civ) => civ.researched.length },
  { id: "task_day", desc: "Survive to Day 12", reward: 25, goal: 12,
    progress: (_civ, state) => state.day },
  { id: "task_ally", desc: "Forge an alliance with a rival", reward: 50, goal: 1,
    progress: (civ) => civ.alliancesFormed },
  { id: "task_companion", desc: "Befriend an animal companion", reward: 15, goal: 1,
    progress: (civ) => (civ.wallet?.equipped?.companion ? 1 : 0) },
];

/** Grant LT for any task the civ has newly satisfied (idempotent per task). */
export function updateTasks(state: GameState, civ: Civ, bus: EventBus): void {
  if (civ.isAI) return;
  for (const task of Tasks) {
    if (civ.tasksCompleted.includes(task.id)) continue;
    if (task.progress(civ, state) >= task.goal) {
      civ.tasksCompleted.push(task.id);
      civ.wallet.lt += task.reward;
      state.log(`Task complete: ${task.desc} (+${task.reward} LT).`);
      bus.emit({ type: "toast", text: `Task complete — ${task.desc}! +${task.reward} Legacy Tokens.` });
      // Persist the earned LT to the client profile (LocalTransport listens).
      bus.emit({ type: "marketChanged" });
    }
  }
}
