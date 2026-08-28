// Client-side persistence for solo play (spec §36 Phase 9). No account system
// exists, so identity is just an id cached in localStorage — the same browser
// coming back later is recognized as the same player. Multiplayer mode uses
// the same id, sent to the server, which persists server-side instead (see
// server/profileStore.ts); this file only backs the offline LocalTransport path.

import { emptyProfile, type PlayerProfile } from "../core/profile.ts";
import { safeUUID } from "../core/uuid.ts";

const PLAYER_ID_KEY = "giant-isle:playerId";
const PROFILE_KEY_PREFIX = "giant-isle:profile:";
const TUTORIAL_SEEN_KEY = "giant-isle:tutorialSeen";

/** First-time tutorial (spec: "a short guided overlay introducing the HUD
 * for new players") — a plain client-only flag, not part of the networked
 * PlayerProfile, since which browser has seen it has nothing to do with
 * gameplay state the server needs to agree on. */
export function hasSeenTutorial(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_SEEN_KEY) === "1";
  } catch {
    return true; // storage unavailable — better to skip the tutorial than get stuck showing it
  }
}

export function markTutorialSeen(): void {
  try {
    localStorage.setItem(TUTORIAL_SEEN_KEY, "1");
  } catch {
    // Storage unavailable — nothing to persist, tutorial just won't be skippable-by-memory next time.
  }
}

export function getOrCreatePlayerId(): string {
  try {
    let id = localStorage.getItem(PLAYER_ID_KEY);
    if (!id) {
      id = safeUUID();
      localStorage.setItem(PLAYER_ID_KEY, id);
    }
    return id;
  } catch {
    // Storage unavailable (private browsing, etc.) — fall back to a
    // session-only id so the game still runs, just without persistence.
    return safeUUID();
  }
}

export function loadProfile(playerId: string): PlayerProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY_PREFIX + playerId);
    if (!raw) return emptyProfile(playerId);
    const parsed = JSON.parse(raw) as Partial<PlayerProfile>;
    return {
      playerId,
      wallet: parsed.wallet ?? emptyProfile(playerId).wallet,
      battlePass: parsed.battlePass ?? emptyProfile(playerId).battlePass,
      history: parsed.history ?? [],
    };
  } catch {
    return emptyProfile(playerId);
  }
}

export function saveProfile(profile: PlayerProfile): void {
  try {
    localStorage.setItem(PROFILE_KEY_PREFIX + profile.playerId, JSON.stringify(profile));
  } catch {
    // Storage unavailable or full — losing persistence is better than crashing.
  }
}
