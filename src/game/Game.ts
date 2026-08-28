// The CLIENT (spec §36 Phase 4-5). It owns nothing authoritative: it reads
// read-only Snapshots from the Transport to render, turns player input into
// serializable Commands, and drives decision modals off ServerEvents. All world
// mutation happens on the far side of the Transport, inside the Simulation.
//
// The same client code drives either transport: LocalTransport (an in-tab
// Simulation, offline/solo) or NetworkTransport (a real WebSocket to
// server/index.ts, real multiplayer) — picked once at construction.

import { LocalTransport, type Transport } from "../net/Transport.ts";
import { NetworkTransport } from "../net/NetworkTransport.ts";
import type { Command } from "../net/protocol.ts";
import { Camera } from "../render/Camera.ts";
import { Renderer } from "../render/Renderer.ts";
import { Hud } from "../ui/Hud.ts";
import { pixelIcon } from "../ui/PixelIcons.ts";
import { playSound } from "../ui/AudioSystem.ts";
import type { GameSignal } from "../core/events.ts";
import type { Vec2, DiploAction, Proposal } from "../core/types.ts";
import type { GameState } from "./GameState.ts";
import type { GameEvent } from "./config.ts";
import { getEvent } from "../systems/EventSystem.ts";
import { hasSeenTutorial, markTutorialSeen } from "../net/profileStore.client.ts";
import { setVolume } from "../ui/AudioSystem.ts";
import { loadKeyBinds, loadVolume, type KeyBinds } from "../net/settings.client.ts";
import { writeSave } from "../net/saveStore.client.ts";

type Decision =
  | { kind: "event"; event: GameEvent }
  | { kind: "proposal"; proposal: Proposal; civName: string }
  | { kind: "tutorial"; step: number }
  | { kind: "gameOver"; daysSurvived: number };

/** First-time tutorial (spec: "a short guided overlay introducing the HUD
 * for new players... research/diplomacy/blacksmith/jobs is a lot to
 * discover blind") — a handful of steps through the parts of the HUD that
 * exist the moment a camp is founded, reusing the same parchment-card modal
 * events already use rather than a second UI system. */
const TUTORIAL_STEPS: { title: string; body: string }[] = [
  {
    title: "Welcome, Ruler",
    body: "Click anywhere or use WASD to march your leader across the isle. Press E to interact — it chops wood, mines stone, hunts animals, or fights whatever's in range, whichever applies.",
  },
  {
    title: "Your People",
    body: "The roster on the left lists your citizens. Click one, then pick a duty — farmer, woodcutter, soldier, archer, and more.",
  },
  {
    title: "The Bottom Bar",
    body: "Research unlocks new eras and technology. Work puts you to a job yourself. Recruit welcomes new citizens. Blacksmith sells tools. Eat (T) sates your leader's hunger. Drag right for more buildings to place.",
  },
  {
    title: "Diplomacy & Espionage",
    body: "The Diplomacy panel (bottom-right) lets you ally, trade, or declare war on rivals you've discovered — or scout and sabotage them quietly instead, no war required.",
  },
  {
    title: "Raise Your Realm",
    body: "That covers the essentials — everything else you'll find by exploring. Good luck out there.",
  },
];

export interface GameOptions {
  seed?: number;
  /** If given (e.g. "ws://localhost:8790"), connects to a real multiplayer
   * server via NetworkTransport instead of running solo locally. */
  serverUrl?: string;
  /** Leader customization from the main menu (spec §5). */
  leaderName?: string;
  /** Solo mode only — see Simulation's civColor note on multiplayer collisions. */
  civColor?: string;
  /** Opt-in difficulty (spec: leader death shouldn't unfairly end a normal
   * run by default — see GameState.hardcoreLeaderDeath). Solo mode only. */
  hardcoreLeaderDeath?: boolean;
  /** Continue a saved solo game — a fully rehydrated state (serialize.rehydrateSave). */
  restoreState?: import("./GameState.ts").GameState;
  /** Which of the 3 save slots this game writes to on Save & Exit. */
  saveSlot?: number;
}

