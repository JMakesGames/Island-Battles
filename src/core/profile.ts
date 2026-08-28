// Persistent player identity (spec §15 Chronicles, §36 Phase 9). There is no
// account/auth system in this build, so "identity" is just an opaque id the
// client holds onto (localStorage for solo play, sent to the server for
// multiplayer) — see net/profileStore.client.ts and server/profileStore.ts.
//
// Pure logic only, no fs/localStorage here, so the same functions work on
// both sides of the Phase 5 network boundary without duplication.

import type { Civ } from "../game/Civ.ts";
import type { Wallet } from "./types.ts";

/** A completed civilization's mark on history, written when human control of
 * that civ ends (disconnect, or the solo tab closing) — there's no victory
 * system yet, so this is an honest session summary, not a campaign story. */
export interface ChronicleRecord {
  civName: string;
  seed: number;
  daysSurvived: number;
  peakPopulation: number;
  warsDeclared: number;
  alliancesFormed: number;
  endedAt: string; // ISO timestamp
}

/** Season Battle Pass progress (spec §25) — like the wallet, this spans
 * matches rather than resetting each game, so it lives on the persistent
 * profile and is only ever purchased/claimed from the main menu (spec:
 * "remove the battle pass from the map area to the main menu", same
 * no-LT-spending-mid-match rule as the Legacy Market). */
export interface BattlePassState {
  xp: number;
  level: number;
  premium: boolean;
  claimed: string[];
}

export interface PlayerProfile {
  playerId: string;
  wallet: Wallet;
  battlePass: BattlePassState;
  history: ChronicleRecord[];
}

const MAX_HISTORY = 20;

export function emptyWallet(): Wallet {
  return { lt: 0, inventory: [], processedRequests: [], equipped: {} };
}

export function emptyBattlePass(): BattlePassState {
  return { xp: 0, level: 1, premium: false, claimed: [] };
}

export function emptyProfile(playerId: string): PlayerProfile {
  return { playerId, wallet: emptyWallet(), battlePass: emptyBattlePass(), history: [] };
}

/** null if the civ never founded a camp — nothing chronicle-worthy happened. */
export function buildChronicleRecord(civ: Civ, seed: number, currentDay: number): ChronicleRecord | null {
  if (civ.foundedDay == null) return null;
  return {
    civName: civ.name,
    seed,
    daysSurvived: Math.max(0, currentDay - civ.foundedDay),
    peakPopulation: civ.peakPopulation,
    warsDeclared: civ.warsDeclared,
    alliancesFormed: civ.alliancesFormed,
    endedAt: new Date().toISOString(),
  };
}

export function appendHistory(profile: PlayerProfile, record: ChronicleRecord | null): void {
  if (!record) return;
  profile.history.push(record);
  if (profile.history.length > MAX_HISTORY) {
    profile.history.splice(0, profile.history.length - MAX_HISTORY);
  }
}

/** Copy a stored profile's wallet onto a live Civ (on claim/session start). */
export function restoreWallet(civ: Civ, profile: PlayerProfile): void {
  civ.wallet = {
    lt: profile.wallet.lt,
    inventory: [...profile.wallet.inventory],
    processedRequests: [...profile.wallet.processedRequests],
    equipped: { ...profile.wallet.equipped },
  };
}

/** Copy a live Civ's wallet back into a profile (before persisting it). */
export function captureWallet(civ: Civ, profile: PlayerProfile): void {
  profile.wallet = {
    lt: civ.wallet.lt,
    inventory: [...civ.wallet.inventory],
    processedRequests: [...civ.wallet.processedRequests],
    equipped: { ...civ.wallet.equipped },
  };
}

/** Copy a stored profile's Battle Pass progress onto a live Civ (session start) —
 * gameplay (XP grants) still runs against the live Civ during a match, same as
 * before; only purchasing/claiming moved to the main menu. */
export function restoreBattlePass(civ: Civ, profile: PlayerProfile): void {
  civ.battlePassXp = profile.battlePass.xp;
  civ.battlePassLevel = profile.battlePass.level;
  civ.battlePassPremium = profile.battlePass.premium;
  civ.battlePassClaimed = [...profile.battlePass.claimed];
}

/** Copy a live Civ's Battle Pass progress back into a profile (before persisting it). */
export function captureBattlePass(civ: Civ, profile: PlayerProfile): void {
  profile.battlePass = {
    xp: civ.battlePassXp,
    level: civ.battlePassLevel,
    premium: civ.battlePassPremium,
    claimed: [...civ.battlePassClaimed],
  };
}
