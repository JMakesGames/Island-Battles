// Local save slots (spec: "there should be a past saved file world that the
// player can revisit and continue... only 3 worlds the player can have at a
// time that they can go back and forth in"). Each slot holds the full
// serialized sim state — the game state was deliberately built JSON-friendly
// (plain objects/Records, no Maps; see GameState) so JSON.stringify captures
// everything and serialize.rehydrateSave restores it, including RNG streams.
//
// Client-only (localStorage), same as the profile/tutorial flags — there is no
// server in solo play. Three fixed slots keep the surface small and match the
// spec's "3 worlds" cap exactly.

export const SAVE_SLOTS = 3;
const SAVE_KEY = (slot: number): string => `giant-isle:save:${slot}`;

export interface SaveMeta {
  slot: number;
  name: string;
  day: number;
  season: string;
  savedAt: number;
  seed: number;
}

interface SaveRecord {
  meta: SaveMeta;
  /** JSON string of the sim's GameState (stringified once at save time). */
  state: string;
}

/** Metadata for every slot (null == empty), index 0..SAVE_SLOTS-1. */
export function listSaves(): (SaveMeta | null)[] {
  const out: (SaveMeta | null)[] = [];
  for (let i = 0; i < SAVE_SLOTS; i++) {
    try {
      const raw = localStorage.getItem(SAVE_KEY(i));
      out.push(raw ? (JSON.parse(raw) as SaveRecord).meta : null);
    } catch {
      out.push(null);
    }
  }
  return out;
}

/** The lowest empty slot index, or -1 if all three are occupied. */
export function firstFreeSlot(): number {
  return listSaves().findIndex((m) => m === null);
}

export function writeSave(slot: number, stateJson: string, meta: Omit<SaveMeta, "slot" | "savedAt">): boolean {
  if (slot < 0 || slot >= SAVE_SLOTS) return false;
  try {
    const record: SaveRecord = { meta: { ...meta, slot, savedAt: Date.now() }, state: stateJson };
    localStorage.setItem(SAVE_KEY(slot), JSON.stringify(record));
    return true;
  } catch {
    // Storage full / unavailable — a failed save is surfaced to the caller so
    // it can warn the player rather than silently losing their realm.
    return false;
  }
}

/** The raw serialized state string for a slot (feed to rehydrateSave), or null. */
export function readSaveState(slot: number): string | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY(slot));
    return raw ? (JSON.parse(raw) as SaveRecord).state : null;
  } catch {
    return null;
  }
}

export function deleteSave(slot: number): void {
  try {
    localStorage.removeItem(SAVE_KEY(slot));
  } catch {
    // nothing to do
  }
}