export class Game {
  private transport: Transport;
  private cam: Camera;
  private renderer: Renderer;
  private hud: Hud;
  private canvas: HTMLCanvasElement;

  /** Which civ this client controls — assigned by the server, not chosen locally. */
  private myCivId = 0;

  private placingId: string | null = "camp";
  private hover: Vec2 | null = null;
  private dragging = false;
  private dragMoved = false;
  private lastMouse: Vec2 = { x: 0, y: 0 };

  private decisions: Decision[] = [];
  private modalOpen = false;
  private tutorialShown = false;
  private gameOverShown = false;
  private renderRunning = false;
  private heldKeys = new Set<string>();
  /** A non-leader citizen awaiting a job assignment click (spec §6). */
  private selectedCitizenId: number | null = null;
  /** Rebindable movement/action keys (spec: pause-menu key binds). */
  private binds: KeyBinds = loadKeyBinds();
  /** Which save slot this run persists to (undefined in multiplayer). */
  private saveSlot?: number;
  private paused = false;

  constructor(mount: HTMLElement, options: GameOptions = {}, private onGameOver?: () => void) {
    const seed = options.seed ?? (Date.now() & 0xffff);
    const serverUrl = options.serverUrl;
    this.saveSlot = options.saveSlot;
    setVolume(loadVolume());
    this.transport = serverUrl
      ? new NetworkTransport(serverUrl, options.leaderName)
      : new LocalTransport(seed, {
          leaderName: options.leaderName,
          civColor: options.civColor,
          hardcoreLeaderDeath: options.hardcoreLeaderDeath,
          restoreState: options.restoreState,
        });
    this.canvas = document.createElement("canvas");
    mount.appendChild(this.canvas);
    this.cam = new Camera(this.canvas);
    this.renderer = new Renderer(this.canvas, this.cam);
    this.hud = new Hud(mount, {
      onBuild: (id) => this.setPlacing(id),
      onCancelBuild: () => this.setPlacing(null),
      onDiplo: (action, civId) => this.sendDiplo(action, civId),
      onScout: (civId) => this.send({ type: "scoutCiv", civ: this.myCivId, targetCiv: civId }),
      onSabotage: (civId) => this.send({ type: "sabotageCiv", civ: this.myCivId, targetCiv: civId }),
      onResearch: (techId) => this.send({ type: "startResearch", civ: this.myCivId, techId }),
      onInteract: () => this.send({ type: "leaderInteract", civ: this.myCivId }),
      onAssignRole: (role) => {
        if (this.selectedCitizenId === null) return;
        this.send({ type: "assignRole", civ: this.myCivId, citizenId: this.selectedCitizenId, role });
        this.selectedCitizenId = null;
      },
      onAssignLeaderRole: (role) => {
        const leader = this.state.civs[this.myCivId]?.leader;
        if (!leader) return;
        this.send({ type: "assignRole", civ: this.myCivId, citizenId: leader.id, role });
      },
      onRecruit: () => this.send({ type: "recruitCitizen", civ: this.myCivId }),
      onBuyTool: (toolId) => this.send({ type: "purchaseTool", civ: this.myCivId, toolId }),
      onEat: () => this.send({ type: "eat", civ: this.myCivId }),
      onPause: () => this.openPauseMenu(),
      onSelectCitizen: (id) => {
        this.selectedCitizenId = this.selectedCitizenId === id ? null : id;
      },
      onToggleJobLock: (id) => {
        const c = this.state.civs[this.myCivId]?.citizens.find((x) => x.id === id);
        if (!c) return;
        this.send({ type: "setJobLock", civ: this.myCivId, citizenId: id, locked: !c.jobLocked });
      },
      onSetAutomationMode: (mode) => this.send({ type: "setAutomationMode", civ: this.myCivId, mode }),
    });

    this.transport.onServerEvent((s) => this.onSignal(s));
    this.bindInput();
    this.renderer.resize();
    window.addEventListener("resize", this.onWindowResize);

    void this.init(serverUrl);
  }

