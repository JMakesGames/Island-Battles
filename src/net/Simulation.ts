// The authoritative simulation (spec §35, §36 Phase 4-5). This is the *server*:
// it owns the one true GameState, is the only place state is mutated, and it
// advances on fixed ticks. Human intent arrives only as validated Commands;
// AI civilizations are server-side logic, not clients. Rendering/UI live
// entirely on the far side of the Transport and never reach in here.
//
// It has no DOM/timer dependencies, so the exact same class runs inside a
// browser tab (LocalTransport, one built-in human) or a headless Node process
// (net/Transport's NetworkTransport, any number of humans claiming civ slots)
// untouched.

import { GameState, TICKS_PER_DAY, CIV_COLORS, AI_CIV_NAMES } from "../game/GameState.ts";
import { Civ } from "../game/Civ.ts";
import { EventBus } from "../core/events.ts";
import type { Vec2 } from "../core/types.ts";
import type { Command } from "./protocol.ts";
import { updateCitizens, commandCitizen, assignRole, gatherNearbyNode, globalClaims, setJobLock, setAutomationMode } from "../systems/CitizenSystem.ts";
import { updateCombat, updateSiege, attackTarget, attackWall, findEnemyNear, LEADER_INTERACT_COOLDOWN } from "../systems/CombatSystem.ts";
import { huntNearby, wakeNearbyMonsters, updateMonsters } from "../systems/WildlifeSystem.ts";
import { advanceDay, recruitCitizen, leaderEat } from "../systems/SurvivalSystem.ts";
import { purchaseTool } from "../systems/Blacksmith.ts";
import { updateAI } from "../systems/AISystem.ts";
import { updateDiplomacy, resolveProposal } from "../systems/Diplomacy.ts";
import { place, findEnemyWallNear } from "../systems/BuildingSystem.ts";
import { getEvent, resolveChoice } from "../systems/EventSystem.ts";
import { Events } from "../game/config.ts";
import { handleDiploAction } from "../game/diploActions.ts";
import { rally } from "../systems/LeaderSystem.ts";
import { grantLt, purchaseItem, purchaseBundle, equipCosmetic } from "../systems/Economy.ts";
import { startResearch, updateAIResearch } from "../systems/TechSystem.ts";
import { updateVictory } from "../systems/VictorySystem.ts";
import { purchasePremiumPass, claimBattlePassReward } from "../systems/BattlePass.ts";
import { scoutCiv, sabotageCiv } from "../systems/EspionageSystem.ts";
import { updateAchievements } from "../systems/AchievementSystem.ts";
import { updateTasks } from "../systems/TasksSystem.ts";

const NUM_CIVS = 3; // spec §4: 3–6 civs; up to NUM_CIVS may be human-controlled

export interface SimulationOptions {
  /**
   * true (default): civ 0 is human from the start, matching offline/local
   * single-player (LocalTransport) — no handshake needed.
   * false: every civ starts AI-controlled and gets an auto-placed camp; a
   * networked server claims slots for connecting humans at runtime via
   * claimCiv/releaseCiv (spec §36 Phase 5).
   */
  soloHuman?: boolean;
  /** Solo mode leader/civ customization from the main menu (spec §5). */
  leaderName?: string;
  civColor?: string;
  /** Opt-in difficulty (spec: "leader death — keep permadeath as an optional
   * hardcore mode, not the default"). See GameState.hardcoreLeaderDeath. */
  hardcoreLeaderDeath?: boolean;
  /** Continue a saved solo game (spec: revisitable "past worlds"). When set,
   * this fully-rehydrated GameState is adopted as-is instead of generating a
   * fresh island + civs — see serialize.rehydrateSave. */
  restoreState?: GameState;
}

export class Simulation {
  readonly state: GameState;
  readonly bus = new EventBus();

  private queue: Command[] = [];
  private dayAccum = 0;
  /** Per human civ: tick their camp was founded, for the opener-event timer. */
  private humanStartTick = new Map<number, number>();
  private humanEventFired = new Set<number>();
  /**
   * Solo mode only: where civ 0's revealed clearing is *before* they've
   * founded a camp (civ.home is still null then, so homeOf() can't help).
   */
  private soloSpawn: Vec2 | null = null;

  constructor(seed: number, opts: SimulationOptions = {}) {
    if (opts.restoreState) {
      // Continue a saved game: adopt its state wholesale, no world/civ
      // generation. soloSpawn only matters before a camp is founded, and a
      // saved game always has a founded camp, so civ 0's home covers the
      // camera-start lookup (homeOf).
      this.state = opts.restoreState;
      this.soloSpawn = this.state.civs[0]?.home ?? null;
      return;
    }
    this.state = new GameState(seed);
    this.state.hardcoreLeaderDeath = opts.hardcoreLeaderDeath ?? false;
    this.setupCivs(opts.soloHuman ?? true, opts);
  }

