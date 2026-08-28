// Server-side persistence (spec §36 Phase 9). No database — a single JSON
// file, consistent with this project's "no unnecessary complexity" approach
// (same reasoning as the sandbox LT grant in systems/Economy.ts: build the
// real mechanics, keep the storage backend swappable). Writes are debounced
// so frequent purchases don't hammer the filesystem.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { emptyProfile, type PlayerProfile } from "../src/core/profile.ts";

const DATA_DIR = path.join(process.cwd(), "server", "data");
const FILE = path.join(DATA_DIR, "players.json");
const SAVE_DEBOUNCE_MS = 500;

type Store = Record<string, PlayerProfile>;

let cache: Store | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

async function load(): Promise<Store> {
  if (cache) return cache;
  try {
    const raw = await readFile(FILE, "utf8");
    cache = JSON.parse(raw) as Store;
  } catch {
    cache = {}; // first run, or file missing/corrupt — start fresh
  }
  return cache;
}

export async function getProfile(playerId: string): Promise<PlayerProfile> {
  const store = await load();
  const found = store[playerId];
  if (!found) return emptyProfile(playerId);
  // Defensive: a profile saved before Battle Pass moved onto PlayerProfile
  // won't have this field yet.
  return { ...found, battlePass: found.battlePass ?? emptyProfile(playerId).battlePass };
}

export async function saveProfile(profile: PlayerProfile): Promise<void> {
  const store = await load();
  store[profile.playerId] = profile;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
}

async function flush(): Promise<void> {
  if (!cache) return;
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(FILE, JSON.stringify(cache, null, 2), "utf8");
}

/** Flush immediately — call on process shutdown so the last save isn't lost. */
export async function flushNow(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await flush();
}
