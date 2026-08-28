// The full serializable match state. The shared world/clock lives here; each
// civilization's own state lives in a Civ (see Civ.ts). Everything is plain data
// so it can be snapshotted for save/load and, later, diffed by an authoritative
// server (spec §36).

import { World } from "../world/World.ts";
import { RNG } from "../core/rng.ts";
import { Civ } from "./Civ.ts";
import { Relations } from "./Relations.ts";
import type { Season, ChronicleEntry, Proposal, VictoryResult, Monster } from "../core/types.ts";

export const TICKS_PER_DAY = 3600; // ~60s/day at 60fps — slowed down from the original ~10s/day
export const SEASON_ORDER: Season[] = ["spring", "summer", "autumn", "winter"];

// Distinct civ colours so settlements read apart at a glance (spec §23, §37).
export const CIV_COLORS = ["#ffd36a", "#e0533b", "#5ad18a", "#6ac2f0", "#c98cf0", "#f08ac2"];
export const AI_CIV_NAMES = ["Thornhold", "Saltmere", "Emberfell", "Duskwatch", "Highreach"];

export class GameState {
  readonly world: World;
  readonly rng: RNG;
  readonly civs: Civ[] = [];
  playerIndex = 0;

  /** Diplomatic stances + opinions; sized once all civs are seated. */
  relations!: Relations;
  /** AI-initiated offers awaiting the player's decision. */
  pendingProposals: Proposal[] = [];
  /** Set once any civ meets a victory condition (spec §16); ends the match. */
  victory: VictoryResult | null = null;

  chronicle: ChronicleEntry[] = [];
  tick = 0;
  day = 1;
  seasonIndex = 0;
  /** Tile key ("x,y") -> tick it respawns. The Renderer's decorative wildlife
   * (spec: hash-placed, no networked state) becomes a real hunting target
   * once WildlifeSystem checks this — a plain object, not a Map, so it
   * survives JSON snapshotting for networked clients (spec §36). */
  huntedAnimals: Record<string, number> = {};
  /** Tile key ("x,y") -> hits landed on the animal currently living there
   * (spec: wolves/bears take "2 shots" to put down) — reset once the tile's
   * hit threshold is reached and the animal is actually hunted. */
  animalWounds: Record<string, number> = {};
  /** Live, chasing wolves/bears (spec: "make the bear and the wolf chase the
   * player") — real entities, unlike every other animal which stays a
   * stateless tile lookup (see systems/WildlifeSystem.ts). */
  monsters: Monster[] = [];
  nextMonsterId = 1;
  /** Quest chains awaiting their next stage (spec: "structured quest chains
   * instead of one-off random events") — a choice's `nextDelayDays` queues
   * an entry here instead of firing immediately; Simulation fires it once
   * `day` arrives (see EventSystem.resolveChoice). */
  pendingQuestSteps: { civId: number; eventId: string; day: number }[] = [];
  /** Opt-in difficulty (spec: "leader death — do not unfairly ruin a normal
   * run; keep permanent loss as an optional hardcore mode"). Off by default:
   * a human civ that loses its leader promotes a surviving citizen instead
   * of ending the run or losing its whole population — see
   * LeaderSystem.promoteNewLeader and its call sites in CombatSystem /
   * WildlifeSystem. On: restores the original permadeath behavior (full
   * citizen defection to the killer on combat death, game over either way). */
  hardcoreLeaderDeath = false;

  constructor(seed: number) {
    this.world = new World(seed);
    this.rng = new RNG(seed ^ 0x9e3779b9);
  }

  /** Called by the orchestrator once every civ has been added. */
  initRelations(): void {
    this.relations = new Relations(this.civs.length);
  }

  get player(): Civ {
    return this.civs[this.playerIndex];
  }

  get aiCivs(): Civ[] {
    return this.civs.filter((c) => c.isAI);
  }

  get season(): Season {
    return SEASON_ORDER[this.seasonIndex];
  }

  /** Fraction through the current day, 0 = midnight, 0.5 = noon. Rendering
   * only (Renderer's night tint) — derived from `tick`, no separate state to
   * keep in sync, and never read by any gameplay system. */
  get timeOfDay(): number {
    return (this.tick % TICKS_PER_DAY) / TICKS_PER_DAY;
  }

  addCiv(civ: Civ): void {
    this.civs.push(civ);
  }

  log(text: string): void {
    this.chronicle.push({ day: this.day, text });
  }
}