  /** Connect (or start the local sim), then aim the camera and begin rendering. */
  private async init(serverUrl?: string): Promise<void> {
    if (serverUrl) this.hud.toast("Connecting to server…");
    this.transport.start();
    await this.transport.ready();
    this.myCivId = this.transport.myCivId();

    const start = this.transport.playerStart();
    this.cam.x = start.x;
    this.cam.y = start.y;
    if (serverUrl) this.hud.toast(`Connected — you are civ ${this.myCivId}.`);

    // requestAnimationFrame, not setInterval: setInterval queues up missed
    // callbacks and fires them back-to-back once the main thread frees up
    // (a GC pause, a big Hud rebuild, anything) — which reads as exactly the
    // "input registers, then a few seconds later everything lurches to catch
    // up" glitch (spec bug report). rAF has no backlog to drain: a delayed
    // frame just renders once at the next available paint, using the
    // snapshot's true current position, so a stall shows as one late frame
    // instead of a queue of stale ones replaying in fast-forward.
    this.renderRunning = true;
    const loop = (): void => {
      if (!this.renderRunning) return;
      this.render();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // Window-level listeners (see bindInput) outlive the canvas they're
  // conceptually "for" — window itself is never removed, so unlike the
  // canvas-scoped listeners below, these leak across a whole page lifetime
  // unless destroy() explicitly detaches them by the same reference. Stored
  // as bound instance fields (not inline arrow functions) specifically so
  // removeEventListener can find the exact function it needs to remove.
  private onWindowResize = (): void => this.renderer.resize();
  private onWindowMouseUp = (): void => {
    this.dragging = false;
  };
  private isMoveKey(k: string): boolean {
    const b = this.binds;
    return [b.up, b.down, b.left, b.right, "arrowup", "arrowdown", "arrowleft", "arrowright"].includes(k);
  }
  private onWindowKeyDown = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      // Escape is the pause/back key (not rebindable): first back out of
      // placement, then a citizen selection, and only with neither active does
      // it open the pause menu (spec: "settings tab... which serves a pause").
      if (this.modalOpen || this.paused) return;
      if (this.placingId && this.placingId !== "camp") { this.setPlacing(null); return; }
      if (this.selectedCitizenId !== null) {
        this.selectedCitizenId = null;
        this.hud.toast("Selection cleared.");
        return;
      }
      this.openPauseMenu();
      return;
    }
    if (this.paused) return; // gameplay keys are inert while paused
    const k = e.key.toLowerCase();
    const b = this.binds;
    if (this.isMoveKey(k)) {
      this.heldKeys.add(k);
      this.sendLeaderMoveFromKeys();
    }
    if (k === b.interact || k === " ") {
      e.preventDefault();
      this.send({ type: "leaderInteract", civ: this.myCivId });
    }
    if (k === b.eat) {
      e.preventDefault();
      this.send({ type: "eat", civ: this.myCivId });
    }
    if (k === "1") this.cam.setTier("character");
    if (k === "2") this.cam.setTier("settlement");
    if (k === "3") this.cam.setTier("regional");
    if (k === "4") this.cam.setTier("world");
  };
  private onWindowKeyUp = (e: KeyboardEvent): void => {
    const k = e.key.toLowerCase();
    this.heldKeys.delete(k);
    if (this.isMoveKey(k)) this.sendLeaderMoveFromKeys();
  };
  private onWindowBlur = (): void => {
    this.heldKeys.clear();
    this.sendLeaderMoveFromKeys();
  };

