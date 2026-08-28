// The real network client (spec §36 Phase 5). Implements the same Transport
// interface LocalTransport does, so Game.ts is unaware whether it's driving an
// in-process Simulation or a remote one over a WebSocket — it just sends
// Commands and reads Snapshots.
//
// Wire format (see server/index.ts for the matching server side):
//   client -> server: { type: "command", command: Command }
//   server -> client: { type: "welcome", civId, playerStart, history }
//                    | { type: "snapshot", state: <JSON GameState> }
//                    | { type: "event", event: ServerEvent }
//                    | { type: "full" }   (no civ slot available)
//
// The player id (spec §36 Phase 9) travels as a query param on the connection
// URL rather than a first message, so the server can restore the wallet
// before it ever needs to answer anything else.

import type { Transport } from "./Transport.ts";
import type { Command, ServerEvent } from "./protocol.ts";
import type { Vec2 } from "../core/types.ts";
import type { GameState } from "../game/GameState.ts";
import type { ChronicleRecord } from "../core/profile.ts";
import { rehydrateSnapshot } from "./serialize.ts";
import { getOrCreatePlayerId } from "./profileStore.client.ts";

export class NetworkTransport implements Transport {
  private ws: WebSocket | null = null;
  private civId = -1;
  private startPos: Vec2 = { x: 0, y: 0 };
  private latest: GameState | null = null;
  private pastHistory: ChronicleRecord[] = [];
  private handlers = new Set<(e: ServerEvent) => void>();
  private gotWelcome = false;
  private gotSnapshot = false;
  private resolveReady!: () => void;
  private readyPromise = new Promise<void>((res) => (this.resolveReady = res));

  constructor(private url: string, private leaderName?: string) {}

  start(): void {
    const playerId = getOrCreatePlayerId();
    const sep = this.url.includes("?") ? "&" : "?";
    let full = `${this.url}${sep}playerId=${encodeURIComponent(playerId)}`;
    if (this.leaderName) full += `&leaderName=${encodeURIComponent(this.leaderName)}`;
    this.ws = new WebSocket(full);
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
    this.ws.onerror = () => console.error("[NetworkTransport] connection error");
    this.ws.onclose = () => console.warn("[NetworkTransport] disconnected from server");
  }

  stop(): void {
    this.ws?.close();
    this.ws = null;
  }

  private onMessage(raw: string): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    switch (msg.type) {
      case "welcome":
        this.civId = msg.civId as number;
        this.startPos = msg.playerStart as Vec2;
        this.pastHistory = (msg.history as ChronicleRecord[]) ?? [];
        this.gotWelcome = true;
        break;
      case "snapshot":
        this.latest = rehydrateSnapshot(msg.state);
        this.gotSnapshot = true;
        break;
      case "event":
        for (const h of this.handlers) h(msg.event as ServerEvent);
        break;
      case "full":
        console.warn("[NetworkTransport] server has no open civ slots.");
        break;
    }
    if (this.gotWelcome && this.gotSnapshot) this.resolveReady();
  }

  send(cmd: Command): void {
    this.ws?.send(JSON.stringify({ type: "command", command: cmd }));
  }

  onServerEvent(cb: (e: ServerEvent) => void): () => void {
    this.handlers.add(cb);
    return () => this.handlers.delete(cb);
  }

  snapshot(): GameState {
    if (!this.latest) {
      throw new Error("NetworkTransport.snapshot() called before ready() resolved");
    }
    return this.latest;
  }

  playerStart(): Vec2 {
    return this.startPos;
  }

  myCivId(): number {
    return this.civId;
  }

  ready(): Promise<void> {
    return this.readyPromise;
  }

  history(): ChronicleRecord[] {
    return this.pastHistory;
  }
}
