// DOM overlay HUD. Deliberately in the DOM (not canvas) so store/Chronicle/menu
// screens reuse the same UI layer later (spec §20, §15). Reads GameState each
// frame; routes player intent back through callbacks.

import type { GameState } from "../game/GameState.ts";
import type { Civ } from "../game/Civ.ts";
import type { GameEvent } from "../game/config.ts";
import {
  Buildings, Resources, getBuilding,
  Techs, getLeaderTrait, getCitizenTrait, eraRank, Eras,
  Tools, Achievements,
} from "../game/config.ts";
import type { ResourceId, DiploAction, Proposal, Stance, Citizen } from "../core/types.ts";
import type { ChronicleRecord } from "../core/profile.ts";
import { canResearch } from "../systems/TechSystem.ts";
import { Tasks } from "../systems/TasksSystem.ts";
import { forecastEconomy, DAYS_PER_SEASON, type EconomyForecast } from "../systems/SurvivalSystem.ts";
import type { JobRole } from "../systems/CitizenSystem.ts";
import { emojiIcon, emojiifyText, pixelIcon } from "./PixelIcons.ts";
import { playSound, setMuted, isMuted, setVolume } from "./AudioSystem.ts";
import {
  loadVolume, saveVolume, loadKeyBinds, saveKeyBinds, BIND_LABELS,
  type BindAction,
} from "../net/settings.client.ts";

interface HudCallbacks {
  onBuild: (id: string) => void;
  onCancelBuild: () => void;
  onDiplo: (action: DiploAction, civId: number) => void;
  onScout: (civId: number) => void;
  onSabotage: (civId: number) => void;
  onResearch: (techId: string) => void;
  onInteract: () => void;
  onAssignRole: (role: JobRole) => void;
  onAssignLeaderRole: (role: JobRole) => void;
  onRecruit: () => void;
  onSelectCitizen: (id: number) => void;
  onToggleJobLock: (id: number) => void;
  onSetAutomationMode: (mode: "manual" | "smart" | "full") => void;
  onBuyTool: (toolId: string) => void;
  onEat: () => void;
  onPause?: () => void;
}

const JOB_ROLES: { role: JobRole; label: string }[] = [
  { role: "farmer", label: `${pixelIcon("wheat")} Farmer` },
  { role: "woodcutter", label: `${pixelIcon("axe")} Woodcutter` },
  { role: "miner", label: `${pixelIcon("pick")} Miner` },
  { role: "fisherman", label: `${pixelIcon("fishingRod")} Fisherman` },
  { role: "builder", label: `${pixelIcon("hammer")} Builder` },
  { role: "soldier", label: `${pixelIcon("shield")} Soldier` },
  { role: "archer", label: `${pixelIcon("bow")} Archer` },
  { role: "idle", label: `${pixelIcon("cancel")} Release` },
];

// The player-facing label for an assigned duty (roster shows this when set).
// Reuses JOB_ROLES' icon+text, minus "idle" (which just releases them).
const ROLE_LABEL: Record<string, string> = Object.fromEntries(
  JOB_ROLES.filter((r) => r.role !== "idle").map((r) => [r.role, r.label]),
);

const CITIZEN_JOB_LABEL: Record<string, string> = {
  idle: `${pixelIcon("idleZzz")} Idle`,
  gather: `${pixelIcon("axe")} Gathering`,
  haul: `${pixelIcon("box")} Hauling`,
  build: `${pixelIcon("hammer")} Building`,
  explore: `${pixelIcon("compass")} Exploring`,
  farm: `${pixelIcon("wheat")} Farming`,
  guard: `${pixelIcon("shield")} Guarding`,
  archer: `${pixelIcon("bow")} Archer`,
};

const STANCE_STYLE: Record<Stance, { label: string; color: string }> = {
  neutral: { label: "Neutral", color: "#6b6357" },
  pact: { label: "Pact", color: "#2f5d86" },
  alliance: { label: "Allied", color: "#3f6b2e" },
  war: { label: "At War", color: "#8f2418" },
};

// Resources surfaced in the top bar for the Phase 1 loop.
const BAR_RESOURCES: ResourceId[] = ["wood", "stone", "food", "water", "fiber"];

/** Most toasts shown at once (spec: "only 3 alerts at once"). */
const MAX_TOASTS = 3;

/** Current-objective guidance (spec: "the player should almost always
 * understand what they should do next" — a settlement progression readout).
 * Pure derivation from existing state, not a tracked/stored stage — so nothing
 * forces the player through it linearly, and it can never desync from what's
 * actually true (e.g. building a Farm out of order still clears that step). */
const OBJECTIVE_STAGES = [
  "Survive", "Found a Settlement", "Grow", "Advance", "Explore", "Civilization",
] as const;

function computeObjective(state: GameState, civ: Civ): { stage: string; tip: string } {
  if (!civ.home) {
    return { stage: OBJECTIVE_STAGES[0], tip: "Find a spot near wood, water and food, then click to found your camp." };
  }
  const pop = civ.citizens.length;
  const hasHouse = civ.buildings.some((b) => b.id === "house" && b.complete);
  if (pop < 4 || !hasHouse) {
    return { stage: OBJECTIVE_STAGES[1], tip: "Build a House and recruit more citizens to grow your settlement." };
  }
  const hasFarm = civ.buildings.some((b) => b.id === "farm" && b.complete);
  const hasStorage = civ.buildings.some((b) => b.id === "warehouse" && b.complete);
  if (pop < 8 || !hasFarm || !hasStorage) {
    return { stage: OBJECTIVE_STAGES[2], tip: "Assign jobs, build a Farm for food, and a Warehouse for storage." };
  }
  if (civ.researched.length === 0) {
    return { stage: OBJECTIVE_STAGES[3], tip: "Research a technology to unlock stronger buildings and bonuses." };
  }
  const rivalsKnown = state.aiCivs.some((c) => c.ai?.discoveredByPlayer);
  if (!rivalsKnown) {
    return { stage: OBJECTIVE_STAGES[4], tip: "Explore the island — seek out ruins, rare resources, and rival civilizations." };
  }
  return { stage: OBJECTIVE_STAGES[5], tip: "Use diplomacy, trade, alliances, espionage, or war to shape your standing." };
}

export class Hud {
  private root: HTMLElement;
  private topBar!: HTMLElement;
  private buildPanel!: HTMLElement;
  private buildPanelSignature: string | null = null;
  private chronicle!: HTMLElement;
  private toastWrap!: HTMLElement;
  private modal!: HTMLElement;
  private hint!: HTMLElement;
  private diploBtn!: HTMLElement;
  private diploPanel!: HTMLElement;
  private researchBtn!: HTMLElement;
  private researchPanel!: HTMLElement;
  private leaderBar!: HTMLElement;
  private interactBtn!: HTMLElement;
  private leaderWorkBtn!: HTMLElement;
  private leaderWorkPanel!: HTMLElement;
  private leaderWorkOpen = false;
  private citizenTip!: HTMLElement;
  private jobMenu!: HTMLElement;
  private jobMenuForCitizen: number | null = null;
  private placingId: string | null = null;
  private diploOpen = false;
  private diploSignature: string | null = null;
  private researchOpen = false;
  private selectedCitizenId: number | null = null;
  private recruitBtn!: HTMLElement;
  private eatBtn!: HTMLElement;
  private blacksmithBtn!: HTMLElement;
  private blacksmithPanel!: HTMLElement;
  private blacksmithOpen = false;
  private blacksmithSignature: string | null = null;
  private citizenPanel!: HTMLElement;
  private citizenPanelSignature: string | null = null;

