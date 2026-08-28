// The Legacy Market economy (spec §17-26): a premium-currency wallet and
// cosmetic-only purchases, fully server-authoritative. The server computes
// every amount from its own catalog (data/economy/*.json) — a client can
// request a purchase but never dictate a price or a grant amount (spec §35).
//
// PAYMENT DISCLAIMER: `grantLt` stands in for a real receipt-validated
// purchase (App Store / Play / Stripe webhook) — this build has no payment
// processor wired up. It exists to exercise the wallet mechanics end-to-end
// (idempotency, balance, ledger) and MUST be replaced by real platform
// receipt validation before this could ever accept real money (spec §35:
// "Validate platform purchase receipts... Prevent unauthorized item grants").
// It is never reachable except through an explicit, clearly-labeled sandbox
// command — see ui/Hud.ts's "sandbox — no real purchase" copy.

import type { Civ } from "../game/Civ.ts";
import type { EventBus } from "../core/events.ts";
import { getLtPackage, getMarketItem, getBundle } from "../game/config.ts";

export interface PurchaseResult {
  ok: boolean;
  message: string;
}

const MAX_TRACKED_REQUESTS = 200;

function alreadyProcessed(civ: Civ, requestId: string): boolean {
  return civ.wallet.processedRequests.includes(requestId);
}

/** Record a request as applied; replay-safe (spec §35: prevent double spending). */
function markProcessed(civ: Civ, requestId: string): void {
  const req = civ.wallet.processedRequests;
  req.push(requestId);
  if (req.length > MAX_TRACKED_REQUESTS) req.splice(0, req.length - MAX_TRACKED_REQUESTS);
}

/** Sandbox stand-in for a completed real-money purchase (see file header). */
export function grantLt(civ: Civ, packageId: string, requestId: string, bus: EventBus): PurchaseResult {
  if (alreadyProcessed(civ, requestId)) {
    return { ok: true, message: "Purchase already processed." };
  }
  const pkg = getLtPackage(packageId);
  if (!pkg) return { ok: false, message: "Unknown package." };

  // Amount comes only from the server's own catalog — never from the client.
  const amount = pkg.lt + (pkg.bonusLt ?? 0);
  civ.wallet.lt += amount;
  markProcessed(civ, requestId);
  bus.emit({ type: "marketChanged" });
  return { ok: true, message: `+${amount} LT (${pkg.name}).` };
}

export function purchaseItem(civ: Civ, itemId: string, requestId: string, bus: EventBus): PurchaseResult {
  if (alreadyProcessed(civ, requestId)) {
    return { ok: true, message: "Purchase already processed." };
  }
  const item = getMarketItem(itemId);
  if (!item) return { ok: false, message: "Unknown item." };
  if (civ.wallet.inventory.includes(itemId)) {
    return { ok: false, message: `You already own ${item.name}.` };
  }
  if (civ.wallet.lt < item.lt) {
    return { ok: false, message: "Not enough Legacy Tokens." };
  }
  civ.wallet.lt -= item.lt;
  civ.wallet.inventory.push(itemId);
  markProcessed(civ, requestId);
  bus.emit({ type: "marketChanged" });
  return { ok: true, message: `You unlocked ${item.name}!` };
}

export function purchaseBundle(civ: Civ, bundleId: string, requestId: string, bus: EventBus): PurchaseResult {
  if (alreadyProcessed(civ, requestId)) {
    return { ok: true, message: "Purchase already processed." };
  }
  const bundle = getBundle(bundleId);
  if (!bundle) return { ok: false, message: "Unknown bundle." };
  if (civ.wallet.inventory.includes(bundleId)) {
    return { ok: false, message: `You already own the ${bundle.name}.` };
  }
  if (civ.wallet.lt < bundle.lt) {
    return { ok: false, message: "Not enough Legacy Tokens." };
  }
  civ.wallet.lt -= bundle.lt;
  civ.wallet.inventory.push(bundleId);
  for (const contentId of bundle.contents) {
    if (!civ.wallet.inventory.includes(contentId)) civ.wallet.inventory.push(contentId);
  }
  markProcessed(civ, requestId);
  bus.emit({ type: "marketChanged" });
  return { ok: true, message: `You unlocked the ${bundle.name}!` };
}

/**
 * Equip (or unequip, if already equipped) an owned cosmetic — one per
 * category (spec §8 module separation: rendering resolves this, this system
 * never touches gameplay). Not idempotency-tracked: equip/unequip is a
 * reversible toggle, not money changing hands.
 */
export function equipCosmetic(civ: Civ, itemId: string, bus: EventBus): PurchaseResult {
  const item = getMarketItem(itemId);
  if (!item) return { ok: false, message: "Unknown item." };
  if (!civ.wallet.inventory.includes(itemId)) {
    return { ok: false, message: `You don't own ${item.name}.` };
  }
  if (civ.wallet.equipped[item.category] === itemId) {
    delete civ.wallet.equipped[item.category];
    bus.emit({ type: "marketChanged" });
    return { ok: true, message: `Unequipped ${item.name}.` };
  }
  civ.wallet.equipped[item.category] = itemId;
  bus.emit({ type: "marketChanged" });
  return { ok: true, message: `Equipped ${item.name}.` };
}
