// Player settings for the in-game pause menu (spec: "settings tab... volume,
// and the control change/ key bind"). Client-only localStorage, like the
// tutorial flag — these are per-device preferences, not gameplay state.

export type BindAction = "up" | "down" | "left" | "right" | "interact" | "eat";

export interface KeyBinds {
  up: string; down: string; left: string; right: string; interact: string; eat: string;
}

const DEFAULT_BINDS: KeyBinds = {
  up: "w", down: "s", left: "a", right: "d", interact: "e", eat: "t",
};

const BINDS_KEY = "giant-isle:keybinds";
const VOLUME_KEY = "giant-isle:volume";

export const BIND_LABELS: Record<BindAction, string> = {
  up: "Move Up", down: "Move Down", left: "Move Left", right: "Move Right",
  interact: "Interact / Attack", eat: "Eat",
};

export function loadKeyBinds(): KeyBinds {
  try {
    const raw = localStorage.getItem(BINDS_KEY);
    if (!raw) return { ...DEFAULT_BINDS };
    return { ...DEFAULT_BINDS, ...(JSON.parse(raw) as Partial<KeyBinds>) };
  } catch {
    return { ...DEFAULT_BINDS };
  }
}

export function saveKeyBinds(binds: KeyBinds): void {
  try {
    localStorage.setItem(BINDS_KEY, JSON.stringify(binds));
  } catch {
    // preferences are best-effort
  }
}

/** 0..1 master volume for procedural SFX. */
export function loadVolume(): number {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 0.8;
    return Math.max(0, Math.min(1, Number(raw)));
  } catch {
    return 0.8;
  }
}

export function saveVolume(v: number): void {
  try {
    localStorage.setItem(VOLUME_KEY, String(Math.max(0, Math.min(1, v))));
  } catch {
    // best-effort
  }
}