  /** Client sends intent here (via the Transport). Applied on the next tick. */
  enqueue(cmd: Command): void {
    this.queue.push(cmd);
  }

  /** Server-only: hand an AI-controlled slot to a connecting human, optionally
   * renaming its already-spawned leader (spec §5 customization). */
  claimCiv(civId: number, leaderName?: string): Civ | null {
    const civ = this.state.civs[civId];
    if (!civ || !civ.isAI) return null;
    civ.isAI = false;
    if (leaderName) {
      civ.leaderName = leaderName;
      if (civ.leader) civ.leader.name = `${leaderName} (You)`;
    }
    return civ;
  }

  /** Server-only: a human disconnected — let the AI brain resume the civ. */
  releaseCiv(civId: number): void {
    const civ = this.state.civs[civId];
    if (!civ) return;
    civ.isAI = true;
    civ.ai = civ.ai ?? { planCooldown: 0, goal: "settling", discoveredByPlayer: false };
  }

  // ---- Match setup ---------------------------------------------------------

  private setupCivs(soloHuman: boolean, opts: SimulationOptions): void {
    const { state } = this;
    const spawns = state.world.findSpawns(NUM_CIVS, state.rng);
    const count = Math.min(NUM_CIVS, spawns.length);
    const firstAI = soloHuman ? 1 : 0;

    if (soloHuman) {
      const player = new Civ(0, "Your People", opts.civColor ?? CIV_COLORS[0], false, state.rng);
      player.leaderName = opts.leaderName;
      state.addCiv(player);
      state.playerIndex = 0;
      this.soloSpawn = spawns[0] ?? { x: state.world.w >> 1, y: state.world.h >> 1 };
      state.world.reveal(this.soloSpawn.x, this.soloSpawn.y, 7);
      state.log("Your people wade ashore to begin the battle for the isle.");
    }

    for (let i = firstAI; i < count; i++) {
      const civ = new Civ(i, AI_CIV_NAMES[i - firstAI] ?? `Rival ${i}`, CIV_COLORS[i], true, state.rng);
      state.addCiv(civ);
      place(state, civ, this.bus, "camp", spawns[i], false);
      civ.spawnCitizen(spawns[i], true);
      civ.spawnCitizen(spawns[i]);
      civ.spawnCitizen(spawns[i]);
    }
    state.initRelations();
  }

  /**
   * Where a client's camera should start: the civ's camp once founded, else
   * (solo mode only, before founding) the revealed landing clearing.
   */
  homeOf(civId: number): Vec2 {
    const civ = this.state.civs[civId];
    return civ?.home ?? this.soloSpawn ?? { x: this.state.world.w >> 1, y: this.state.world.h >> 1 };
  }

  // ---- The authoritative tick ---------------------------------------------

  tick(): void {
    const { state } = this;
    state.tick++;

    // 1) Apply all queued human commands for this tick.
    const cmds = this.queue;
    this.queue = [];
    for (const cmd of cmds) this.applyCommand(cmd);

    // 2) Advance every civ's citizens; any human civ lifts (shared) fog.
    // Node claims are computed once here and threaded through every civ's
    // pass rather than each civ rescanning every citizen on the isle for
    // itself (perf: this loop runs 60x/sec) — see globalClaims' doc comment.
    const claimed = globalClaims(state);
    for (const civ of state.civs) {
      updateCitizens(state, civ, this.bus, 1, !civ.isAI, claimed);
    }

    // 2b) Resolve combat (spec: "the player should attack as well", "add
    // soldiers") — separate from updateCitizens so a fighting citizen's job
    // (e.g. "guard") is untouched while they're off brawling.
    for (const civ of state.civs) {
      updateCombat(state, civ, this.bus);
    }

    // 2b-ii) Sieges (spec: "break into a fortified rival camp") — same
    // shape as combat, one tier further: knocking down whatever wall stands
    // between an attacker and the camp behind it.
    for (const civ of state.civs) {
      updateSiege(state, civ, this.bus);
    }

    // 2c) Wolves/bears wake and chase (spec: "make the bear and the wolf
    // fight/chase the player when in range") — waking is a wider, coarser
    // scan so it's throttled; the chase/attack itself runs every tick.
    if (state.tick % 6 === 0) {
      for (const civ of state.civs) wakeNearbyMonsters(state, civ);
    }
    updateMonsters(state, this.bus);

    // 3) Discovery of rival settlements a human has now uncovered.
    this.detectDiscoveries();

    // 4) Each human's opener event, once settled and explored a little.
    for (const civ of state.civs) {
      if (civ.isAI || !civ.started) continue;
      if (!this.humanStartTick.has(civ.id)) this.humanStartTick.set(civ.id, state.tick);
      const elapsed = state.tick - this.humanStartTick.get(civ.id)!;
      if (!this.humanEventFired.has(civ.id) && elapsed > 180) {
        this.humanEventFired.add(civ.id);
        this.bus.emit({ type: "eventTriggered", eventId: "wounded_sailor", civ: civ.id });
      }
    }

    // 5) Daily systems: production/consumption, AI building/research/diplomacy, victory.
    if (++this.dayAccum >= TICKS_PER_DAY) {
      this.dayAccum = 0;
      const seasonChanged = advanceDay(state, this.bus);
      updateAI(state, this.bus);
      for (const civ of state.aiCivs) updateAIResearch(civ, this.bus);
      updateDiplomacy(state, this.bus);
      updateVictory(state, this.bus);
      for (const civ of state.civs) updateAchievements(state, civ, this.bus);
      for (const civ of state.civs) updateTasks(state, civ, this.bus);
      if (seasonChanged) this.rollSeasonalEvents();

      // Quest chains (spec: "structured quest chains") — fire whatever
      // delayed stage has come due.
      const dueSteps = state.pendingQuestSteps.filter((q) => q.day <= state.day);
      if (dueSteps.length) {
        state.pendingQuestSteps = state.pendingQuestSteps.filter((q) => q.day > state.day);
        for (const q of dueSteps) this.bus.emit({ type: "eventTriggered", eventId: q.eventId, civ: q.civId });
      }
    }
  }

