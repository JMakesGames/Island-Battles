// The Battle Pass (spec §25): a free 100-level season track plus an optional
// premium track. Server-authoritative like the rest of the economy — XP is
// earned from real gameplay (surviving days, finishing buildings, completing
// research), levels are computed here, and reward claims are validated
// against the civ's actual level/premium status before anything is granted.
// `sampleTrack` in data/economy/battlepass.json is a template with rewards at
// a handful of milestone levels, not all 100 — claiming an unlisted level is
// simply a no-op (nothing to give).

import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { BattlePassMaxLevel, BattlePassPremiumPriceLt, getBattlePassTier } from "../game/config.ts";

export interface BattlePassResult {
  ok: boolean;
  message: string;
}

/** XP required to reach the next level — gently steepening, same style as leader
 * leveling. Exported so the HUD can render an accurate progress bar without
 * duplicating the formula. */
export function xpForLevel(level: number): number {
  return 100 + level * 15;
}

/** Grant Battle Pass XP and roll any level-ups this crosses (spec §25). */
export function grantBattlePassXp(civ: Civ, amount: number, bus: EventBus): void {
  if (civ.battlePassLevel >= BattlePassMaxLevel) return;
  civ.battlePassXp += amount;
  while (civ.battlePassLevel < BattlePassMaxLevel && civ.battlePassXp >= xpForLevel(civ.battlePassLevel)) {
    civ.battlePassXp -= xpForLevel(civ.battlePassLevel);
    civ.battlePassLevel += 1;
    if (!civ.isAI) {
      bus.emit({ type: "toast", text: `🎫 Battle Pass level ${civ.battlePassLevel}!` });
    }
  }
}

/** Sandbox stand-in for a real-money premium pass purchase — same posture as
 * systems/Economy.ts's grantLt: no payment processor exists in this build. */
export function purchasePremiumPass(civ: Civ, requestId: string, bus: EventBus): BattlePassResult {
  if (civ.wallet.processedRequests.includes(requestId)) {
    return { ok: true, message: "Purchase already processed." };
  }
  if (civ.battlePassPremium) return { ok: false, message: "You already own the premium pass." };
  if (civ.wallet.lt < BattlePassPremiumPriceLt) return { ok: false, message: "Not enough Legacy Tokens." };
  civ.wallet.lt -= BattlePassPremiumPriceLt;
  civ.battlePassPremium = true;
  civ.wallet.processedRequests.push(requestId);
  if (civ.wallet.processedRequests.length > 200) civ.wallet.processedRequests.shift();
  bus.emit({ type: "marketChanged" });
  return { ok: true, message: "Premium Battle Pass unlocked!" };
}

export function claimBattlePassReward(
  civ: Civ,
  level: number,
  track: "free" | "premium",
  bus: EventBus,
): BattlePassResult {
  const claimKey = `${level}:${track}`;
  if (civ.battlePassClaimed.includes(claimKey)) {
    return { ok: false, message: "Already claimed." };
  }
  if (level > civ.battlePassLevel) return { ok: false, message: "You haven't reached that level yet." };
  if (track === "premium" && !civ.battlePassPremium) {
    return { ok: false, message: "That reward needs the premium pass." };
  }
  const tier = getBattlePassTier(level);
  const reward = tier?.[track];
  if (!reward) return { ok: false, message: "No reward at that level." };

  if (reward.type === "lt" && reward.amount) {
    civ.wallet.lt += reward.amount;
  } else if (reward.id && !civ.wallet.inventory.includes(reward.id)) {
    civ.wallet.inventory.push(reward.id);
  }
  civ.battlePassClaimed.push(claimKey);
  if (!civ.isAI) {
    bus.emit({ type: "marketChanged" });
    bus.emit({ type: "toast", text: `🎫 Claimed the level ${level} ${track} reward.` });
  }
  return { ok: true, message: "Claimed." };
}
