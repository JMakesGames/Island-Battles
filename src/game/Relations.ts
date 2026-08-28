// Diplomatic relations between civilizations (spec §12). Two pieces of state:
//  - stance: mutual, symmetric (you are either at war or not).
//  - opinion: asymmetric — how much civ A likes civ B may differ from B→A. AI
//    acceptance of the player's proposals reads its own opinion of the player.
// Kept as plain matrices sized to the (fixed) civ count so the whole thing stays
// trivially serializable for save/load and future network sync (spec §36).

import type { Stance } from "../core/types.ts";

export const OPINION_MIN = -100;
export const OPINION_MAX = 100;

export class Relations {
  private stanceM: Stance[][];
  private opinionM: number[][];

  constructor(readonly n: number) {
    this.stanceM = Array.from({ length: n }, () => Array<Stance>(n).fill("neutral"));
    this.opinionM = Array.from({ length: n }, () => Array<number>(n).fill(0));
  }

  stance(a: number, b: number): Stance {
    return this.stanceM[a][b];
  }

  setStance(a: number, b: number, s: Stance): void {
    this.stanceM[a][b] = s;
    this.stanceM[b][a] = s; // symmetric
  }

  /** How much `from` likes `to`. */
  opinion(from: number, to: number): number {
    return this.opinionM[from][to];
  }

  addOpinion(from: number, to: number, delta: number): void {
    const v = Math.max(OPINION_MIN, Math.min(OPINION_MAX, this.opinionM[from][to] + delta));
    this.opinionM[from][to] = v;
  }

  /** Nudge every opinion gently back toward neutral each day (grudges fade). */
  decayToward(target: number, step: number): void {
    for (let a = 0; a < this.n; a++) {
      for (let b = 0; b < this.n; b++) {
        if (a === b) continue;
        const cur = this.opinionM[a][b];
        if (cur > target) this.opinionM[a][b] = Math.max(target, cur - step);
        else if (cur < target) this.opinionM[a][b] = Math.min(target, cur + step);
      }
    }
  }
}