  /** Live/seasonal content (spec §11, §27, §36 Phase 11): each human civ has a
   * chance to see a season-flavored event when a new season begins. Adding
   * more of these is purely a data change in events.json — no code here. */
  private rollSeasonalEvents(): void {
    const { state } = this;
    const candidates = Events.filter((e) => e.trigger === "seasonal" && e.season === state.season);
    if (candidates.length === 0) return;
    for (const civ of state.civs) {
      if (civ.isAI || !civ.started) continue;
      if (!state.rng.chance(0.7)) continue;
      const ev = candidates[Math.floor(state.rng.next() * candidates.length)];
      this.bus.emit({ type: "eventTriggered", eventId: ev.id, civ: civ.id });
    }
  }

  private detectDiscoveries(): void {
    const { state } = this;
    for (const civ of state.aiCivs) {
      if (!civ.ai || civ.ai.discoveredByPlayer || !civ.home) continue;
      if (state.world.tileAt(civ.home.x, civ.home.y)?.explored) {
        civ.ai.discoveredByPlayer = true;
        this.bus.emit({ type: "toast", text: `⚑ You've discovered the civilization of ${civ.name}!` });
        state.log(`Scouts sighted the rival civilization of ${civ.name}.`);
      }
    }
  }

  // ---- Command handlers (the only entry points for human mutation) --------

