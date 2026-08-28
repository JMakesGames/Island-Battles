// Central data-driven config loader (spec §34: "Use data-driven configuration.
// Never hard-code item prices throughout gameplay code.").
// All balance/economy lives in /data JSON; code reads it, never inlines it.

import resourcesJson from "../../data/game/resources.json";
import buildingsJson from "../../data/game/buildings.json";
import biomesJson from "../../data/game/biomes.json";
import eventsJson from "../../data/game/events.json";
import techJson from "../../data/game/tech.json";
import traitsJson from "../../data/game/traits.json";
import toolsJson from "../../data/game/tools.json";
import legacyTokensJson from "../../data/economy/legacy-tokens.json";
import itemsJson from "../../data/economy/items.json";
import bundlesJson from "../../data/economy/bundles.json";
import battlepassJson from "../../data/economy/battlepass.json";
import achievementsJson from "../../data/game/achievements.json";

import type { ResourceId, BiomeId, Stockpile } from "../core/types.ts";

export interface ResourceDef {
  id: ResourceId;
  name: string;
  tier: string;
  color: string;
  icon: string;
  carriable?: boolean;
  consumedPerCitizenPerDay?: number;
}

export interface BuildingDef {
  id: string;
  name: string;
  era: string;
  size: string;
  sprite: string;
  cost: Stockpile;
  buildTicks: number;
  color: string;
  provides: Record<string, number | boolean>;
  desc: string;
}

export interface ToolEffect {
  type: "gatherMult" | "combatMult";
  resources?: ResourceId[];
  mult: number;
}

export interface ToolDef {
  id: string;
  name: string;
  icon: string;
  cost: Stockpile;
  effect: ToolEffect;
  desc: string;
}

/** spec: "achievements tied to the existing Battle Pass XP economy" — each
 * check.type reads one tracked civ stat; see systems/AchievementSystem.ts. */
export interface AchievementDef {
  id: string;
  name: string;
  desc: string;
  xp: number;
  check: { type: string; value: number };
}

export interface BiomeDef {
  id: BiomeId;
  name: string;
  color: string;
  walkSpeed: number;
  buildable: boolean;
  sprite: string;
}

export interface NodeDef {
  id: string;
  resource: ResourceId;
  biome: BiomeId;
  amount: number;
  color: string;
  icon: string;
  sprite: string;
}

export interface EventChoice {
  label: string;
  effects: Record<string, unknown>;
  log: string;
  /** Structured quest chains (spec: "quest chains instead of one-off random
   * events") — id of the next event this choice leads into, if any. */
  next?: string;
  /** Days to wait before `next` fires; 0/unset fires immediately. */
  nextDelayDays?: number;
}

export interface GameEvent {
  id: string;
  title: string;
  body: string;
  trigger: string;
  /** Only set for trigger:"seasonal" — which season it's eligible in (spec §11 live events). */
  season?: string;
  choices: EventChoice[];
}

// --- Technology (spec §10) ---
export interface TechDef {
  id: string;
  name: string;
  era: string;
  type: "era" | "bonus";
  cost: number;
  requires: string | null;
  bonus?: string;
  desc: string;
}

// --- Traits (spec §5, §6) ---
export interface CitizenTraitDef {
  id: string;
  name: string;
  desc: string;
  gatherMult?: number;
  moraleBonus?: number;
  loyaltyBonus?: number;
  xpMult?: number;
}

export interface LeaderTraitDef {
  id: string;
  name: string;
  desc: string;
  revealBonus?: number;
  knowledgePerDay?: number;
  rallyBonus?: number;
  reputation?: string;
}

// --- Legacy Market economy defs (spec §17-26) ---
export interface LtPackageDef {
  id: string;
  name: string;
  lt: number;
  usd: number;
  bonusLt: number;
}

export interface MarketItemDef {
  id: string;
  category: string;
  name: string;
  rarity: "common" | "rare" | "epic" | "legendary" | "mythic";
  lt: number;
  usd: number;
  /** Always true in this catalog — cosmetics sell identity, never power. */
  cosmeticOnly: boolean;
  /** Optional render hint for equipped items (spec §36 Phase 8). */
  icon?: string;
}

export interface BundleDef {
  id: string;
  name: string;
  lt: number;
  contents: string[]; // MarketItemDef ids
}

// --- Battle Pass (spec §25) ---
export interface BattlePassReward {
  type: string;
  id?: string;
  amount?: number;
}

export interface BattlePassTier {
  level: number;
  free: BattlePassReward;
  premium: BattlePassReward;
}