  destroy(): void {
    this.renderRunning = false;
    this.transport.stop();
    // Undo bindInput's window-level listeners — left dangling, the keydown
    // handler's preventDefault() on "e"/" "/"t" would silently eat those
    // keystrokes anywhere on the page (e.g. typing a new leader's name in
    // MainMenu's input) even after this match has ended and this Game
    // instance is otherwise inert.
    window.removeEventListener("resize", this.onWindowResize);
    window.removeEventListener("mouseup", this.onWindowMouseUp);
    window.removeEventListener("keydown", this.onWindowKeyDown);
    window.removeEventListener("keyup", this.onWindowKeyUp);
    window.removeEventListener("blur", this.onWindowBlur);
    // Tear down the DOM too, not just the timers — a match can now end back
    // into the main menu (game over), so leaving the canvas/HUD mounted
    // would stack a second one underneath whatever the menu renders next.
    this.hud.destroy();
    this.canvas.remove();
  }

  /** Convenience: the latest authoritative snapshot (read-only for the client). */
  private get state(): GameState {
    return this.transport.snapshot();
  }

  private send(cmd: Command): void {
    this.transport.send(cmd);
  }

  private setPlacing(id: string | null): void {
    this.placingId = id;
    this.hud.setPlacing(id);
  }

  // ---- Server → client feedback -------------------------------------------

  private onSignal(s: GameSignal): void {
    switch (s.type) {
      case "toast":
        // Sound (spec: "there's no audio at all right now") — most toasts
        // stay silent (they already fire often enough to be visually loud
        // on their own), but the two moments a player most needs an audible
        // cue — taking damage, landing a hit — get one.
        if (/attacks you|was slain|has fallen/.test(s.text)) playSound("hurt");
        else if (/Battle Pass XP!$/.test(s.text)) playSound("achievement");
        else if (/Hunted|wound the/.test(s.text)) playSound("hit");
        this.hud.toast(s.text);
        break;
      case "citizenRecruited":
        playSound("success");
        this.hud.toast(`${pixelIcon("party")} ${s.name} joined your settlement!`);
        break;
      case "buildingComplete":
        playSound("success");
        this.hud.toast(`${pixelIcon("hammer")} Construction complete.`);
        break;
      case "rivalDiscovered":
        playSound("success");
        this.hud.toast(`${pixelIcon("flag")} You've discovered a rival civilization!`);
        break;
      // researchComplete / leaderLevelUp need no extra client action — the
      // server already emits a "toast" alongside them, and the HUD reads
      // research/leader state live from the snapshot every frame.
      case "victory":
        playSound("achievement");
        this.hud.showVictory(s.kind, s.civName, s.civId === this.myCivId);
        break;
      case "eventTriggered": {
        // A networked match may have several humans; only react to our own.
        if (s.civ !== this.myCivId) break;
        const ev = getEvent(s.eventId);
        if (ev) {
          playSound("click");
          this.decisions.push({ kind: "event", event: ev });
          this.showNextDecision();
        }
        break;
      }
      case "proposalReceived": {
        if (s.toCiv !== this.myCivId) break;
        const proposal = this.state.pendingProposals.find(
          (p) => p.fromCiv === s.fromCiv && p.toCiv === s.toCiv,
        );
        if (proposal) {
          playSound("click");
          this.decisions.push({ kind: "proposal", proposal, civName: this.state.civs[s.fromCiv].name });
          this.showNextDecision();
        }
        break;
      }
    }
  }

