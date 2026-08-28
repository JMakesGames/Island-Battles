// Shared domain types for Island Battles.
// Kept engine-agnostic and serializable so the same state can later be
// reconciled by an authoritative server (spec §34, §36 Phase 4-5).

export type ResourceId =
  | "wood" | "stone" | "food" | "water" | "fiber"
  | "iron" | "gold" | "medicine" | "knowledge"
  | "relic" | "salt" | "crystal";

export type Stockpile = Partial<Record<ResourceId, number>>;

export interface Vec2 {
  x: number;
  y: number;
}

export type BiomeId =
  | "ocean" | "beach" | "grassland" | "forest" | "jungle"
  | "swamp" | "mountain" | "snow" | "water";

export interface Tile {
  biome: BiomeId;
  explored: boolean;
  /** Node index into World.nodes, or -1. */
  node: number;
  /** Index into World.sites of a discoverable site here, or -1 (spec §13). */
  site: number;
  /** True once a road building has been placed here (visual, spec §9). */
  road?: boolean;
}

/** A discoverable point of interest — ruins, a cave (spec §13). */
export interface Site {
  id: string;
  kind: "ruins" | "cave";
  tile: Vec2;
  discovered: boolean;
  /** Event id fired when the leader first reaches it. */
  eventId: string;
}

export interface ResourceNode {
  id: string;
  resource: ResourceId;
  tile: Vec2;
  remaining: number;
  color: string;
  icon: string;
}

/** A live, chasing wolf/bear (spec: "make the bear and the wolf chase the
 * player") — spawned once a leader wanders close to one of WildlifeSystem's
 * hash-placed animal tiles, and despawned again once it gives up or dies.
 * Every other animal (deer, sheep, ...) stays purely tile-based, no entity
 * at all — see systems/WildlifeSystem.ts. */
export interface Monster {
  id: number;
  kind: string;
  pos: Vec2;
  /** The tile it woke up on — ties it back to the hash/respawn-cooldown
   * system once hunted, and how far it'll roam before giving up. */
  home: Vec2;
  wounds: number;
  /** Ticks until it can land another hit. */
  attackCooldown: number;
  /** Civ id it's currently chasing, if any. */
  targetCiv: number | null;
}

export type CitizenJob = "idle" | "gather" | "haul" | "build" | "explore" | "farm" | "guard" | "archer";

export interface Citizen {
  id: number;
  name: string;
  pos: Vec2;
  target: Vec2 | null;
  job: CitizenJob;
  /** The duty the player last assigned (woodcutter, miner, soldier…), kept
   * separate from the transient `job` activity (gather/haul/guard…) so the
   * roster can show what you PICKED, not just what they're momentarily doing.
   * Undefined for auto-managed citizens (spec: "when I select a job... show
   * the job they are doing"). */
  assignedRole?: string;
  /** Job locking (spec: "let the player choose whether a citizen's job can
   * be automatically changed") — when true, if this citizen's current task
   * runs out (node depleted, building finished), they try to reacquire the
   * SAME assignedRole's work instead of falling back to the generic
   * build-then-any-resource auto-pick, and simply wait idle if none is
   * available right now rather than drifting to an unrelated job. Has no
   * effect without an assignedRole to reacquire. */
  jobLocked?: boolean;
  /** Resource being gathered/carried and how much is in hand. */
  carry: { resource: ResourceId; amount: number } | null;
  /** Node index the citizen is working, or -1. */
  workNode: number;
  /** Building index the citizen is constructing, or -1. */
  buildTarget: number;
  /** Which civ's buildings array buildTarget indexes into — unset means
   * "my own" (spec: "joint building for allied civs"); set only while
   * helping an ally's construction (see systems/CitizenSystem.ts). */
  buildTargetCiv?: number;
  health: number;
  hunger: number;
  morale: number;
  isLeader: boolean;
  // --- Depth (spec §6): citizens are characters, not numbers ---
  loyalty: number;
  /** Work skill 0-100; raises gather output and rises with experience. */
  skill: number;
  experience: number;
  /** Citizen trait ids (see traits.json), usually 0-1. */
  traits: string[];
  /** Which way the sprite faces, for animation — 8-dir to match the
   * extracted walk-cycle sprite sheet (see render/ImageSpriteAtlas.ts). */
  facing: Direction8;
  // --- Combat (spec: "the player should attack as well", "add soldiers") ---
  /** Who this citizen is currently trying to fight, if anyone — independent
   * of `job` so a guarding soldier can peel off to fight and resume
   * guarding after (see systems/CombatSystem.ts). */
  attackCiv?: number;
  attackId?: number;
  /** Ticks until this citizen can land another hit. */
  attackCooldown: number;
  /** Tick at which the leader may next use the interact key (spec: "the
   * player has an attack delay") — gates attack/hunt/gather/rally alike
   * since they all share the E key. Only ever set on the leader. */
  nextInteractTick?: number;
  /** Wall siege target (spec: "break into a fortified rival camp") —
   * separate from attackCiv/attackId since a wall isn't a citizen; resolved
   * the same war-gated, cooldown-driven way in CombatSystem.updateSiege. */
  attackWallCiv?: number;
  attackWallTile?: Vec2;
  /** Years old (spec: "named citizen persistence — aging/succession") — 1
   * in-game day = 1 year, an abstraction consistent with this game's already
   * compressed calendar (30-day seasons). Past OLD_AGE_START (see
   * SurvivalSystem.ts) they risk dying peacefully and being succeeded by an
   * heir. The leader ages too (for the tooltip) but is exempt from that
   * risk — no one wants their run ended by a dice roll. */
  age: number;
  /** Set on an heir spawned to succeed a citizen who died of old age. */
  parentName?: string;
}

