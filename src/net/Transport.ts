// The client⇄server transport seam (spec §36 Phase 4→5). The client talks only
// to this interface: it sends Commands and receives ServerEvents + read-only
// Snapshots. LocalTransport runs the authoritative Simulation in-process for
// offline/solo play; NetworkTransport (net/NetworkTransport.ts) serializes the
// very same Commands over a WebSocket to a remote server — the client code that
// consumes this interface doesn't change between the two.

import { Simulation } from "./Simulation.ts";
import type { Command, ServerEvent, Snapshot } from "./protocol.ts";
import type { Vec2 } from "../core/types.ts";
import type { ChronicleRecord } from "../core/profile.ts";
import { buildChronicleRecord, captureWallet, restoreWallet, captureBattlePass, restoreBattlePass } from "../core/profile.ts";
import { getOrCreatePlayerId, loadProfile, saveProfile } from "./profileStore.client.ts";

export interface Transport {
  /** Begin receiving state/events (starts the server clock for local play). */
  start(): void;
  stop(): void;
  /** Send a player intent to the authoritative server. */
  send(cmd: Command): void;
  /** Subscribe to server → client gameplay feedback. */
  onServerEvent(cb: (e: ServerEvent) => void): () => void;
  /** Latest authoritative world state to render (treat as read-only). */
  snapshot(): Snapshot;
  /** Where this client's civ starts, for initial camera placement. */
  playerStart(): Vec2;
  /** Which civ slot this client controls (assigned by the server). */
  myCivId(): number;
  /** Resolves once a civ is assigned and a first snapshot has arrived. */
  ready(): Promise<void>;
  /** Past civilizations from this player's persistent profile (spec §15, §36 Phase 9). */
  history(): ChronicleRecord[];
  /** Solo only: serialize the live state for a save slot (undefined on network play). */
  serialize?(): string;
  /** Solo only: metadata for the save-slot card. */
  saveInfo?(): { day: number; season: string; seed: number };
}

const TICK_MS = 1000 / 60;

/**
 * Runs the authoritative Simulation inside the same tab and advances it on a
 * wall-clock accumulator. A timer (not rAF) is used so the server clock keeps
 * correct real time even when the tab is hidden — and it is the exact loop a
 * remote server runs instead. Always seats civ 0 as the built-in human, so
 * offline/solo play needs no handshake.
 *
 * Persistence (spec §36 Phase 9) is client-side here since there's no server:
 * a profile keyed by a localStorage-cached player id is restored at startup
 * and saved on every wallet change plus once more when the tab closes.
 */
export class LocalTransport implements Transport {
  private sim: Simulation;
  private timer = 0;
  private last = 0;
  private acc = 0;
  private playerId: string;
  private profile: ReturnType<typeof loadProfile>;
  private seed: number;
  private finalized = false;

  constructor(seed: number, opts: { leaderName?: string; civColor?: string; hardcoreLeaderDeath?: boolean; restoreState?: import("../game/GameState.ts").GameState } = {}) {
    this.seed = seed;
    this.sim = new Simulation(seed, { soloHuman: true, ...opts });

    this.playerId = getOrCreatePlayerId();
    this.profile = loadProfile(this.playerId);
    // A restored save already carries the civ's wallet/battle-pass inside its
    // serialized state — overwriting from the profile would clobber whatever
    // was earned in that saved run, so only seed from the profile on a fresh
    // game.
    if (!opts.restoreState) {
      restoreWallet(this.sim.state.civs[0], this.profile);
      restoreBattlePass(this.sim.state.civs[0], this.profile);
    }

    this.sim.bus.on((e) => {
      if (e.type === "marketChanged") this.persistWallet();
    });
    window.addEventListener("beforeunload", () => this.finalize());
  }

  /** Serialize the live sim state for a save slot (spec: revisitable worlds). */
  serialize(): string {
    return JSON.stringify(this.sim.state);
  }

  /** Lightweight save metadata for the slot card. */
  saveInfo(): { day: number; season: string; seed: number } {
    return { day: this.sim.state.day, season: this.sim.state.season, seed: this.seed };
  }

  private persistWallet(): void {
    captureWallet(this.sim.state.civs[0], this.profile);
    saveProfile(this.profile);
  }

  /** Record this session's civilization into history exactly once. */
  private finalize(): void {
    if (this.finalized) return;
    this.finalized = true;
    const civ = this.sim.state.civs[0];
    captureWallet(civ, this.profile);
    captureBattlePass(civ, this.profile);
    const record = buildChronicleRecord(civ, this.seed, this.sim.state.day);
    if (record) this.profile.history.push(record);
    saveProfile(this.profile);
  }

  start(): void {
    this.last = performance.now();
    this.timer = window.setInterval(() => this.serverLoop(), TICK_MS);
  }

  stop(): void {
    if (this.timer) window.clearInterval(this.timer);
    this.timer = 0;
  }

  private serverLoop(): void {
    const now = performance.now();
    this.acc += now - this.last;
    this.last = now;
    // Catch up at most ~1s per wake so a hidden/stalled tab can't spiral.
    this.acc = Math.min(this.acc, 1000);
    while (this.acc >= TICK_MS) {
      this.sim.tick();
      this.acc -= TICK_MS;
    }
  }

  send(cmd: Command): void {
    // In-process: intent reaches the server immediately, applied next tick.
    this.sim.enqueue(cmd);
  }

  onServerEvent(cb: (e: ServerEvent) => void): () => void {
    return this.sim.bus.on(cb);
  }

  snapshot(): Snapshot {
    return this.sim.state;
  }

  playerStart(): Vec2 {
    return this.sim.homeOf(this.sim.state.playerIndex);
  }

  myCivId(): number {
    return this.sim.state.playerIndex;
  }

  ready(): Promise<void> {
    return Promise.resolve();
  }

  history(): ChronicleRecord[] {
    return this.profile.history;
  }
}