  /** Present one queued decision; its answer goes back to the server as a Command. */
  private showNextDecision(): void {
    if (this.modalOpen || this.decisions.length === 0) return;
    const d = this.decisions.shift()!;
    this.modalOpen = true;
    const civ = this.myCivId;
    if (d.kind === "event") {
      this.hud.showEvent(d.event, (choice) => {
        this.send({ type: "resolveEvent", civ, eventId: d.event.id, choice });
        this.modalOpen = false;
        this.showNextDecision();
      });
    } else if (d.kind === "proposal") {
      this.hud.showProposal(d.proposal, d.civName, (accept) => {
        this.send({ type: "resolveProposal", civ, fromCiv: d.proposal.fromCiv, accept });
        this.modalOpen = false;
        this.showNextDecision();
      });
    } else if (d.kind === "tutorial") {
      const step = TUTORIAL_STEPS[d.step];
      const isLast = d.step === TUTORIAL_STEPS.length - 1;
      this.hud.showChoiceModal(
        step.title,
        step.body,
        isLast ? ["Start Playing"] : ["Next", "Skip Tutorial"],
        (choiceIndex) => {
          this.modalOpen = false;
          const skipped = !isLast && choiceIndex === 1;
          if (isLast || skipped) markTutorialSeen();
          else this.decisions.unshift({ kind: "tutorial", step: d.step + 1 });
          this.showNextDecision();
        },
      );
    } else {
      // Game over (spec: "when the player dies... game over sign... put
      // them into the main menu") — terminal, so unlike every other
      // decision kind this one never re-opens the queue or resets
      // modalOpen: the match is over and onGameOver() tears the whole
      // Game instance down in favor of a fresh MainMenu.
      void this.hud.showGameOver(d.daysSurvived).then(() => this.onGameOver?.());
    }
  }

  private sendDiplo(action: DiploAction, targetCiv: number): void {
    this.send({ type: "diploAction", civ: this.myCivId, action, targetCiv });
  }

  /** Open the settings/pause overlay (spec). Freezes the sim (stops the
   * transport clock) so nothing advances while you're in the menu, and lets
   * the player rebind keys, adjust volume, save & exit, or exit. */
  private openPauseMenu(): void {
    // Never open over a live event/proposal/tutorial modal — they share the
    // same DOM slot, so pausing on top would clobber the decision the player
    // still owes an answer to.
    if (this.paused || this.modalOpen) return;
    this.paused = true;
    this.heldKeys.clear();
    this.sendLeaderMoveFromKeys(); // release any held movement so nothing drifts
    this.transport.stop();
    this.hud.showPauseMenu({
      onResume: () => {
        this.paused = false;
        this.transport.start(); // resets the clock — no accumulated time jump
      },
      onSaveExit: () => {
        this.saveGame();
        this.onGameOver?.();
      },
      onExitNoSave: () => this.onGameOver?.(),
      onBindsChanged: () => { this.binds = loadKeyBinds(); },
    });
  }

  /** Persist the live game to its save slot (spec: 3 revisitable worlds). */
  private saveGame(): boolean {
    if (this.saveSlot == null || !this.transport.serialize || !this.transport.saveInfo) return false;
    const info = this.transport.saveInfo();
    const civ = this.state.civs[this.myCivId];
    const name = civ?.leaderName ?? civ?.leader?.name?.replace(/ \(You\)$/, "") ?? "Your Realm";
    return writeSave(this.saveSlot, this.transport.serialize(), {
      name,
      day: info.day,
      season: info.season,
      seed: info.seed,
    });
  }

  // ---- Client render loop --------------------------------------------------

  private render(): void {
    const state = this.state;
    // Stop showing the camp ghost once the server confirms we've settled —
    // also the first moment the full HUD (research/work/recruit/blacksmith/
    // diplomacy) actually exists, so the tutorial waits for exactly this.
    if (this.placingId === "camp" && state.civs[this.myCivId]?.started) {
      this.setPlacing(null);
      if (!this.tutorialShown && !hasSeenTutorial()) {
        this.tutorialShown = true;
        this.decisions.unshift({ kind: "tutorial", step: 0 });
        this.showNextDecision();
      }
    }
    // Camera follow runs every frame, for both click-move and held-key
    // steering, as long as the leader is actively walking somewhere.
    const leader = state.civs[this.myCivId]?.leader;
    const civ = state.civs[this.myCivId];
    if (leader && (civ?.leaderTarget || civ?.leaderMoveDir)) {
      this.cam.follow(leader.pos.x, leader.pos.y, 0.15);
    }
    // Game over: the leader can die to rival combat (CombatSystem's
    // killCitizen) or wildlife (WildlifeSystem's leaderFallsToWildlife) —
    // both just remove the leader citizen and leave the civ leaderless, so
    // "started but no leader" is the one signal that means the run ended.
    if (civ?.started && !leader && !this.gameOverShown) {
      this.gameOverShown = true;
      const daysSurvived = civ.foundedDay != null ? Math.max(0, state.day - civ.foundedDay) : 0;
      this.decisions.unshift({ kind: "gameOver", daysSurvived });
      this.showNextDecision();
    }
    this.renderer.draw(state, this.hover, this.placingId, this.myCivId, this.selectedCitizenId);
    this.hud.setSelectedCitizen(this.selectedCitizenId);
    this.hud.update(state, this.myCivId, this.transport.history());
    this.updateCitizenTip(state);
  }

