// The real multiplayer server (spec §36 Phase 5). A small, headless Node
// process: it runs the exact same Simulation class the browser used to run
// in-process (net/Simulation.ts has no DOM/timer dependency, by design), owns
// the one authoritative match, and speaks the Command/ServerEvent/Snapshot
// protocol over WebSocket. Every connecting browser claims one civ slot; any
// slot nobody has claimed keeps playing itself via the AI brain, so a match is
// always full and never blocks on players joining (spec §29 matchmaking spirit,
// kept simple for this single-room build).
//
// Anti-cheat (spec §35): every inbound command is checked against the sending
// connection's own assigned civId before being enqueued — a client can only
// ever act as the civ the server gave it.
//
// Persistence (spec §15 Chronicles, §36 Phase 9): each connection carries a
// playerId (query param, no auth — see profileStore.ts's header). Claiming a
// civ restores that player's wallet from disk; a periodic autosave plus a
// save on disconnect keep it current. At most ~AUTOSAVE_MS of wallet progress
// could be lost on a hard crash — an accepted trade-off for this build.

import { WebSocketServer, type WebSocket } from "ws";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { Simulation } from "../src/net/Simulation.ts";
import type { Command } from "../src/net/protocol.ts";
import { buildChronicleRecord, captureWallet, restoreWallet, captureBattlePass, restoreBattlePass } from "../src/core/profile.ts";
import { getProfile, saveProfile, flushNow } from "./profileStore.ts";

// Deployment (spec: "put it on Render/GitHub" — a single public URL friends
// can just open): this same process also serves the built client from
// dist/, so hosting is one Render Web Service with one address, not a
// separate static site + a separate server the player has to stitch
// together by hand. Running only `npm run server` locally without a prior
// `npm run build` just means dist/ doesn't exist yet — the static handler
// below degrades to "server-only" (fine for local dev, where the client
// normally runs via `npm run dev` on its own Vite port instead).
const DIST_DIR = fileURLToPath(new URL("../dist", import.meta.url));
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

const PORT = Number(process.env.PORT ?? 8790);
const TICK_MS = 1000 / 60;
const SNAPSHOT_HZ = 10; // throttle broadcast bandwidth independent of sim rate
const AUTOSAVE_MS = 10_000;

const seed = Date.now() & 0xffff;
const sim = new Simulation(seed, { soloHuman: false });

const civOfSocket = new Map<WebSocket, number>();
const playerIdOfCiv = new Map<number, string>();

function claimNextCiv(): number | null {
  for (const civ of sim.state.civs) {
    if (civ.isAI) return civ.id;
  }
  return null;
}

/** Capture the civ's current wallet + a chronicle record into its player's
 * persistent profile and write it out. Used on disconnect and autosave. */
async function persist(civId: number, finalize: boolean): Promise<void> {
  const playerId = playerIdOfCiv.get(civId);
  const civ = sim.state.civs[civId];
  if (!playerId || !civ) return;
  const profile = await getProfile(playerId);
  captureWallet(civ, profile);
  captureBattlePass(civ, profile);
  if (finalize) {
    const record = buildChronicleRecord(civ, seed, sim.state.day);
    if (record) profile.history.push(record);
  }
  await saveProfile(profile);
}

const httpServer = createServer((req, res) => {
  void (async () => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      // Resolve + confine to DIST_DIR before touching the filesystem — a
      // pathname like "/../../../etc/passwd" must never escape the static
      // root just because a client sent it.
      let filePath = resolve(DIST_DIR, "." + decodeURIComponent(url.pathname));
      if (!(filePath === DIST_DIR || filePath.startsWith(DIST_DIR + sep))) filePath = DIST_DIR;
      // SPA fallback: any path that isn't a real FILE on disk — "/" and
      // every other directory (not just the traversal-reset case above),
      // a direct-join link's own path, a stray refresh — serves index.html
      // so the client boots and reads its own ?server= option itself;
      // there's no server-side router to match otherwise.
      if (!existsSync(filePath) || statSync(filePath).isDirectory()) filePath = join(DIST_DIR, "index.html");
      const body = await readFile(filePath);
      res.writeHead(200, { "Content-Type": MIME[extname(filePath)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end("Not found");
    }
  })();
});

const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", (ws, req) => {
  void (async () => {
    const civId = claimNextCiv();
    if (civId === null) {
      ws.send(JSON.stringify({ type: "full" }));
      ws.close();
      return;
    }
    const params = new URL(req.url ?? "", "http://localhost").searchParams;
    const leaderName = params.get("leaderName") ?? undefined;
    const civ = sim.claimCiv(civId, leaderName);
    if (!civ) {
      ws.send(JSON.stringify({ type: "full" }));
      ws.close();
      return;
    }

    const playerId = params.get("playerId");
    const profile = playerId ? await getProfile(playerId) : null;
    if (playerId && profile) {
      restoreWallet(civ, profile);
      restoreBattlePass(civ, profile);
      playerIdOfCiv.set(civId, playerId);
    }

    civOfSocket.set(ws, civId);
    console.log(`[server] connection claimed civ ${civId} (${civ.name})`);

    ws.send(JSON.stringify({
      type: "welcome",
      civId,
      playerStart: sim.homeOf(civId),
      history: profile?.history ?? [],
    }));
    ws.send(JSON.stringify({ type: "snapshot", state: sim.state }));

    ws.on("message", (raw) => {
      let msg: { type?: string; command?: Command };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return; // malformed payload — ignore rather than crash the room
      }
      if (msg.type !== "command" || !msg.command) return;
      const cmd = msg.command;
      // Reject any command spoofing another civ's identity (spec §35).
      if (cmd.civ !== civOfSocket.get(ws)) return;
      sim.enqueue(cmd);
    });

    ws.on("close", () => {
      void (async () => {
        civOfSocket.delete(ws);
        await persist(civId, true);
        playerIdOfCiv.delete(civId);
        sim.releaseCiv(civId);
        console.log(`[server] civ ${civId} disconnected — returned to AI control`);
      })();
    });
  })();
});

// The authoritative tick — identical cadence to LocalTransport's in-tab loop.
setInterval(() => sim.tick(), TICK_MS);

// Broadcast the full snapshot at a throttled rate; ticking stays at 60Hz for
// simulation fidelity but clients don't need world-state pushes that fast.
setInterval(() => {
  const payload = JSON.stringify({ type: "snapshot", state: sim.state });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
}, 1000 / SNAPSHOT_HZ);

// Relay gameplay feedback (toasts, decisions, chronicle) to every connection;
// each client filters to what's relevant to its own civ where that matters.
sim.bus.on((event) => {
  const payload = JSON.stringify({ type: "event", event });
  for (const ws of wss.clients) {
    if (ws.readyState === ws.OPEN) ws.send(payload);
  }
});

// Periodic autosave so a hard crash loses at most AUTOSAVE_MS of progress.
setInterval(() => {
  for (const civId of playerIdOfCiv.keys()) void persist(civId, false);
}, AUTOSAVE_MS);

async function shutdown(): Promise<void> {
  for (const civId of playerIdOfCiv.keys()) await persist(civId, false);
  await flushNow();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());

httpServer.listen(PORT, () => {
  console.log(`Founders of the Giant Isle — listening on http://localhost:${PORT} (game + ws://localhost:${PORT} multiplayer)`);
  if (!existsSync(DIST_DIR)) {
    console.log(`[server] dist/ not found — run "npm run build" first if you want this process to also serve the client.`);
  }
});