  /** Every element Hud creates nests under this.root — see destroy(). */
  constructor(mount: HTMLElement, private cb: HudCallbacks) {
    this.root = document.createElement("div");
    this.root.style.cssText =
      "position:absolute;inset:0;pointer-events:none;" +
      "font:13px/1.45 'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif;";
    mount.appendChild(this.root);
    // Sound (spec: "there's no audio at all right now") — one capture-phase
    // listener covers every button the HUD ever creates (including ones
    // built later, per-frame, by the signature-diff panels) rather than
    // wiring a click sound into each individually.
    this.root.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).closest("button")) playSound("click");
    }, true);
    this.build();
  }

  /** Every floating panel is a sheet of aged parchment in a dark-oak frame
   * with a thin gilt band and an inked vignette — the manuscript look the
   * whole HUD shares (palette lives in index.html's :root). */
  private panelStyle(extra: string): string {
    return (
      "position:absolute;pointer-events:auto;color:var(--ink);border-radius:4px;" +
      "background:linear-gradient(158deg,var(--parch-1) 0%,var(--parch-2) 56%,var(--parch-3) 100%);" +
      "border:3px solid var(--oak-dk);" +
      "box-shadow:inset 0 0 0 2px var(--gilt), inset 0 0 26px rgba(120,80,28,0.30)," +
      "3px 5px 12px rgba(0,0,0,0.6);" +
      "padding:9px 11px;" +
      extra
    );
  }

  /** A carved-oak tablet button for the HUD's persistent nav row. `pos` is
   * the absolute-position fragment (bottom/left/…); the wood look + the press
   * feel come from here and index.html's global button rules. */
  private navBtnStyle(pos: string): string {
    return (
      "position:absolute;pointer-events:auto;cursor:pointer;font:inherit;font-size:13px;" +
      "padding:8px 13px;border-radius:3px;color:#f3e6c4;" +
      "border:2px solid var(--oak-dk);" +
      "background:linear-gradient(180deg,var(--oak-lt) 0%,var(--oak) 55%,var(--oak-dk) 100%);" +
      pos
    );
  }

  /** A smaller wood tablet for buttons that live inside a parchment panel
   * (research rows, tool rows, diplomacy actions, job picks…). */
  private woodBtnStyle(extra = ""): string {
    return (
      "cursor:pointer;font:inherit;font-size:12px;padding:6px 11px;border-radius:3px;" +
      "color:#f3e6c4;border:2px solid var(--oak-dk);" +
      "background:linear-gradient(180deg,var(--oak-lt) 0%,var(--oak) 60%,var(--oak-dk) 100%);" +
      extra
    );
  }

  /** An illuminated panel title: engraved royal-red caps with a fleur-de-lis
   * and a gilt rule beneath, the manuscript heading used across every panel. */
  private panelHeading(text: string): string {
    return (
      `<div style="font-weight:700;font-size:14px;color:var(--royal);letter-spacing:0.06em;` +
      `text-transform:uppercase;margin-bottom:7px;padding-bottom:3px;` +
      `border-bottom:2px solid var(--gilt);text-shadow:0 1px 0 rgba(255,242,208,0.55)">` +
      `${emojiIcon("⚜")} ${text}</div>`
    );
  }

  private build(): void {
    this.topBar = document.createElement("div");
    this.topBar.style.cssText = this.panelStyle(
      "top:10px;left:10px;display:flex;gap:14px;align-items:center;",
    );
    this.root.appendChild(this.topBar);

    this.hint = document.createElement("div");
    this.hint.style.cssText = this.panelStyle(
      "top:10px;left:50%;transform:translateX(-50%);color:var(--royal);font-weight:700;text-align:center;max-width:60%;",
    );
    this.root.appendChild(this.hint);

    // Mute toggle (spec: "sound... a big gap" — a considerate audio feature
    // lets you turn it back off). Placed clear of every other nav button.
    const muteBtn = document.createElement("button");
    const syncMuteLabel = () => { muteBtn.innerHTML = pixelIcon(isMuted() ? "speakerOff" : "speakerOn"); };
    syncMuteLabel();
    muteBtn.title = "Toggle sound";
    muteBtn.style.cssText = this.navBtnStyle("top:10px;right:10px;min-width:0;padding:6px 10px;");
    muteBtn.onclick = () => {
      setMuted(!isMuted());
      syncMuteLabel();
    };
    this.root.appendChild(muteBtn);

    // Pause / settings button (spec: "settings tab... which serves a pause").
    // Sits just left of the mute toggle; Escape opens the same overlay.
    const pauseBtn = document.createElement("button");
    pauseBtn.textContent = "❚❚";
    pauseBtn.title = "Settings / Pause (Esc)";
    pauseBtn.style.cssText = this.navBtnStyle("top:10px;right:54px;min-width:0;padding:6px 11px;font-size:12px;");
    pauseBtn.onclick = () => this.cb.onPause?.();
    this.root.appendChild(pauseBtn);

    this.buildPanel = document.createElement("div");
    this.buildPanel.style.cssText = this.panelStyle(
      "bottom:10px;left:50%;transform:translateX(-50%);display:flex;gap:8px;align-items:flex-end;",
    );
    this.root.appendChild(this.buildPanel);

    this.chronicle = document.createElement("div");
    this.chronicle.style.cssText = this.panelStyle(
      "top:56px;right:10px;width:230px;max-height:40vh;overflow:auto;font-size:12px;color:#c3c9d4;",
    );
    this.root.appendChild(this.chronicle);

    this.toastWrap = document.createElement("div");
    this.toastWrap.style.cssText =
      "position:absolute;bottom:84px;left:50%;transform:translateX(-50%);" +
      "display:flex;flex-direction:column;gap:6px;align-items:center;pointer-events:none;";
    this.root.appendChild(this.toastWrap);

    // Diplomacy toggle button (bottom-right) + slide-in panel (spec §12).
    this.diploBtn = document.createElement("button");
    this.diploBtn.innerHTML = `${pixelIcon("flag")} Diplomacy`;
    this.diploBtn.style.cssText = this.navBtnStyle("bottom:10px;right:10px;");
    this.diploBtn.onclick = () => {
      this.diploOpen = !this.diploOpen;
      this.diploPanel.style.display = this.diploOpen ? "block" : "none";
    };
    this.root.appendChild(this.diploBtn);

    this.diploPanel = document.createElement("div");
    this.diploPanel.style.cssText = this.panelStyle(
      "bottom:52px;right:10px;width:280px;max-height:60vh;overflow:auto;display:none;",
    );
    this.root.appendChild(this.diploPanel);

    // Legacy Market lives only in the main menu now (spec §22/§26 no-pay-to-
    // win: keeping LT spending strictly between-matches, never reachable
    // mid-game) — see ui/MainMenu.ts.

    // Research toggle (spec §10).
    this.researchBtn = document.createElement("button");
    this.researchBtn.innerHTML = `${pixelIcon("scroll")} Research`;
    this.researchBtn.style.cssText = this.navBtnStyle("bottom:70px;left:175px;");
    this.researchBtn.onclick = () => {
      this.researchOpen = !this.researchOpen;
      this.researchPanel.style.display = this.researchOpen ? "block" : "none";
    };
    this.root.appendChild(this.researchBtn);

    this.researchPanel = document.createElement("div");
    this.researchPanel.style.cssText = this.panelStyle(
      "bottom:112px;left:175px;width:300px;max-height:60vh;overflow:auto;display:none;",
    );
    this.root.appendChild(this.researchPanel);

    // Leader bar: name, level, XP (spec §5 — highly visible customization).
    this.leaderBar = document.createElement("div");
    this.leaderBar.style.cssText = this.panelStyle("top:56px;left:10px;width:230px;font-size:12px;");
    this.root.appendChild(this.leaderBar);

    this.interactBtn = document.createElement("button");
    this.interactBtn.innerHTML = `${pixelIcon("hand")} Interact (E)`;
    this.interactBtn.title =
      "Context action: attack an enemy in range, hunt a nearby animal, chop/mine a nearby " +
      "resource, or rally your citizens if none of those are close.";
    this.interactBtn.style.cssText = this.navBtnStyle("bottom:70px;left:355px;");
    this.interactBtn.onclick = () => this.cb.onInteract();
    this.root.appendChild(this.interactBtn);

    // Eat (spec: "when the player clicks T they can eat as well") — a hearty
    // meal from the granary that also mends a few wounds; keybind is T.
    this.eatBtn = document.createElement("button");
    this.eatBtn.innerHTML = `${pixelIcon("meat")} Eat (T)`;
    this.eatBtn.title = "Eat a meal to sate hunger and recover a little health (T)";
    this.eatBtn.style.cssText = this.navBtnStyle("bottom:70px;left:930px;");
    this.eatBtn.onclick = () => this.cb.onEat();
    this.root.appendChild(this.eatBtn);

    // Leader "work" toggle (spec: "the player should also be able to do
    // Jobs") — sits beside Rally. Static button set built once here (the
    // role list never changes), not per-frame, so it never hits the
    // rebuild-during-click flakiness the diplomacy panel had.
    this.leaderWorkBtn = document.createElement("button");
    this.leaderWorkBtn.innerHTML = `${pixelIcon("briefcase")} Work`;
    this.leaderWorkBtn.title = "Put yourself to work at a job, same as a citizen";
    this.leaderWorkBtn.style.cssText = this.navBtnStyle("bottom:70px;left:485px;");
    this.leaderWorkBtn.onclick = () => {
      this.leaderWorkOpen = !this.leaderWorkOpen;
      this.leaderWorkPanel.style.display = this.leaderWorkOpen ? "flex" : "none";
    };
    this.root.appendChild(this.leaderWorkBtn);

    this.leaderWorkPanel = document.createElement("div");
    this.leaderWorkPanel.style.cssText = this.panelStyle(
      "bottom:112px;left:485px;display:none;flex-direction:column;gap:6px;min-width:160px;",
    );
    this.leaderWorkPanel.innerHTML = this.panelHeading("Work As");
    for (const { role, label } of JOB_ROLES) {
      const btn = document.createElement("button");
      btn.innerHTML = label;
      btn.style.cssText = this.woodBtnStyle("text-align:left;");
      btn.onclick = () => {
        this.cb.onAssignLeaderRole(role);
        this.leaderWorkOpen = false;
        this.leaderWorkPanel.style.display = "none";
      };
      this.leaderWorkPanel.appendChild(btn);
    }
    this.root.appendChild(this.leaderWorkPanel);

    // Battle Pass lives only in the main menu now (spec: "remove the battle
    // pass from the map area to the main menu" — same reasoning as the
    // Legacy Market: no LT spending mid-match) — see ui/MainMenu.ts.

    // Explicit recruit button (spec: "the player needs a way to add more
    // people to their country") — spends wood for a settler on demand,
    // needs a House built.
    this.recruitBtn = document.createElement("button");
    this.recruitBtn.innerHTML = `${pixelIcon("family")} Recruit (100${pixelIcon("wood")})`;
    this.recruitBtn.title = "Spend 100 wood to recruit a new citizen (needs a House built)";
    this.recruitBtn.style.cssText = this.navBtnStyle("bottom:70px;left:600px;min-width:150px;text-align:center;");
    this.recruitBtn.onclick = () => this.cb.onRecruit();
    this.root.appendChild(this.recruitBtn);

    // Blacksmith toggle (spec: "add a blacksmith character that the player
    // can buy axes, pick axes, swords, iron, etc") — regular resources, a
    // normal mid-match purchase like a building, not gated to the main menu.
    // Given its own slot well clear of Recruit's — its label's width used to
    // run right into this button, silently eating clicks meant for Recruit.
    this.blacksmithBtn = document.createElement("button");
    this.blacksmithBtn.innerHTML = `${pixelIcon("hammer")} Blacksmith`;
    this.blacksmithBtn.title = "Buy tools for gather/combat bonuses (needs a completed Blacksmith)";
    this.blacksmithBtn.style.cssText = this.navBtnStyle("bottom:70px;left:800px;");
    this.blacksmithBtn.onclick = () => {
      this.blacksmithOpen = !this.blacksmithOpen;
      this.blacksmithPanel.style.display = this.blacksmithOpen ? "block" : "none";
    };
    this.root.appendChild(this.blacksmithBtn);

    this.blacksmithPanel = document.createElement("div");
    this.blacksmithPanel.style.cssText = this.panelStyle(
      "bottom:112px;left:800px;width:260px;max-height:50vh;overflow:auto;display:none;",
    );
    this.root.appendChild(this.blacksmithPanel);

    // Citizen roster (spec: "on the side it shows the citizens you have and
    // they can change the job of that citizen") — a persistent list, not a
    // toggle, on the left side below the leader bar. Rebuilt only when the
    // roster actually changes (same signature-diff pattern as diplomacy)
    // since it holds per-row buttons that a 60fps innerHTML rebuild would
    // silently break clicks on.
    this.citizenPanel = document.createElement("div");
    this.citizenPanel.style.cssText = this.panelStyle(
      "top:150px;left:10px;width:230px;max-height:calc(100vh - 220px);overflow:auto;" +
      "display:flex;flex-direction:column;gap:4px;font-size:12px;",
    );
    this.root.appendChild(this.citizenPanel);

    this.modal = document.createElement("div");
    this.modal.style.cssText =
      "position:absolute;inset:0;display:none;align-items:center;justify-content:center;" +
      "background:rgba(4,6,10,0.55);pointer-events:auto;";
    this.root.appendChild(this.modal);

    // Citizen inspect (spec §6): a hover tooltip, not click — click is
    // reserved for sending the leader to walk there.
    this.citizenTip = document.createElement("div");
    this.citizenTip.style.cssText =
      this.panelStyle("display:none;pointer-events:none;font-size:11px;min-width:140px;");
    this.root.appendChild(this.citizenTip);

    // Job menu (spec: "add a job menu... pick the job they want"): appears
    // once a citizen is selected, offering roles directly instead of
    // requiring a click on a specific node/building.
    this.jobMenu = document.createElement("div");
    this.jobMenu.style.cssText = this.panelStyle(
      "display:none;bottom:180px;left:50%;transform:translateX(-50%);" +
      "flex-direction:column;gap:6px;min-width:160px;",
    );
    this.root.appendChild(this.jobMenu);
  }

  setPlacing(id: string | null): void {
    this.placingId = id;
  }

  private buildButtons(state: GameState, myCivId: number): void {
    const p = state.civs[myCivId];
    // Buildable set: everything except the town center once a camp exists.
    const list = p.home
      ? Buildings.filter((b) => !b.provides.isTownCenter)
      : Buildings.filter((b) => b.provides.isTownCenter);

    // Signature-diff guard (see the diplomacy-panel comment elsewhere in this
    // file): this used to rebuild every button on every 60fps render call,
    // regardless of whether anything changed. A click's mousedown/mouseup can
    // straddle that rebuild — the button is destroyed and recreated between
    // the two events, so the click silently never fires (bug: "clicking the
    // button does nothing" for every building, reported after the resource
    // fix, since a human's click timing is far more likely to straddle a
    // 16ms frame than a scripted click is).
    const signature = `${!!p.home}|${this.placingId}|` +
      list.map((d) => `${d.id}:${p.has(d.cost)}`).join(",");
    if (signature === this.buildPanelSignature) return;
    this.buildPanelSignature = signature;

    this.buildPanel.innerHTML = "";
    for (const def of list) {
      const btn = document.createElement("button");
      const affordable = p.has(def.cost);
      const selected = this.placingId === def.id;
      const costText = Object.entries(def.cost)
        .map(([r, a]) => `${a}${resIcon(r as ResourceId)}`)
        .join(" ") || "free";
      btn.innerHTML =
        `<div style="font-weight:700">${def.name}</div>` +
        `<div style="font-size:11px;opacity:.85">${costText}</div>`;
      btn.title = def.desc;
      // Selected building glows with gilt; unaffordable ones read as unlit
      // (the :disabled rule dims them) so the eye lands on what you can raise.
      btn.disabled = !affordable && !selected;
      btn.style.cssText = this.woodBtnStyle(
        "pointer-events:auto;min-width:74px;text-align:center;" +
        (selected
          ? "background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));color:#2c1e0d;border-color:#5a3e12;"
          : ""),
      );
      btn.onclick = () => {
        if (selected) this.cb.onCancelBuild();
        else this.cb.onBuild(def.id);
      };
      this.buildPanel.appendChild(btn);
    }
    if (this.placingId) {
      const cancel = document.createElement("button");
      cancel.innerHTML = pixelIcon("cancel");
      cancel.style.cssText = this.woodBtnStyle(
        "pointer-events:auto;padding:6px 12px;background:linear-gradient(180deg,var(--royal-lt),var(--royal));border-color:#3a0f0a;",
      );
      cancel.onclick = () => this.cb.onCancelBuild();
      this.buildPanel.appendChild(cancel);
    }
  }

  update(state: GameState, myCivId: number, history: ChronicleRecord[]): void {
    const p = state.civs[myCivId];
    // Economy forecast (spec: "make resource shortages obvious before they
    // become catastrophic") — same math the sim actually runs, see
    // SurvivalSystem.forecastEconomy. Only meaningful once settled.
    const econ = p.home ? forecastEconomy(p, state.season) : null;
    const FORECAST_FOR: Partial<Record<ResourceId, EconomyForecast>> = econ ? { food: econ.food, water: econ.water } : {};
    // Top bar: resources + status. Food/water tint amber/red once running a
    // deficit, so a shortage is visible well before the stockpile hits zero.
    const res = BAR_RESOURCES.map((r) => {
      const def = Resources.find((x) => x.id === r)!;
      const f = FORECAST_FOR[r];
      let color = "inherit";
      let title = def.name;
      if (f && f.netPerDay < 0) {
        color = f.daysRemaining != null && f.daysRemaining <= 3 ? "#e05a3b" : "#e0a13b";
        title = `${def.name}: ${f.netPerDay.toFixed(1)}/day` +
          (f.daysRemaining != null ? ` — runs out in ~${f.daysRemaining}d` : "");
      } else if (f) {
        title = `${def.name}: +${f.netPerDay.toFixed(1)}/day`;
      }
      return `<span title="${title}" style="color:${color}">${emojiIcon(def.icon)} ${Math.floor(p.stock[r] ?? 0)}</span>`;
    }).join("");
    const cap = p.storageCap || 200;
    const knownRivals = state.aiCivs.filter((c) => c.ai?.discoveredByPlayer).length;
    const rivalTag = knownRivals
      ? `<span title="Rival civilizations discovered">${pixelIcon("flag")} ${knownRivals}</span>`
      : "";
    // Season countdown (spec: "show current season, remaining time") + an
    // early color warning as autumn's days run down into winter's farm/cold
    // penalty, so a shortfall is a planning problem, not a surprise.
    const daysIntoSeason = (state.day - 1) % DAYS_PER_SEASON;
    const daysLeftInSeason = DAYS_PER_SEASON - daysIntoSeason;
    const approachingWinter = state.season === "autumn" && daysLeftInSeason <= 7;
    const seasonColor = approachingWinter ? "#e0a13b" : "var(--ink-soft)";
    const divider = `<span style="width:2px;height:18px;background:var(--gilt);opacity:.7"></span>`;
    this.topBar.innerHTML =
      `<span style="font-weight:700;color:var(--royal);letter-spacing:.03em">Day ${state.day}</span>` +
      `<span title="${approachingWinter ? "Winter is approaching — food production will drop, and exposed citizens take cold damage. Stockpile food and housing now." : `${daysLeftInSeason}d left in ${state.season}`}" ` +
      `style="text-transform:capitalize;color:${seasonColor}">${seasonIcon(state.season)} ${state.season} (${daysLeftInSeason}d)</span>` +
      divider +
      `<span title="People / housing">${pixelIcon("person")} ${p.citizens.length}/${p.housing || 3}</span>` +
      `<span title="Morale">${pixelIcon("smile")} ${Math.round(p.morale)}</span>` +
      `<span title="Storage" style="color:var(--ink-soft)">${pixelIcon("box")} ${cap}</span>` +
      rivalTag +
      divider +
      res +
      divider +
      `<span title="Legacy Tokens" style="color:var(--gilt);font-weight:700">${pixelIcon("coin")} ${p.wallet.lt}</span>`;

    // Build buttons (rebuilt each frame — cheap for this count).
    this.buildButtons(state, myCivId);

    // Diplomacy panel (only rebuilt while open).
    this.diplomacy(state, myCivId);

    // Research panel (only rebuilt while open).
    this.research(p);

    // Leader bar: always visible once the leader exists (spec §5).
    this.updateLeaderBar(p);

    // Citizen roster (only rebuilt when the roster actually changes).
    this.roster(p, this.selectedCitizenId);

    // Blacksmith panel (only rebuilt while open and something changed).
    this.blacksmith(p);

    // Objective (spec: "the player should almost always understand what
    // they should do next" — a settlement progression readout). Pure
    // derivation from state, shown above everything else in the panel.
    const objective = computeObjective(state, p);
    const objectiveHtml =
      `<div style="background:linear-gradient(158deg,var(--parch-2),var(--parch-3));border:2px solid var(--oak-dk);` +
      `border-radius:4px;padding:6px 8px;margin-bottom:8px;">` +
      `<div style="font-size:10px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--royal)">${pixelIcon("compass")} ${objective.stage}</div>` +
      `<div style="font-size:11px;color:var(--ink)">${objective.tip}</div>` +
      `</div>`;

    // Economy forecast (spec: "make resource shortages obvious before they
    // become catastrophic" — produced/consumed/net/days-remaining).
    const econForLine = (label: string, icon: string, f: EconomyForecast): string => {
      const sign = f.netPerDay >= 0 ? "+" : "";
      const color = f.netPerDay < 0 ? (f.daysRemaining != null && f.daysRemaining <= 3 ? "#e05a3b" : "#e0a13b") : "var(--ink-soft)";
      const remain = f.netPerDay < 0 && f.daysRemaining != null ? ` (~${f.daysRemaining}d left)` : "";
      return `<span style="color:${color}">${icon} ${label}: ${f.producedPerDay.toFixed(1)}−${f.consumedPerDay.toFixed(1)} = ${sign}${f.netPerDay.toFixed(1)}/d${remain}</span>`;
    };
    const econHtml = econ
      ? `<div style="font-size:10px;display:flex;flex-direction:column;gap:1px;margin-bottom:8px">` +
        econForLine("Food", emojiIcon("🍖"), econ.food) +
        econForLine("Water", emojiIcon("💧"), econ.water) +
        `</div>`
      : "";

    // Chronicle (spec §15): current-run stats, recent log, then past civilizations.
    const recent = state.chronicle.slice(-8).reverse();
    const daysSurvived = p.foundedDay != null ? Math.max(0, state.day - p.foundedDay) : 0;
    const statLine = p.foundedDay != null
      ? `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">` +
        `${daysSurvived}d survived · ${pixelIcon("person")} peak ${p.peakPopulation} · ${pixelIcon("sword")} ${p.warsDeclared} wars · ${pixelIcon("handshake")} ${p.alliancesFormed} alliances · ` +
        `${pixelIcon("trophy")} ${p.achievementsEarned.length}/${Achievements.length}</div>`
      : "";
    const pastHtml = history.length
      ? `<div style="font-weight:700;color:var(--royal);letter-spacing:.04em;text-transform:uppercase;` +
        `font-size:12px;margin:10px 0 4px;border-bottom:1px solid var(--gilt);padding-bottom:2px">${pixelIcon("bank")} Past Realms</div>` +
        history.slice().reverse().map((h) =>
          `<div style="margin:4px 0;padding-bottom:4px;border-bottom:1px solid rgba(90,60,25,0.3)">` +
          `<b style="color:var(--ink)">${h.civName}</b> — ${h.daysSurvived}d, peak ${pixelIcon("person")}${h.peakPopulation}` +
          `<div style="font-size:11px;color:var(--ink-soft)">${pixelIcon("sword")} ${h.warsDeclared} wars · ${pixelIcon("handshake")} ${h.alliancesFormed} alliances · ${new Date(h.endedAt).toLocaleDateString()}</div>` +
          `</div>`
        ).join("")
      : "";
    // Tasks (spec: "add a tasks feature... that the player can complete for
    // LT") — a live checklist with progress; the reward lands automatically
    // the day a task's goal is met (see TasksSystem).
    const tasksHtml = p.foundedDay != null
      ? `<div style="font-weight:700;color:var(--royal);letter-spacing:.04em;text-transform:uppercase;` +
        `font-size:12px;margin:8px 0 3px;border-bottom:1px solid var(--gilt);padding-bottom:2px">${pixelIcon("scroll")} Tasks</div>` +
        Tasks.map((t) => {
          const done = p.tasksCompleted.includes(t.id);
          const prog = Math.min(t.goal, t.progress(p, state));
          const lead = done ? pixelIcon("check") : `<b style="color:var(--ink)">${prog}/${t.goal}</b>`;
          return `<div style="font-size:11px;margin:2px 0;color:${done ? "var(--ink-soft)" : "var(--ink)"};${done ? "text-decoration:line-through" : ""}">` +
            `${lead} ${t.desc} <span style="color:var(--gilt);font-weight:700">+${t.reward}${pixelIcon("coin")}</span></div>`;
        }).join("")
      : "";

    this.chronicle.innerHTML =
      this.panelHeading("The Chronicle") +
      objectiveHtml +
      econHtml +
      statLine +
      tasksHtml +
      (recent.length
        ? recent.map((e) => `<div style="margin:3px 0"><b style="color:var(--gilt)">D${e.day}</b> <span style="color:var(--ink)">${e.text}</span></div>`).join("")
        : `<div style="color:var(--ink-soft)">Your history begins…</div>`) +
      pastHtml;

    // Hint line.
    if (!p.home) {
      this.hint.style.display = "block";
      this.hint.textContent = "Found your Camp: click a lit tile near wood, water and food.";
    } else if (this.placingId) {
      const def = getBuilding(this.placingId);
      this.hint.style.display = "block";
      this.hint.textContent = `Placing ${def.name} — click a valid tile (Esc to cancel).`;
    } else if (this.selectedCitizenId != null) {
      this.hint.style.display = "block";
      this.hint.textContent = "Click a resource node or building to command this citizen (Esc to cancel).";
    } else {
      this.hint.style.display = "none";
    }
  }

  /** So the hint line can explain what a click will do (spec §6). */
  setSelectedCitizen(id: number | null): void {
    this.selectedCitizenId = id;
    // Only rebuild the job menu's DOM when the selection actually changes —
    // this is called every render frame, and the diplomacy panel bug (a
    // button destroyed/recreated mid-click silently eats the click) taught
    // that lesson the hard way.
    if (id === this.jobMenuForCitizen) return;
    this.jobMenuForCitizen = id;
    if (id === null) {
      this.jobMenu.style.display = "none";
      return;
    }
    this.jobMenu.style.display = "flex";
    this.jobMenu.innerHTML = this.panelHeading("Assign Duty");
    for (const { role, label } of JOB_ROLES) {
      const btn = document.createElement("button");
      btn.innerHTML = label;
      btn.style.cssText = this.woodBtnStyle("text-align:left;");
      btn.onclick = () => this.cb.onAssignRole(role);
      this.jobMenu.appendChild(btn);
    }
  }

  toast(text: string): void {
    const el = document.createElement("div");
    el.innerHTML = emojiifyText(text);
    // A torn scrap of parchment tacked up with a wax-red note.
    el.style.cssText =
      "background:linear-gradient(158deg,var(--parch-1),var(--parch-3));" +
      "border:2px solid var(--oak-dk);border-radius:3px;" +
      "box-shadow:inset 0 0 0 1px var(--gilt), 0 4px 12px rgba(0,0,0,.5);" +
      "padding:6px 14px;color:var(--ink);font-weight:600;" +
      "opacity:0;transition:opacity .2s;";
    this.toastWrap.appendChild(el);
    // Cap to the 3 most recent (spec: "there should only be 3 alerts at once")
    // — gathering spam like "Tree chopped +6 wood" fires constantly, so drop
    // the oldest immediately once a 4th arrives rather than stacking a wall of
    // notes down the screen.
    while (this.toastWrap.childElementCount > MAX_TOASTS) {
      this.toastWrap.firstElementChild?.remove();
    }
    requestAnimationFrame(() => (el.style.opacity = "1"));
    setTimeout(() => {
      el.style.opacity = "0";
      setTimeout(() => el.remove(), 300);
    }, 3600);
  }

  showEvent(event: GameEvent, onChoose: (index: number) => void): void {
    this.showChoiceModal(event.title, event.body, event.choices.map((c) => c.label), onChoose);
  }

  /** AI-initiated diplomatic offer (spec §12). */
  showProposal(proposal: Proposal, civName: string, onDecide: (accept: boolean) => void): void {
    const title = `${civName} sends an envoy`;
    this.showChoiceModal(title, proposal.text, ["Accept", "Decline"], (i) => onDecide(i === 0));
  }

  /** Shared modal: a title, body, and a vertical list of choice buttons.
   * Public so Game.ts can drive the first-time tutorial (spec: "a short
   * guided overlay introducing the HUD for new players") through the same
   * parchment-card presentation as events, without a second UI system. */
  showChoiceModal(
    title: string,
    body: string,
    choices: string[],
    onChoose: (index: number) => void,
  ): void {
    this.modal.style.display = "flex";
    const card = document.createElement("div");
    // A proclamation on parchment, framed in oak with a gilt band.
    card.style.cssText =
      "max-width:460px;color:var(--ink);border-radius:5px;padding:22px 24px;" +
      "background:linear-gradient(158deg,var(--parch-1) 0%,var(--parch-2) 55%,var(--parch-3) 100%);" +
      "border:4px solid var(--oak-dk);" +
      "box-shadow:inset 0 0 0 2px var(--gilt), inset 0 0 40px rgba(120,80,28,0.28), 0 16px 50px rgba(0,0,0,.6);";
    card.innerHTML =
      `<div style="text-align:center;color:var(--gilt);letter-spacing:.35em;font-size:12px;margin-bottom:4px">${pixelIcon("fleur")} ${pixelIcon("fleur")} ${pixelIcon("fleur")}</div>` +
      `<div style="font-size:21px;font-weight:700;color:var(--royal);text-align:center;` +
      `letter-spacing:0.03em;margin-bottom:4px;text-shadow:0 1px 0 rgba(255,242,208,0.55)">${title}</div>` +
      `<div style="border-top:1px solid var(--gilt);margin:8px 0 12px"></div>` +
      `<div style="color:var(--ink);margin-bottom:16px;font-size:15px;line-height:1.5">${body}</div>`;
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;flex-direction:column;gap:9px";
    choices.forEach((label, i) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText = this.woodBtnStyle("text-align:left;font-size:14px;padding:10px 14px;");
      b.onclick = () => {
        this.modal.style.display = "none";
        this.modal.innerHTML = "";
        onChoose(i);
      };
      btns.appendChild(b);
    });
    card.appendChild(btns);
    this.modal.innerHTML = "";
    this.modal.appendChild(card);
  }

  /** Diplomacy panel: one row per discovered rival with stance + actions.
   * Always visible (even before any rival is discovered) — hiding the entry
   * point entirely made the feature look missing/broken rather than simply
   * not applicable yet. */
  /** Persistent citizen roster (spec: "on the side it shows the citizens
   * you have and they can change the job of that citizen") — clicking a row
   * selects that citizen the same way clicking them on the map does, which
   * pops the existing job-menu (setSelectedCitizen already handles that). */
  /** Blacksmith tool shop (spec: "buy axes, pick axes, swords, iron, etc"). */
  private blacksmith(civ: Civ): void {
    if (!this.blacksmithOpen) return;
    const built = civ.buildings.some((b) => b.id === "blacksmith" && b.complete);
    // Signature-diff guard (see the diplomacy-panel comment above) — this
    // has purchase buttons too, so a 60fps rebuild could eat a click.
    const signature = `${built}:${civ.tools.join(",")}:` +
      Tools.map((t) => `${t.id}:${civ.has(t.cost)}`).join("|");
    if (signature === this.blacksmithSignature) return;
    this.blacksmithSignature = signature;

    this.blacksmithPanel.innerHTML = this.panelHeading("The Forge");
    if (!built) {
      this.blacksmithPanel.innerHTML +=
        `<div style="color:var(--ink-soft);font-size:12px">Raise a Blacksmith to fire the forge and hammer out tools.</div>`;
      return;
    }
    for (const tool of Tools) {
      const owned = civ.tools.includes(tool.id);
      const affordable = civ.has(tool.cost);
      const costText = Object.entries(tool.cost)
        .map(([r, a]) => `${a}${emojiIcon(Resources.find((x) => x.id === r)?.icon ?? "")}`)
        .join(" ");
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;padding:6px 0;" +
        "border-bottom:1px solid rgba(90,60,25,0.35);gap:8px;";
      row.innerHTML =
        `<div><div style="font-weight:700;color:var(--ink)">${emojiIcon(tool.icon)} ${tool.name}</div>` +
        `<div style="font-size:11px;color:var(--ink-soft)">${tool.desc}</div></div>`;
      const btn = document.createElement("button");
      btn.innerHTML = owned ? `Forged ${pixelIcon("check")}` : costText;
      btn.disabled = owned || !affordable;
      btn.style.cssText = owned
        ? this.woodBtnStyle("min-width:74px;background:linear-gradient(180deg,#5a7a3e,#3f5a28);border-color:#243a15;color:#eef6dc;")
        : this.woodBtnStyle("min-width:74px;");
      if (!owned && affordable) btn.onclick = () => this.cb.onBuyTool(tool.id);
      row.appendChild(btn);
      this.blacksmithPanel.appendChild(row);
    }
  }

  private roster(civ: Civ, selectedId: number | null): void {
    const signature = civ.citizens
      .map((c) => `${c.id}:${c.name}:${c.job}:${c.assignedRole ?? ""}:${Math.round(c.health)}:${Math.round(c.hunger)}:${c.isLeader}:${c.jobLocked ?? false}`)
      .join("|") + `#${selectedId}#${civ.automationMode}`;
    if (signature === this.citizenPanelSignature) return;
    this.citizenPanelSignature = signature;

    this.citizenPanel.innerHTML = this.panelHeading(`Muster Roll (${civ.citizens.length})`);

    // Automation mode (spec: "support automation modes — Manual, Smart
    // Automation, Full Automation") — a civ-wide default for how idle
    // citizens pick their own work; a locked citizen ignores this entirely.
    const AUTOMATION_MODES: { mode: "manual" | "smart" | "full"; label: string; title: string }[] = [
      { mode: "manual", label: "Manual", title: "Idle citizens do nothing on their own — you assign every job." },
      { mode: "smart", label: "Smart", title: "Idle citizens build, then gather whatever's nearest (default)." },
      { mode: "full", label: "Full", title: "Smart, plus idle citizens are steered toward food/water shortages first." },
    ];
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;gap:3px;margin-bottom:6px";
    for (const m of AUTOMATION_MODES) {
      const b = document.createElement("button");
      b.textContent = m.label;
      b.title = m.title;
      const active = civ.automationMode === m.mode;
      b.style.cssText = this.woodBtnStyle(
        `flex:1;padding:3px 4px;font-size:10px;${active ? "background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));color:#3a1608;border-color:var(--royal);" : ""}`,
      );
      b.onclick = () => this.cb.onSetAutomationMode(m.mode);
      modeRow.appendChild(b);
    }
    this.citizenPanel.appendChild(modeRow);

    for (const c of civ.citizens) {
      const row = document.createElement("div");
      const selected = c.id === selectedId;
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:4px;cursor:pointer;" +
        "padding:5px 7px;border-radius:3px;margin-bottom:2px;" +
        `border:1px solid ${selected ? "var(--royal)" : "rgba(90,60,25,0.35)"};` +
        `background:${selected ? "rgba(168,53,42,0.14)" : "rgba(120,80,28,0.10)"};`;
      row.title = "Click to assign a duty";
      const label = document.createElement("span");
      label.innerHTML = `${c.isLeader ? pixelIcon("sword") + " " : ""}<b style="color:var(--ink)">${c.name}</b>`;
      label.style.cssText = "overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:96px;";
      const hp = Math.round(c.health);
      const hpColor = hp > 60 ? "var(--forest)" : hp > 30 ? "var(--gilt)" : "var(--royal)";
      const hungry = c.hunger >= 70;
      const health = document.createElement("span");
      health.style.cssText = `color:${hpColor};font-size:11px;white-space:nowrap;font-weight:600`;
      health.innerHTML = `${pixelIcon("heart")}${hp}${hungry ? ` <span title="Hungry" style="color:var(--royal)">${pixelIcon("meat")}!</span>` : ""}`;
      const job = document.createElement("span");
      job.style.cssText = "color:var(--ink-soft);font-size:11px;white-space:nowrap;";
      // Show the assigned duty (Woodcutter, Miner…) when the player picked one,
      // else the transient activity (Gathering/Hauling) for auto-managed folk.
      job.innerHTML = (c.assignedRole && ROLE_LABEL[c.assignedRole]) || CITIZEN_JOB_LABEL[c.job] || c.job;
      // Job lock (spec: "let the player choose whether a citizen's job can
      // be automatically changed") — only meaningful with a role assigned.
      const lock = document.createElement("button");
      const locked = !!c.jobLocked;
      lock.textContent = locked ? "🔒" : "🔓";
      lock.title = c.assignedRole
        ? (locked ? "Locked — always returns to this duty. Click to unlock." : "Unlocked — automation may reassign this duty. Click to lock.")
        : "Assign a duty first, then lock it.";
      lock.style.cssText =
        "background:none;border:none;padding:0 2px;cursor:pointer;font-size:12px;line-height:1;" +
        `opacity:${c.assignedRole ? 1 : 0.35};flex-shrink:0;`;
      lock.disabled = !c.assignedRole;
      lock.onclick = (e) => { e.stopPropagation(); this.cb.onToggleJobLock(c.id); };
      row.append(label, health, job, lock);
      row.onclick = () => this.cb.onSelectCitizen(c.id);
      this.citizenPanel.appendChild(row);
    }
  }

  private diplomacy(state: GameState, myCivId: number): void {
    // AI rivals still need discovering first; other real players in a
    // multiplayer match are never hidden from this panel — you already know
    // they exist (bug report: "when I declare war with a country I should be
    // able to attack them as well" — the panel only ever listed AI civs, so
    // there was no way to declare war on another human player at all).
    const rivals = state.civs.filter((c) => c.id !== myCivId && (c.isAI ? c.ai?.discoveredByPlayer : true));
    const myCiv = state.civs[myCivId];

    if (!this.diploOpen) return;

    // Rebuilding this panel's DOM every frame (this is called from the 60fps
    // render loop) destroyed and recreated every button each frame — if a
    // click's mousedown/mouseup straddled a rebuild, the button was gone
    // before mouseup fired and the click silently never registered. Only
    // rebuild when the actual displayed data changes.
    const signature = rivals
      .map((c) => `${c.id}:${state.relations.stance(c.id, myCivId)}:${Math.round(state.relations.opinion(c.id, myCivId))}` +
        `:${myCiv.scoutedRivals.includes(c.id)}:${c.citizens.length}:${Math.floor(c.stock.gold ?? 0)}`)
      .join("|");
    if (signature === this.diploSignature) return;
    this.diploSignature = signature;

    this.diploPanel.innerHTML = this.panelHeading("Court of Envoys");
    if (!rivals.length) {
      this.diploPanel.innerHTML +=
        `<div style="color:var(--ink-soft)">No rival realms discovered yet. Send your lord to explore, ` +
        `or "Take the map" when the shipwrecked sailor washes ashore, to find one.</div>`;
      return;
    }
    for (const civ of rivals) {
      const stance = state.relations.stance(civ.id, myCivId);
      const opinion = state.relations.opinion(civ.id, myCivId);
      const st = STANCE_STYLE[stance];
      const pct = Math.round(((opinion + 100) / 200) * 100);

      const scouted = myCiv.scoutedRivals.includes(civ.id);
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:12px;padding-bottom:10px;border-bottom:1px solid rgba(90,60,25,0.35)";
      row.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px">` +
        `<b style="color:var(--ink)">${pixelIcon("flag")} ${civ.name}</b>` +
        `<span style="color:${st.color};font-size:12px;font-weight:700">${st.label}</span></div>` +
        `<div title="Their regard for you: ${opinion}" style="height:7px;border-radius:2px;background:rgba(60,40,18,0.35);border:1px solid var(--oak-dk);margin-bottom:6px">` +
        `<div style="height:100%;border-radius:1px;width:${pct}%;background:${st.color}"></div></div>` +
        (scouted
          ? `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">${pixelIcon("compass")} Intel: ` +
            `${pixelIcon("person")}${civ.citizens.length} · ${pixelIcon("coin")}${Math.floor(civ.stock.gold ?? 0)}</div>`
          : "");

      const actions: DiploAction[] =
        stance === "war"
          ? ["peace", "gift"]
          : stance === "alliance"
            ? ["gift", "trade", "war"]
            : ["alliance", "pact", "gift", "trade", "war"];

      const bar = document.createElement("div");
      bar.style.cssText = "display:flex;flex-wrap:wrap;gap:5px";
      for (const action of actions) {
        const b = document.createElement("button");
        b.textContent = DIPLO_LABEL[action];
        const danger = action === "war";
        b.style.cssText = danger
          ? this.woodBtnStyle("padding:4px 9px;background:linear-gradient(180deg,var(--royal-lt),var(--royal));border-color:#3a0f0a;")
          : this.woodBtnStyle("padding:4px 9px;");
        b.onclick = () => this.cb.onDiplo(action, civ.id);
        bar.appendChild(b);
      }
      // Espionage (spec: "scout or sabotage a rival civ instead of only
      // fighting/trading with them") — a third posture, no Stance required.
      const scoutBtn = document.createElement("button");
      scoutBtn.innerHTML = `${pixelIcon("compass")} Scout (15${pixelIcon("coin")})`;
      scoutBtn.style.cssText = this.woodBtnStyle("padding:4px 9px;");
      scoutBtn.onclick = () => this.cb.onScout(civ.id);
      bar.appendChild(scoutBtn);
      const sabotageBtn = document.createElement("button");
      sabotageBtn.innerHTML = `${pixelIcon("dagger")} Sabotage (30${pixelIcon("coin")})`;
      sabotageBtn.style.cssText = this.woodBtnStyle(
        "padding:4px 9px;background:linear-gradient(180deg,var(--royal-lt),var(--royal));border-color:#3a0f0a;",
      );
      sabotageBtn.onclick = () => this.cb.onSabotage(civ.id);
      bar.appendChild(sabotageBtn);
      row.appendChild(bar);
      this.diploPanel.appendChild(row);
    }
  }

  /** Leader status bar: name, level, XP, health & hunger, earned traits. */
  private updateLeaderBar(civ: Civ): void {
    const leader = civ.leader;
    if (!leader) {
      this.leaderBar.style.display = "none";
      this.interactBtn.style.display = "none";
      this.leaderWorkBtn.style.display = "none";
      this.eatBtn.style.display = "none";
      return;
    }
    this.leaderBar.style.display = "block";
    this.interactBtn.style.display = "block";
    this.leaderWorkBtn.style.display = "block";
    this.eatBtn.style.display = "block";
    this.leaderWorkBtn.innerHTML = leader.job === "idle"
      ? `${pixelIcon("briefcase")} Work`
      : `${pixelIcon("briefcase")} Working: ${leader.job}`;
    const need = civ.leaderLevel * 150;
    const xpPct = Math.min(100, Math.round((civ.leaderXp / need) * 100));
    const hp = Math.round(leader.health);
    const fed = Math.max(0, Math.min(100, 100 - Math.round(leader.hunger))); // 100 = full
    const traitNames = civ.leaderTraits.map((id) => getLeaderTrait(id)?.name).filter(Boolean).join(", ");
    const meter = (label: string, pct: number, fill: string) =>
      `<div style="display:flex;align-items:center;gap:5px;margin-top:3px">` +
      `<span style="font-size:11px;width:14px;text-align:center">${label}</span>` +
      `<div style="flex:1;height:7px;background:rgba(60,40,18,0.35);border:1px solid var(--oak-dk);border-radius:2px">` +
      `<div style="height:100%;width:${pct}%;background:${fill};border-radius:1px"></div></div>` +
      `<span style="font-size:11px;width:26px;text-align:right;color:var(--ink-soft)">${pct}</span></div>`;
    this.leaderBar.innerHTML =
      `<div style="font-weight:700;font-size:14px;color:var(--royal)">${pixelIcon("sword")} ${leader.name}</div>` +
      `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:2px">Lord of the Realm · Level ${civ.leaderLevel}</div>` +
      meter(pixelIcon("heart"), hp, "linear-gradient(90deg,#7c2118,#b23a2a)") +
      meter(pixelIcon("meat"), fed, "linear-gradient(90deg,#7a5a1e,#c99a2e)") +
      meter(pixelIcon("sun"), xpPct, "linear-gradient(90deg,#8a6a20,#d8b24c)") +
      `<div style="font-size:11px;color:var(--ink-soft);margin-top:4px">${pixelIcon("compass")} Click or use WASD to march · T to eat</div>` +
      (traitNames ? `<div style="font-size:11px;color:var(--royal);font-weight:600;margin-top:2px">${traitNames}</div>` : "");
  }

  /** Research panel: current era + every tech, gated/affordable state (spec §10). */
  private research(civ: Civ): void {
    this.researchBtn.title = `Era: ${civ.era}`;
    if (!this.researchOpen) return;
    const eraIdx = eraRank(civ.era);
    this.researchPanel.innerHTML =
      this.panelHeading("Hall of Wisdom") +
      `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:8px">Age: ${civ.era} (${eraIdx + 1}/${Eras.length}) · ${pixelIcon("brain")} ${Math.floor(civ.stock.knowledge ?? 0)} Knowledge</div>`;
    for (const tech of Techs) {
      const done = civ.researched.includes(tech.id);
      const check = canResearch(civ, tech.id);
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(90,60,25,0.35)";
      row.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center">` +
        `<b style="color:${tech.type === "era" ? "var(--royal)" : "var(--ink)"}">${tech.name}</b>` +
        `<span style="font-size:11px;color:var(--ink-soft)">${pixelIcon("brain")}${tech.cost}</span></div>` +
        `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:4px">${tech.desc}</div>`;
      const btn = document.createElement("button");
      btn.innerHTML = done ? `Studied ${pixelIcon("check")}` : "Study";
      btn.disabled = done || !check.ok;
      btn.title = done ? "" : check.message;
      btn.style.cssText = done
        ? this.woodBtnStyle("padding:4px 12px;background:linear-gradient(180deg,#5a7a3e,#3f5a28);border-color:#243a15;color:#eef6dc;")
        : this.woodBtnStyle("padding:4px 12px;");
      if (!done && check.ok) btn.onclick = () => this.cb.onResearch(tech.id);
      row.appendChild(btn);
      this.researchPanel.appendChild(row);
    }
  }

  /** Citizen inspect tooltip (spec §6: citizens are characters, not numbers). */
  showCitizenTip(c: Citizen, _civColor: string, screen: { x: number; y: number }): void {
    const traitNames = c.traits.map((id) => getCitizenTrait(id)?.name).filter(Boolean).join(", ");
    this.citizenTip.style.display = "block";
    this.citizenTip.style.left = `${screen.x + 14}px`;
    this.citizenTip.style.top = `${screen.y - 10}px`;
    const fed = Math.max(0, Math.min(100, 100 - Math.round(c.hunger)));
    this.citizenTip.innerHTML =
      `<div style="font-weight:700;color:var(--royal)">${c.isLeader ? pixelIcon("crown") + " " : ""}${c.name}</div>` +
      `<div style="color:var(--ink-soft)">Duty: ${(c.assignedRole && ROLE_LABEL[c.assignedRole]) || CITIZEN_JOB_LABEL[c.job] || c.job} · Age ${c.age}</div>` +
      `<div>${pixelIcon("heart")} ${Math.round(c.health)} · ${pixelIcon("meat")} ${fed} · ${pixelIcon("smile")} ${Math.round(c.morale)} · ${pixelIcon("handshake")} ${Math.round(c.loyalty)}</div>` +
      `<div style="color:var(--ink-soft)">${pixelIcon("tools")} skill ${Math.round(c.skill)} · ${pixelIcon("sun")} xp ${Math.round(c.experience)}</div>` +
      (traitNames ? `<div style="color:var(--royal);font-weight:600">${traitNames}</div>` : "") +
      (c.parentName ? `<div style="color:var(--ink-soft);font-style:italic">Child of ${c.parentName}</div>` : "");
  }

  hideCitizenTip(): void {
    this.citizenTip.style.display = "none";
  }

  /** Victory banner (spec §16). Doesn't stop the match — just announces it. */
  showVictory(kind: string, civName: string, isMe: boolean): void {
    const title = isMe ? `${pixelIcon("trophy")} Victory!` : `${pixelIcon("trophy")} The Isle Has a Champion`;
    const body = isMe
      ? `Your civilization achieved a ${kind} victory! You may keep playing.`
      : `${civName} achieved a ${kind} victory. The match continues.`;
    this.showChoiceModal(title, body, ["Continue"], () => {});
  }

  /** Game-over sign: the leader has fallen and, unlike a rival's leader
   * dying, there's no one left to hand the human's own civ to (see
   * CombatSystem/WildlifeSystem's "leaderFallsToWildlife" comments) — so
   * this is the one modal that ends the run rather than just announcing
   * something mid-match. Single "Next" choice back to the main menu. */
  showGameOver(daysSurvived: number): Promise<void> {
    return new Promise((resolve) => {
      this.showChoiceModal(
        `${pixelIcon("skull")} Game Over`,
        `Your leader has fallen. Your realm survived ${daysSurvived} day${daysSurvived === 1 ? "" : "s"}.`,
        ["Next"],
        () => resolve(),
      );
    });
  }

  /** In-game settings / pause overlay (spec: "settings tab... which serves a
   * pause. has a 'save and exit', volume, and the control change/ key bind").
   * Built on the shared parchment modal. Returns nothing; the caller wires the
   * action buttons. onBindsChanged lets Game re-read the keymap live. */
  showPauseMenu(opts: {
    onResume: () => void;
    onSaveExit: () => void;
    onExitNoSave: () => void;
    onBindsChanged: () => void;
  }): void {
    this.modal.style.display = "flex";
    const card = document.createElement("div");
    card.style.cssText =
      "max-width:460px;width:92%;color:var(--ink);border-radius:5px;padding:22px 24px;max-height:88vh;overflow:auto;" +
      "background:linear-gradient(158deg,var(--parch-1) 0%,var(--parch-2) 55%,var(--parch-3) 100%);" +
      "border:4px solid var(--oak-dk);" +
      "box-shadow:inset 0 0 0 2px var(--gilt), inset 0 0 40px rgba(120,80,28,0.28), 0 16px 50px rgba(0,0,0,.6);";
    card.innerHTML =
      `<div style="text-align:center;color:var(--gilt);letter-spacing:.35em;font-size:12px;margin-bottom:4px">${pixelIcon("fleur")} ${pixelIcon("fleur")} ${pixelIcon("fleur")}</div>` +
      `<div style="font-size:21px;font-weight:700;color:var(--royal);text-align:center;letter-spacing:.03em;margin-bottom:8px">Paused</div>` +
      `<div style="border-top:1px solid var(--gilt);margin:8px 0 12px"></div>`;

    // --- Volume ---
    const volWrap = document.createElement("div");
    volWrap.style.cssText = "margin-bottom:14px";
    const volLabel = document.createElement("div");
    volLabel.style.cssText = "font-size:12px;color:var(--ink-soft);margin-bottom:4px;display:flex;justify-content:space-between";
    const vol = loadVolume();
    volLabel.innerHTML = `<span>Volume</span><span id="__volval">${isMuted() ? "Muted" : Math.round(vol * 100) + "%"}</span>`;
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px";
    const muteBtn = document.createElement("button");
    muteBtn.style.cssText = this.woodBtnStyle("padding:6px 10px;min-width:64px");
    const setMuteLabel = (): void => { muteBtn.textContent = isMuted() ? "Unmute" : "Mute"; };
    setMuteLabel();
    muteBtn.onclick = () => {
      setMuted(!isMuted());
      setMuteLabel();
      (card.querySelector("#__volval") as HTMLElement).textContent = isMuted() ? "Muted" : Math.round(loadVolume() * 100) + "%";
    };
    const slider = document.createElement("input");
    slider.type = "range"; slider.min = "0"; slider.max = "100"; slider.value = String(Math.round(vol * 100));
    slider.style.cssText = "flex:1;accent-color:var(--gilt);pointer-events:auto;cursor:pointer";
    slider.oninput = () => {
      const v = Number(slider.value) / 100;
      setVolume(v); saveVolume(v);
      if (isMuted() && v > 0) { setMuted(false); setMuteLabel(); }
      (card.querySelector("#__volval") as HTMLElement).textContent = isMuted() ? "Muted" : slider.value + "%";
    };
    row.append(muteBtn, slider);
    volWrap.append(volLabel, row);
    card.appendChild(volWrap);

    // --- Controls / keybinds ---
    const ctrlHead = document.createElement("div");
    ctrlHead.style.cssText = "font-size:12px;color:var(--ink-soft);margin:6px 0 4px;font-weight:700";
    ctrlHead.textContent = "Controls — click a key to rebind";
    card.appendChild(ctrlHead);
    const binds = loadKeyBinds();
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:1fr auto;gap:5px 10px;align-items:center;margin-bottom:14px";
    (Object.keys(BIND_LABELS) as BindAction[]).forEach((action) => {
      const lab = document.createElement("div");
      lab.style.cssText = "font-size:13px;color:var(--ink)";
      lab.textContent = BIND_LABELS[action];
      const key = document.createElement("button");
      key.style.cssText = this.woodBtnStyle("padding:4px 10px;min-width:60px;text-align:center;text-transform:uppercase");
      key.textContent = binds[action];
      key.onclick = () => {
        key.textContent = "press…";
        const capture = (e: KeyboardEvent): void => {
          e.preventDefault();
          e.stopPropagation();
          const k = e.key.length === 1 ? e.key.toLowerCase() : e.key.toLowerCase();
          binds[action] = k;
          saveKeyBinds(binds);
          key.textContent = k;
          opts.onBindsChanged();
          window.removeEventListener("keydown", capture, true);
        };
        window.addEventListener("keydown", capture, true);
      };
      grid.append(lab, key);
    });
    card.appendChild(grid);

    // --- Action buttons ---
    const btns = document.createElement("div");
    btns.style.cssText = "display:flex;flex-direction:column;gap:9px";
    const mk = (label: string, cb: () => void, primary = false): HTMLButtonElement => {
      const b = document.createElement("button");
      b.innerHTML = label; // labels may embed a pixelIcon <img>
      b.style.cssText = this.woodBtnStyle("text-align:center;font-size:14px;padding:10px 14px;" +
        (primary ? "background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));color:#2c1e0d;border-color:#5a3e12;" : ""));
      b.onclick = () => { this.closeModal(); cb(); };
      return b;
    };
    btns.append(
      mk("Resume", opts.onResume, true),
      mk(`${pixelIcon("bank")} Save & Exit to Menu`, opts.onSaveExit),
      mk("Exit without Saving", opts.onExitNoSave),
    );
    card.appendChild(btns);

    this.modal.innerHTML = "";
    this.modal.appendChild(card);
  }

  /** Hide the shared modal without invoking any choice callback. */
  closeModal(): void {
    this.modal.style.display = "none";
    this.modal.innerHTML = "";
  }

  /** Removes every element Hud created (see constructor note on this.root) —
   * needed now that a match can end back into the main menu (game over)
   * instead of Hud living for the page's whole lifetime. */
  destroy(): void {
    this.root.remove();
  }
}

const DIPLO_LABEL: Record<DiploAction, string> = {
  alliance: "Alliance",
  pact: "Pact",
  war: "Declare War",
  peace: "Make Peace",
  gift: "Send Gift",
  trade: "Trade",
};

function resIcon(r: ResourceId): string {
  return emojiIcon(Resources.find((x) => x.id === r)?.icon ?? "");
}
function seasonIcon(s: string): string {
  return emojiIcon({ spring: "🌱", summer: "☀️", autumn: "🍂", winter: "❄️" }[s] ?? "");
}
