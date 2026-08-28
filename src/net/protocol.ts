// The client⇄server protocol (spec §34, §35, §36 Phase 4). Clients never mutate
// game state directly — they send serializable Commands describing *intent*. The
// authoritative Simulation validates and applies them. State flows back as
// Snapshots and gameplay feedback flows back as ServerEvents.
//
// Everything here is plain, JSON-serializable data: the same Command that a
// LocalTransport hands to an in-process Simulation today will travel over a
// WebSocket to a remote authoritative server in Phase 5, unchanged.

import type { Vec2, DiploAction } from "../core/types.ts";
import type { GameState } from "../game/GameState.ts";
import type { GameSignal } from "../core/events.ts";
import type { JobRole } from "../systems/CitizenSystem.ts";

/** A player intent. `civ` is the acting civilization (the sender's slot). */
export type Command =
  | { type: "foundCamp"; civ: number; tile: Vec2 }
  | { type: "placeBuilding"; civ: number; buildingId: string; tile: Vec2 }
  | { type: "resolveEvent"; civ: number; eventId: string; choice: number }
  | { type: "diploAction"; civ: number; action: DiploAction; targetCiv: number }
  | { type: "resolveProposal"; civ: number; fromCiv: number; accept: boolean }
  // Espionage (spec: "scout or sabotage a rival civ") — a third posture
  // alongside diploAction and open war; no Stance requirement either way.
  | { type: "scoutCiv"; civ: number; targetCiv: number }
  | { type: "sabotageCiv"; civ: number; targetCiv: number }
  // Legacy Market (spec §17-26). requestId is a client-generated idempotency
  // key so a resent command (dropped ack, page reload) can't double-charge.
  | { type: "purchaseItem"; civ: number; itemId: string; requestId: string }
  | { type: "purchaseBundle"; civ: number; bundleId: string; requestId: string }
  // Sandbox stand-in for a real-money purchase — see systems/Economy.ts header.
  | { type: "mockGrantLt"; civ: number; packageId: string; requestId: string }
  // Cosmetics (spec §22-23): toggle an owned item as equipped in its slot.
  | { type: "equipCosmetic"; civ: number; itemId: string }
  // The Leader as a controllable character (spec §5). target: null stops them
  // in place (the leader is never swept into auto-work — see CitizenSystem).
  | { type: "setLeaderTarget"; civ: number; target: Vec2 | null }
  // WASD held-direction steering (replaces the old lookahead-waypoint
  // scheme): dir is the raw (possibly diagonal, un-normalized) input axes,
  // e.g. {x:-1,y:-1} for up-left — the server normalizes so every direction
  // covers the same distance per tick, including diagonals.
  | { type: "setLeaderMove"; civ: number; dir: Vec2 | null }
  // Rally nearby citizens — server checks proximity + cooldown itself.
  | { type: "leaderInteract"; civ: number }
  // Technology (spec §10): spend banked Knowledge to complete a tech.
  | { type: "startResearch"; civ: number; techId: string }
  // Manual citizen job assignment (spec §6): send a non-leader citizen to
  // gather a specific node, build a specific unfinished building, or (for
  // anywhere else) just go idle there — overriding the auto-worker AI.
  | { type: "commandCitizen"; civ: number; citizenId: number; tile: Vec2 }
  // The job menu (spec: "add a job menu... pick the job they want"): assign
  // a role directly rather than clicking a specific tile — the server finds
  // a sensible target itself (see systems/CitizenSystem.ts assignRole).
  | { type: "assignRole"; civ: number; citizenId: number; role: JobRole }
  // Combat (spec: "the player should attack as well", "add soldiers"): send
  // one of your citizens to fight an enemy's — requires an active war (see
  // systems/CombatSystem.ts).
  | { type: "attackTarget"; civ: number; citizenId: number; targetCiv: number; targetCitizenId: number }
  // Explicit growth (spec: "the player needs a way to add more people to
  // their country"): spend resources to recruit a settler on demand,
  // instead of only waiting on the daily passive-growth roll.
  | { type: "recruitCitizen"; civ: number }
  // The leader eats on command (spec: "when the player clicks T they can eat
  // as well") — spends food to sate hunger and heal a little.
  | { type: "eat"; civ: number }
  // Blacksmith (spec: "add a blacksmith character that the player can buy
  // axes, pick axes, swords, iron, etc") — regular resources, mid-match.
  | { type: "purchaseTool"; civ: number; toolId: string }
  // Battle Pass (spec §25). requestId makes the premium purchase idempotent
  // the same way Legacy Market purchases are (spec §35).
  | { type: "purchasePremiumPass"; civ: number; requestId: string }
  | { type: "claimBattlePassReward"; civ: number; level: number; track: "free" | "premium" }
  // Job locking (spec: "let the player choose whether a citizen's job can
  // be automatically changed") — toggles whether the auto-worker AI may
  // reassign this citizen once their current task runs out.
  | { type: "setJobLock"; civ: number; citizenId: number; locked: boolean }
  // Automation modes (spec: "support automation modes — Manual, Smart
  // Automation, Full Automation") — civ-wide default for idle citizens.
  | { type: "setAutomationMode"; civ: number; mode: "manual" | "smart" | "full" };

/** Server → client gameplay feedback (toasts, chronicle, decisions to make). */
export type ServerEvent = GameSignal;

/**
 * Authoritative world state the client renders. For Phase 4 this is the live
 * GameState handed across an in-process boundary by reference; Phase 5 swaps in
 * a serialized/diffed snapshot without changing any caller — the client already
 * treats it as read-only.
 */
export type Snapshot = GameState;