  private applyCommand(cmd: Command): void {
    const { state } = this;
    const civ = state.civs[cmd.civ];
    if (!civ || civ.isAI) return; // only currently human-controlled civs act

    switch (cmd.type) {
      case "foundCamp": {
        if (civ.started) return;
        const res = place(state, civ, this.bus, "camp", cmd.tile, true);
        if (!res.ok) {
          this.bus.emit({ type: "toast", text: res.reason ?? "Can't build there." });
          return;
        }
        civ.spawnCitizen(cmd.tile, true);
        civ.spawnCitizen(cmd.tile);
        civ.spawnCitizen(cmd.tile);
        state.log("The first Camp was raised. A civilization begins.");
        break;
      }
      case "placeBuilding": {
        const res = place(state, civ, this.bus, cmd.buildingId, cmd.tile, true);
        if (!res.ok && res.reason) this.bus.emit({ type: "toast", text: res.reason });
        break;
      }
      case "resolveEvent": {
        const ev = getEvent(cmd.eventId);
        if (ev) resolveChoice(state, this.bus, ev, cmd.choice, cmd.civ);
        break;
      }
      case "diploAction": {
        const res = handleDiploAction(state, this.bus, cmd.action, cmd.civ, cmd.targetCiv);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "scoutCiv": {
        const res = scoutCiv(state, civ, cmd.targetCiv, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "sabotageCiv": {
        const res = sabotageCiv(state, civ, cmd.targetCiv, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "resolveProposal": {
        const idx = state.pendingProposals.findIndex(
          (p) => p.fromCiv === cmd.fromCiv && p.toCiv === cmd.civ,
        );
        if (idx < 0) return;
        const [proposal] = state.pendingProposals.splice(idx, 1);
        const res = resolveProposal(state, proposal, cmd.accept, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "purchaseItem": {
        const res = purchaseItem(civ, cmd.itemId, cmd.requestId, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "purchaseBundle": {
        const res = purchaseBundle(civ, cmd.bundleId, cmd.requestId, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "mockGrantLt": {
        const res = grantLt(civ, cmd.packageId, cmd.requestId, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "equipCosmetic": {
        const res = equipCosmetic(civ, cmd.itemId, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "setLeaderTarget": {
        // Clamp to the island so a stray click off-map doesn't send the
        // leader wandering into undefined tiles.
        if (cmd.target) {
          const w = state.world;
          civ.leaderTarget = {
            x: Math.max(0, Math.min(w.w - 1, cmd.target.x)),
            y: Math.max(0, Math.min(w.h - 1, cmd.target.y)),
          };
          civ.leaderMoveDir = null; // click-to-walk overrides any held-key steering
        } else {
          civ.leaderTarget = null;
        }
        break;
      }
      case "setLeaderMove": {
        if (cmd.dir) {
          const len = Math.hypot(cmd.dir.x, cmd.dir.y) || 1;
          civ.leaderMoveDir = { x: cmd.dir.x / len, y: cmd.dir.y / len };
          civ.leaderTarget = null; // held-key steering overrides any click-to-walk
        } else {
          civ.leaderMoveDir = null;
        }
        break;
      }
      case "leaderInteract": {
        // The interact key is contextual (spec: "when the player is in
        // range of a tree they can chop down the tree for wood, same thing
        // for stone, animals, and attacking"): try each in-range action in
        // priority order, falling back to the original "rally nearby
        // citizens" behavior when nothing else is close enough.
        const leader = civ.leader;
        // Spec: "the player has an attack delay, maybe .5 seconds" — gates
        // every interact-triggered action alike (attack/hunt/gather/rally
        // all share the E key), not just melee.
        if (leader) {
          if ((leader.nextInteractTick ?? 0) > state.tick) break;
          leader.nextInteractTick = state.tick + LEADER_INTERACT_COOLDOWN;
        }
        const enemy = leader ? findEnemyNear(state, civ, leader.pos, 1.6) : null;
        if (enemy) {
          const res = attackTarget(state, civ, leader!.id, enemy.civId, enemy.citizenId);
          this.bus.emit({ type: "toast", text: res.message });
          break;
        }
        // Spec: "break into a fortified rival camp" — no living enemy in
        // reach, but a wall is: lay siege to it instead of walking home.
        const enemyWall = leader ? findEnemyWallNear(state, civ, leader.pos, 1.6) : null;
        if (enemyWall) {
          const res = attackWall(state, civ, leader!.id, enemyWall.civId, enemyWall.tile);
          this.bus.emit({ type: "toast", text: res.message });
          break;
        }
        const hunt = huntNearby(state, civ, this.bus);
        if (hunt.ok) {
          this.bus.emit({ type: "toast", text: hunt.message });
          break;
        }
        const gather = gatherNearbyNode(state, civ);
        if (gather.ok) {
          this.bus.emit({ type: "toast", text: gather.message });
          if (!civ.isAI) this.bus.emit({ type: "resourceChanged" });
          break;
        }
        rally(civ, this.bus, state.tick);
        break;
      }
      case "startResearch": {
        const res = startResearch(civ, cmd.techId, this.bus);
        if (!res.ok) this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "commandCitizen": {
        const res = commandCitizen(state, civ, cmd.citizenId, cmd.tile);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "assignRole": {
        const res = assignRole(state, civ, cmd.citizenId, cmd.role);
        // Record the assigned duty on success so the roster shows it (spec:
        // "show the job they are doing"). "idle" clears it back to auto-managed.
        if (res.ok) {
          const c = civ.citizens.find((x) => x.id === cmd.citizenId);
          if (c) {
            c.assignedRole = cmd.role === "idle" ? undefined : cmd.role;
            // "idle" (release back to auto-managed) can't stay locked to a
            // role that no longer exists — a lock always needs its role.
            if (cmd.role === "idle") c.jobLocked = false;
          }
        }
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "attackTarget": {
        const res = attackTarget(state, civ, cmd.citizenId, cmd.targetCiv, cmd.targetCitizenId);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "recruitCitizen": {
        const res = recruitCitizen(state, civ, this.bus);
        if (!res.ok) this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "eat": {
        const res = leaderEat(civ, this.bus);
        if (res.message) this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "purchaseTool": {
        const res = purchaseTool(civ, cmd.toolId);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "purchasePremiumPass": {
        const res = purchasePremiumPass(civ, cmd.requestId, this.bus);
        this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "claimBattlePassReward": {
        const res = claimBattlePassReward(civ, cmd.level, cmd.track, this.bus);
        if (!res.ok) this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "setJobLock": {
        const res = setJobLock(civ, cmd.citizenId, cmd.locked);
        if (!res.ok) this.bus.emit({ type: "toast", text: res.message });
        break;
      }
      case "setAutomationMode": {
        setAutomationMode(civ, cmd.mode);
        break;
      }
    }
  }
}