export type Direction8 =
  | "up" | "upright" | "right" | "downright"
  | "down" | "downleft" | "left" | "upleft";

export interface Building {
  id: string; // building type id from buildings.json
  tile: Vec2;
  color: string;
  /** Ticks of construction remaining; 0 = complete. */
  buildRemaining: number;
  complete: boolean;
  /** Siege HP (spec: "break into a fortified rival camp") — only walls have
   * this; every other building is still immune to direct attack. */
  health?: number;
}

export type Season = "spring" | "summer" | "autumn" | "winter";

export type Reputation = Partial<Record<
  "honorable" | "diplomatic" | "unreliable" | "warmonger" | "fearsome" | "generous",
  number
>>;

export interface ChronicleEntry {
  day: number;
  text: string;
}

// --- Diplomacy (spec §12) ---
export type Stance = "neutral" | "pact" | "alliance" | "war";

export type DiploAction =
  | "alliance" | "pact" | "war" | "peace" | "gift" | "trade";

export interface ResourceOffer {
  resource: ResourceId;
  amount: number;
}

/** A pending diplomatic offer awaiting a human civ's yes/no (AI-initiated). */
export interface Proposal {
  fromCiv: number;
  /** Which human civ this offer targets — multiple humans may share the isle. */
  toCiv: number;
  action: Exclude<DiploAction, "war" | "gift">;
  /** For trade: what the proposer gives / wants in return. */
  give?: ResourceOffer;
  want?: ResourceOffer;
  text: string;
}

// --- Legacy Market economy (spec §17-26) ---
/**
 * A human civ's premium-currency wallet and cosmetic entitlements. Plain
 * arrays/records, not Sets or Maps — those serialize to `{}` over JSON and
 * would silently vanish across the Phase 5 network boundary (see
 * net/serialize.ts). Restored from a persistent PlayerProfile at claim time
 * (spec §36 Phase 9 — see core/profile.ts) rather than starting empty.
 */
export interface Wallet {
  lt: number;
  /** Owned item + bundle ids (cosmetic entitlements only — never gameplay). */
  inventory: string[];
  /** Idempotency keys already applied, so a resent command can't double-charge. */
  processedRequests: string[];
  /** One equipped cosmetic per MarketItemDef category, e.g. CROWNS -> item id
   * (spec §23: premium cosmetics must be visible to other players). */
  equipped: Record<string, string>;
}

// --- Victory (spec §16) ---
export type VictoryKind = "prosperity" | "knowledge" | "diplomatic" | "legacy";

export interface VictoryResult {
  kind: VictoryKind;
  civId: number;
  civName: string;
  day: number;
}
