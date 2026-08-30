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
  private rejectReady!: (err: Error) => void;
  private readyPromise = new Promise<void>((res, rej) => {
    this.resolveReady = res;
    this.rejectReady = rej;
  });
  // Free-tier hosts (Render et al.) sleep the server after idle and can take
  // 30-50s to cold-start — the very first connection attempt routinely closes
  // before a "welcome" ever arrives. Bug report: "multiplayer says I lost
  // connection when booting up to the server" — a single close used to be
  // treated as fatal (see git history); now it's retried with backoff, and
  // only reported as a real failure once retries are exhausted.
  private retriesLeft = 15;
  private retryDelayMs = 4000;
  private stopped = false;
  private totalRetries = this.retriesLeft;
  // True once a "welcome" has actually been received — distinguishes "never
  // connected yet" (the boot-time retry loop, reported via rejecting ready())
  // from "was playing, then the socket dropped" (bug report: character
  // "keeps moving on its own" with the keyboard untouched — a mid-game close
  // used to be silently ignored entirely, leaving predictLeaderStep's local
  // prediction running forever with nothing to ever correct it again since
  // no further snapshot could arrive). Both cases now retry the same way;
  // onConnectionChange tells Game.ts to freeze prediction and show feedback
  // specifically for the "was playing" case.
  private connected = false;
  private hasEverConnected = false;

  constructor(
    private url: string,
    private leaderName?: string,
    private password?: string,
    private onRetry?: (attempt: number, total: number) => void,
    private onConnectionChange?: (connected: boolean) => void,
  ) {}

  start(): void {
    if (this.stopped) return;
    const playerId = getOrCreatePlayerId();
    const sep = this.url.includes("?") ? "&" : "?";
    let full = `${this.url}${sep}playerId=${encodeURIComponent(playerId)}`;
    if (this.leaderName) full += `&leaderName=${encodeURIComponent(this.leaderName)}`;
    if (this.password) full += `&password=${encodeURIComponent(this.password)}`;
    this.ws = new WebSocket(full);
    this.ws.onmessage = (ev) => this.onMessage(ev.data as string);
    this.ws.onerror = () => console.error("[NetworkTransport] connection error");
    this.ws.onclose = () => {
      console.warn("[NetworkTransport] disconnected from server");
      if (this.stopped) return;
      const wasConnected = this.connected;
      this.connected = false;
      // Force a fresh handshake on reconnect — the old civ slot was already
      // handed back to AI control server-side the moment this socket closed
      // (see server/index.ts's ws.on("close")), so rejoining always means a
      // brand-new "welcome" (possibly a different civId).
      this.gotWelcome = false;
      this.gotSnapshot = false;
      if (wasConnected) this.onConnectionChange?.(false);
      if (this.retriesLeft > 0) {
        this.retriesLeft--;
        this.onRetry?.(this.totalRetries - this.retriesLeft, this.totalRetries);
        setTimeout(() => this.start(), this.retryDelayMs);
        return;
      }
      if (!wasConnected) {
        // A close before ever getting seated, even after retries, must not
        // leave ready() unsettled forever — that's what left the client
        // stuck on a blank canvas with no feedback (bug report: "the square
        // loader does not work").
        this.rejectReady(new Error("Couldn't reach the server after several tries. It may be starting up — try again in a minute."));
      }
      // else: was already playing and retries are now exhausted too —
      // onConnectionChange(false) already told the UI; there's nothing more
      // to automatically do without a full page reload.
    };
  }

  stop(): void {
    this.stopped = true;
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
      case "welcome": {
        const reconnecting = this.hasEverConnected;
        this.civId = msg.civId as number;
        this.startPos = msg.playerStart as Vec2;
        this.pastHistory = (msg.history as ChronicleRecord[]) ?? [];
        this.gotWelcome = true;
        this.connected = true;
        this.hasEverConnected = true;
        this.retriesLeft = this.totalRetries; // a fresh budget for the next drop, if any
        if (reconnecting) this.onConnectionChange?.(true);
        break;
      }
      case "snapshot":
        this.latest = rehydrateSnapshot(msg.state);
        this.gotSnapshot = true;
        break;
      case "event":
        for (const h of this.handlers) h(msg.event as ServerEvent);
        break;
      case "full":
        this.rejectReady(new Error("That match is full — try again later."));
        break;
      case "badPassword":
        this.rejectReady(new Error("Wrong match password."));
        break;
    }
    if (this.gotWelcome && this.gotSnapshot) this.resolveReady();
  }

  send(cmd: Command): void {
    // Between a mid-game drop and the next reconnect attempt, `ws` still
    // points at the closed socket (only stop() nulls it) — sending on a
    // CLOSING/CLOSED WebSocket throws, which would otherwise blow up
    // whatever input handler called this (e.g. a keyup while offline).
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: "command", command: cmd }));
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