  /** Hovering near a citizen shows an inspect tooltip (spec §6). Click is
   * reserved for leader movement, so this is hover-only, not click-to-open. */
  private updateCitizenTip(state: GameState): void {
    if (!this.hover || this.placingId) {
      this.hud.hideCitizenTip();
      return;
    }
    let best: { c: (typeof state.civs)[number]["citizens"][number]; civColor: string } | null = null;
    let bestD = 0.6;
    for (const civ of state.civs) {
      for (const c of civ.citizens) {
        const d = Math.hypot(c.pos.x - this.hover.x, c.pos.y - this.hover.y);
        if (d < bestD) {
          bestD = d;
          best = { c, civColor: civ.color };
        }
      }
    }
    if (!best) {
      this.hud.hideCitizenTip();
      return;
    }
    const screen = this.cam.worldToScreen(best.c.pos.x, best.c.pos.y);
    this.hud.showCitizenTip(best.c, best.civColor, screen);
  }

  // ---- Input → Commands ----------------------------------------------------

  private bindInput(): void {
    const c = this.canvas;
    c.addEventListener("mousedown", (e) => {
      this.dragging = true;
      this.dragMoved = false;
      this.lastMouse = { x: e.clientX, y: e.clientY };
    });
    window.addEventListener("mouseup", this.onWindowMouseUp);
    c.addEventListener("mousemove", (e) => {
      const rect = c.getBoundingClientRect();
      const dpr = c.width / rect.width;
      this.hover = this.cam.screenToWorld((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
      if (this.dragging) {
        const dx = e.clientX - this.lastMouse.x;
        const dy = e.clientY - this.lastMouse.y;
        if (Math.abs(dx) + Math.abs(dy) > 3) this.dragMoved = true;
        this.cam.pan(dx * dpr, dy * dpr);
        this.lastMouse = { x: e.clientX, y: e.clientY };
      }
    });
    c.addEventListener("click", (e) => {
      if (this.dragMoved) return;
      const rect = c.getBoundingClientRect();
      const dpr = c.width / rect.width;
      const world = this.cam.screenToWorld((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr);
      this.onClickWorld({ x: Math.round(world.x), y: Math.round(world.y) });
    });
    c.addEventListener("wheel", (e) => {
      e.preventDefault();
      const rect = c.getBoundingClientRect();
      const dpr = c.width / rect.width;
      this.cam.zoomAt((e.clientX - rect.left) * dpr, (e.clientY - rect.top) * dpr, Math.sign(e.deltaY));
    }, { passive: false });
    // Smooth zoom-tier shortcuts (spec: character/settlement/regional/world)
    // and Escape/movement/interact/eat all live in onWindowKeyDown below —
    // defined as a bound instance field, not inline here, so destroy() can
    // remove this exact same function reference later.
    window.addEventListener("keydown", this.onWindowKeyDown);
    window.addEventListener("keyup", this.onWindowKeyUp);
    // Losing focus (alt-tab, clicking outside) shouldn't leave keys "stuck" held.
    window.addEventListener("blur", this.onWindowBlur);
  }

  /** WASD/arrows steer the leader with a constant held-direction vector
   * (spec §5, §35) — the server applies it every tick at a fixed speed, so
   * unlike the old "re-aim a lookahead waypoint" scheme every one of the 8
   * directions (including diagonals) covers exactly the same distance per
   * tick and releasing a key stops the leader immediately. Only sent when
   * the held-key set actually changes, not once a frame. */
  private lastSentDir: string | null = null;
  private sendLeaderMoveFromKeys(): void {
    let dx = 0;
    let dy = 0;
    const b = this.binds;
    if (this.heldKeys.has(b.up) || this.heldKeys.has("arrowup")) dy -= 1;
    if (this.heldKeys.has(b.down) || this.heldKeys.has("arrowdown")) dy += 1;
    if (this.heldKeys.has(b.left) || this.heldKeys.has("arrowleft")) dx -= 1;
    if (this.heldKeys.has(b.right) || this.heldKeys.has("arrowright")) dx += 1;
    const dir = dx === 0 && dy === 0 ? null : { x: dx, y: dy };
    const key = dir ? `${dir.x},${dir.y}` : "null";
    if (key === this.lastSentDir) return;
    this.lastSentDir = key;
    this.send({ type: "setLeaderMove", civ: this.myCivId, dir });
  }

  private onClickWorld(tile: Vec2): void {
    if (this.placingId) {
      const civ = this.myCivId;
      if (this.placingId === "camp") {
        this.send({ type: "foundCamp", civ, tile });
        // The camp ghost clears reactively once the server confirms (see render()).
      } else {
        this.send({ type: "placeBuilding", civ, buildingId: this.placingId, tile });
        // Keep placement mode active so several can be dropped in a row.
      }
      return;
    }

    const civ = this.state.civs[this.myCivId];
    if (!civ?.started) return;

    // An enemy citizen under the cursor while at war (spec: "the player
    // should attack as well"): attack instead of walking/selecting. Attacks
    // with whichever citizen was already selected, else the leader.
    for (const rival of this.state.civs) {
      if (rival.id === this.myCivId) continue;
      if (this.state.relations.stance(this.myCivId, rival.id) !== "war") continue;
      const enemy = rival.citizens.find((c) => Math.hypot(c.pos.x - tile.x, c.pos.y - tile.y) < 0.6);
      if (!enemy) continue;
      const attackerId = this.selectedCitizenId ?? civ.leader?.id;
      if (attackerId === undefined) return;
      this.send({
        type: "attackTarget",
        civ: this.myCivId,
        citizenId: attackerId,
        targetCiv: rival.id,
        targetCitizenId: enemy.id,
      });
      this.selectedCitizenId = null;
      return;
    }

    // A citizen is already selected: this click is their job assignment
    // (spec §6) — a resource node, an unfinished building, or anywhere else
    // to release them back to the auto-worker AI.
    if (this.selectedCitizenId !== null) {
      this.send({ type: "commandCitizen", civ: this.myCivId, citizenId: this.selectedCitizenId, tile });
      this.selectedCitizenId = null;
      return;
    }

    // Otherwise, clicking near one of your own non-leader citizens selects
    // them for a job assignment instead of moving the leader there.
    let nearest: number | null = null;
    let nearestD = 0.6;
    for (const c of civ.citizens) {
      if (c.isLeader) continue;
      const d = Math.hypot(c.pos.x - tile.x, c.pos.y - tile.y);
      if (d < nearestD) {
        nearestD = d;
        nearest = c.id;
      }
    }
    if (nearest !== null) {
      this.selectedCitizenId = nearest;
      this.hud.toast("Citizen selected — click a resource node or building to assign them, or Esc to cancel.");
      return;
    }

    // Nothing selected, no citizen there: send the leader — the player's
    // physical character (spec §5) — walking to that spot.
    this.send({ type: "setLeaderTarget", civ: this.myCivId, target: tile });
  }
}
