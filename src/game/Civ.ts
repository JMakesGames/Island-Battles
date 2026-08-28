// A single civilization on the isle — the player is one Civ, each AI opponent is
// another (spec §4, §36 Phase 2). Owning per-civ state in one place is what let
// the single-player systems generalize to many civs without rewrites: the same
// CitizenSystem / BuildingSystem / SurvivalSystem now run per Civ.

import type { RNG } from "../core/rng.ts";
import type { Citizen, Building, Stockpile, Reputation, ResourceId, Vec2, Wallet } from "../core/types.ts";
import { makeName } from "../entities/names.ts";
import { getBuilding, CitizenTraits, getCitizenTrait } from "./config.ts";

export interface AIState {
  /** Ticks until the planner may act again (spreads decisions out). */
  planCooldown: number;
  /** Human-readable current intent, surfaced for debugging/telemetry. */
  goal: string;
  discoveredByPlayer: boolean;
}

export class Civ {
  stock: Stockpile = {};
  citizens: Citizen[] = [];
  buildings: Building[] = [];
  reputation: Reputation = {};
  morale = 60;
  home: Vec2 | null = null;
  started = false;
  nextCitizenId = 1;
  ai: AIState | null;
  /** How aggressively idle citizens auto-assign themselves (spec: "support
   * automation modes — Manual, Smart Automation, Full Automation"):
   * - "manual": idle citizens do nothing on their own; the player assigns
   *   every job. A locked citizen still tries to reacquire their own role.
   * - "smart" (default, matches the game's original always-on behavior):
   *   idle citizens build, then gather the nearest available resource;
   *   citizens with a locked role prefer reacquiring it first.
   * - "full": smart, plus idle citizens are steered toward whichever
   *   survival resource (food/water) is currently in the worst deficit
   *   before falling back to smart's generic pick.
   * Never overrides a jobLocked citizen's reacquisition-or-wait behavior. */
  automationMode: "manual" | "smart" | "full" = "smart";
  /** Blacksmith tools owned (spec: "buy axes, pick axes, swords") — permanent,
   * civ-wide gather/combat bonuses bought with regular resources, not LT. */
  tools: string[] = [];
  /** Premium currency + cosmetic entitlements (spec §17-26). Purely cosmetic —
   * nothing in gameplay ever reads this (spec §22, §26 no pay-to-win). */
  wallet: Wallet = { lt: 0, inventory: [], processedRequests: [], equipped: {} };

  // --- Chronicle-worthy stats (spec §15), rolled into a ChronicleRecord when
  // this civ's human control ends (see core/profile.ts, spec §36 Phase 9). ---
  /** Match day the camp was founded, or null before founding. */
  foundedDay: number | null = null;
  peakPopulation = 0;
  warsDeclared = 0;
  alliancesFormed = 0;
  /** Rival civ ids this civ has scouted (spec: "espionage — scout or
   * sabotage a rival civ") — lets the diplomacy panel show real intel
   * instead of just "discovered", no war required. */
  scoutedRivals: number[] = [];
  /** Achievement ids already earned (spec: "achievements tied to the
   * existing Battle Pass XP economy") — checked once per day, never
   * re-granted (see systems/AchievementSystem.ts). */
  achievementsEarned: string[] = [];
  /** In-game task ids already completed + rewarded (spec: "add a tasks
   * feature... that the player can complete for LT"). Checked once per day,
   * never re-granted (see systems/TasksSystem.ts). */
  tasksCompleted: string[] = [];