// JSON literal types are narrower than our defs (optional keys differ per row),
// so cast through unknown — the JSON is the authored source of truth (spec §34).
export const Resources = resourcesJson.resources as unknown as ResourceDef[];
export const Buildings = buildingsJson.buildings as unknown as BuildingDef[];
export const Tools = toolsJson.tools as unknown as ToolDef[];
export const Biomes = biomesJson.biomes as unknown as BiomeDef[];
export const Nodes = biomesJson.nodes as unknown as NodeDef[];
export const Events = eventsJson.events as unknown as GameEvent[];
export const Achievements = achievementsJson.achievements as unknown as AchievementDef[];
export const Techs = techJson.techs as unknown as TechDef[];
export const Eras = techJson.eras as string[];
export const CitizenTraits = traitsJson.citizenTraits as unknown as CitizenTraitDef[];
export const LeaderTraits = traitsJson.leaderTraits as unknown as LeaderTraitDef[];

// Economy is loaded but intentionally not wired into gameplay power (spec §22, §26).
export const Economy = {
  legacyTokens: legacyTokensJson,
  items: itemsJson,
  bundles: bundlesJson,
  battlepass: battlepassJson,
};

export const LtPackages = legacyTokensJson.packages as unknown as LtPackageDef[];
export const MarketItems = itemsJson.items as unknown as MarketItemDef[];
export const MarketCategories = itemsJson.categories as string[];
export const Bundles = bundlesJson.bundles as unknown as BundleDef[];
export const BattlePassTiers = battlepassJson.sampleTrack as unknown as BattlePassTier[];
export const BattlePassPremiumPriceLt = battlepassJson.premiumPriceLt;
export const BattlePassMaxLevel = battlepassJson.levels;
export const BattlePassSeason = battlepassJson.season;

const resourceById = new Map(Resources.map((r) => [r.id, r]));
const buildingById = new Map(Buildings.map((b) => [b.id, b]));
const toolById = new Map(Tools.map((t) => [t.id, t]));
const biomeById = new Map(Biomes.map((b) => [b.id, b]));
const ltPackageById = new Map(LtPackages.map((p) => [p.id, p]));
const marketItemById = new Map(MarketItems.map((i) => [i.id, i]));
const bundleById = new Map(Bundles.map((b) => [b.id, b]));
const techById = new Map(Techs.map((t) => [t.id, t]));
const citizenTraitById = new Map(CitizenTraits.map((t) => [t.id, t]));
const leaderTraitById = new Map(LeaderTraits.map((t) => [t.id, t]));

export const getResource = (id: ResourceId): ResourceDef => resourceById.get(id)!;
export const getBuilding = (id: string): BuildingDef => buildingById.get(id)!;
export const getTool = (id: string): ToolDef | undefined => toolById.get(id);
export const getBiome = (id: BiomeId): BiomeDef => biomeById.get(id)!;
export const getLtPackage = (id: string): LtPackageDef | undefined => ltPackageById.get(id);
export const getMarketItem = (id: string): MarketItemDef | undefined => marketItemById.get(id);
export const getBundle = (id: string): BundleDef | undefined => bundleById.get(id);
export const getTech = (id: string): TechDef | undefined => techById.get(id);
export const getCitizenTrait = (id: string): CitizenTraitDef | undefined => citizenTraitById.get(id);
export const getLeaderTrait = (id: string): LeaderTraitDef | undefined => leaderTraitById.get(id);
export const getBattlePassTier = (level: number): BattlePassTier | undefined =>
  BattlePassTiers.find((t) => t.level === level);
/** Index of an era in the progression order (survival=0 … legacy=4). */
export const eraRank = (era: string): number => Eras.indexOf(era);

/** Animal companions (spec: "every item in the LT shop is an animal with a
 * buff... the animals should follow and be visible to the player... the
 * better the buff is the more expensive"). Bought with EARNED Legacy Tokens
 * in the menu, equipped one at a time. `buff` keys into the effects applied by
 * systems/Companions.ts; `icon` is a PixelIcons name drawn trailing the leader. */
export type CompanionBuff = "cat" | "dog" | "horse" | "hawk" | "dragon";
export interface CompanionDef {
  id: string;
  name: string;
  icon: string;
  price: number;
  buff: CompanionBuff;
  desc: string;
}
export const Companions: CompanionDef[] = [
  { id: "comp_cat", name: "Prowling Cat", icon: "cat", price: 40, buff: "cat",
    desc: "Scares wolves & bears away when they stalk you at night." },
  { id: "comp_dog", name: "Loyal Hound", icon: "dog", price: 80, buff: "dog",
    desc: "Hunts down wolves and bears that attack you, wounding them each moment." },
  { id: "comp_hawk", name: "Keen Hawk", icon: "hawk", price: 130, buff: "hawk",
    desc: "Scouts from above — widens how far you see across the isle." },
  { id: "comp_horse", name: "Warhorse", icon: "horse", price: 190, buff: "horse",
    desc: "A swift steed — you march 20% faster, always." },
  { id: "comp_dragon", name: "Wyrmling", icon: "dragon", price: 360, buff: "dragon",
    desc: "A young dragon's fury: +50% speed whenever your health drops below half." },
];
export const getCompanion = (id: string): CompanionDef | undefined =>
  Companions.find((c) => c.id === id);