  // --- Leader as a controllable character (spec §5) ---
  /** When set, the leader walks here under manual control instead of auto-working. */
  leaderTarget: Vec2 | null = null;
  /** WASD held-direction movement: a constant unit vector applied every tick
   * while held, instead of chasing a lookahead waypoint (see CitizenSystem's
   * updateLeaderManual). Setting one clears the other — click-to-walk and
   * held-key steering are mutually exclusive. */
  leaderMoveDir: Vec2 | null = null;
  leaderXp = 0;
  leaderLevel = 1;
  leaderTraits: string[] = [];
  /** Optional player-chosen leader name (from the main menu). */
  leaderName?: string;
  /** Sim tick of the last "rally" interaction, for its cooldown. */
  lastRallyTick?: number;
  /** Sim tick of the last direct chop/mine/forage interaction, for its
   * cooldown (spec: "chop down the tree for wood... same for stone"). */
  lastGatherTick?: number;
  /** Sim tick of the last hunt interaction (spec: "same thing for... animals"). */
  lastHuntTick?: number;

  // --- Technology / research (spec §10) ---
  era = "survival";
  researched: string[] = [];
  /** Tech currently being researched (banked-knowledge model), or null. */
  researching: string | null = null;

  // --- Battle Pass (spec §25) ---
  battlePassXp = 0;
  battlePassLevel = 1;
  battlePassPremium = false;
  /** `${level}:${track}` ids already claimed, so a reward can't be double-granted. */
  battlePassClaimed: string[] = [];

  constructor(
    readonly id: number,
    readonly name: string,
    readonly color: string,
    /** Mutable: the server flips this when a human claims/releases the slot
     * (spec §36 Phase 5 — any civ may be AI- or human-controlled at runtime). */
    public isAI: boolean,
    private rng: RNG,
  ) {
    this.ai = isAI ? { planCooldown: 0, goal: "settling", discoveredByPlayer: false } : null;
  }

  get storageCap(): number {
    return this.sumProvides("storage");
  }

  get housing(): number {
    return this.sumProvides("housing");
  }

  private sumProvides(key: string): number {
    let cap = 0;
    for (const b of this.buildings) {
      if (!b.complete) continue;
      const prov = getBuilding(b.id).provides[key];
      if (typeof prov === "number") cap += prov;
    }
    return cap;
  }

  add(resource: ResourceId, amount: number): void {
    const cur = this.stock[resource] ?? 0;
    const cap = resource === "knowledge" ? Infinity : Math.max(this.storageCap, 200);
    this.stock[resource] = Math.max(0, Math.min(cap, cur + amount));
  }

  has(cost: Stockpile): boolean {
    return Object.entries(cost).every(([r, a]) => (this.stock[r as ResourceId] ?? 0) >= (a ?? 0));
  }

  spend(cost: Stockpile): void {
    for (const [r, a] of Object.entries(cost)) this.add(r as ResourceId, -(a ?? 0));
  }

  spawnCitizen(pos: Vec2, isLeader = false, parentName?: string): Citizen {
    const leaderLabel = this.leaderName ?? makeName(this.rng, true);
    // Citizens roll 0-1 traits at birth; the leader always starts with none
    // (they earn leader traits by levelling up instead). Spec §6.
    const traits: string[] = [];
    if (!isLeader && this.rng.chance(0.55)) {
      traits.push(this.rng.pick(CitizenTraits).id);
    }
    let loyaltyBonus = 0;
    for (const id of traits) loyaltyBonus += getCitizenTrait(id)?.loyaltyBonus ?? 0;
    const c: Citizen = {
      id: this.nextCitizenId++,
      name: isLeader ? (this.isAI ? `${leaderLabel}` : `${leaderLabel} (You)`) : makeName(this.rng),
      pos: { ...pos },
      target: null,
      job: "idle",
      carry: null,
      workNode: -1,
      buildTarget: -1,
      health: 100,
      hunger: 0,
      morale: this.morale,
      isLeader,
      loyalty: isLeader ? 100 : Math.max(0, Math.min(100, this.rng.int(50, 80) + loyaltyBonus)),
      skill: isLeader ? 60 : this.rng.int(10, 40),
      experience: 0,
      traits,
      facing: "right",
      attackCooldown: 0,
      age: isLeader ? this.rng.int(28, 45) : this.rng.int(16, 45),
      parentName,
    };
    this.citizens.push(c);
    return c;
  }

  get leader(): Citizen | undefined {
    return this.citizens.find((c) => c.isLeader);
  }
}
