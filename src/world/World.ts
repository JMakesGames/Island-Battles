// The island: a tile grid with biomes, resource nodes, and fog of war (spec §13).
// Generation is seeded so the same seed always yields the same isle — a
// prerequisite for authoritative multiplayer. Civilizations (player + AI) are
// placed onto it by the orchestrator via spread-out spawn points.

import { RNG } from "../core/rng.ts";
import type { BiomeId, Tile, ResourceNode, Vec2, Site } from "../core/types.ts";
import { Nodes } from "../game/config.ts";

export class World {
  readonly w: number;
  readonly h: number;
  readonly tiles: Tile[];
  readonly nodes: ResourceNode[] = [];
  readonly sites: Site[] = [];
  readonly rng: RNG;

  constructor(seed: number, w = 144, h = 144) {
    this.w = w;
    this.h = h;
    this.rng = new RNG(seed);
    this.tiles = new Array(w * h);
    this.generate();
  }

  idx(x: number, y: number): number {
    return y * this.w + x;
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.w && y < this.h;
  }

  tileAt(x: number, y: number): Tile | null {
    return this.inBounds(x, y) ? this.tiles[this.idx(x, y)] : null;
  }

  private generate(): void {
    const { w, h, rng } = this;
    // Radial island mask with a little seeded wobble so the coast isn't a circle.
    const cx = w / 2;
    const cy = h / 2;
    const maxR = Math.min(w, h) * 0.46;
    const wobble = Array.from({ length: 360 }, () => rng.range(0.82, 1.12));

    const elevation = (x: number, y: number): number => {
      const dx = x - cx;
      const dy = y - cy;
      const ang = (Math.floor((Math.atan2(dy, dx) * 180) / Math.PI) + 360) % 360;
      const dist = Math.hypot(dx, dy) / (maxR * wobble[ang]);
      // Gentle, large-scale rolling hills ONLY — no per-tile random noise. The
      // old code added `rng.range(-0.08,0.08)` plus high-frequency sin/cos per
      // tile, which punched isolated sub-zero holes into the interior that
      // became "ocean puddles" scattered across the map (bug report: "random
      // puddles"). With smooth low-frequency terms the landmass stays solid:
      // elevation only crosses 0 near the coast (dist ~ 1), so ocean forms a
      // clean ring, never inland pockets. Real inland water is added on purpose
      // by carveLake() below.
      const rolling = Math.sin(x * 0.06 + 2.1) * 0.08 + Math.cos(y * 0.05 - 1.4) * 0.08;
      return 1 - dist + rolling; // >0 = land
    };

    // A large-scale moisture field lets us place jungle (hot+wet), swamp
    // (low+wet), and snow (high+cold) coherently rather than as random speckle.
    const moisture = (x: number, y: number): number =>
      0.5 + 0.5 * Math.sin(x * 0.11 + 1.3) * Math.cos(y * 0.09 - 0.7);

    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const e = elevation(x, y);
        const m = moisture(x, y);
        let biome: BiomeId;
        if (e < 0) biome = "ocean";
        else if (e < 0.08) biome = e > 0.02 && m > 0.62 ? "swamp" : "beach";
        else if (e > 0.72) biome = "snow";
        else if (e > 0.6) biome = "mountain";
        else {
          const r = rng.next();
          if (m > 0.66) biome = r < 0.7 ? "jungle" : "forest";
          else if (r < 0.32) biome = "forest";
          else biome = "grassland";
        }
        this.tiles[this.idx(x, y)] = { biome, explored: false, node: -1, site: -1 };
      }
    }

    // A handful of deliberate inland lakes (spec: "little lakes inside the
    // map"), each an early freshwater source. These are the ONLY interior
    // water now that the elevation field no longer produces random puddles.
    const lakeCount = rng.int(3, 5);
    for (let i = 0; i < lakeCount; i++) this.carveLake();
    this.spawnNodes();
    this.spawnSites();
  }

  /** Scatter a handful of discoverable ruins/caves on habitable land (spec §13). */
  private spawnSites(): void {
    const { rng } = this;
    const count = 5;
    for (let attempt = 0; attempt < 3000 && this.sites.length < count; attempt++) {
      const x = rng.int(4, this.w - 4);
      const y = rng.int(4, this.h - 4);
      const t = this.tileAt(x, y);
      if (!t || t.node >= 0 || t.site >= 0) continue;
      if (!["grassland", "forest", "jungle", "snow", "beach"].includes(t.biome)) continue;
      const kind = rng.chance(0.5) ? "ruins" : "cave";
      t.site = this.sites.length;
      this.sites.push({
        id: `site_${this.sites.length}`,
        kind,
        tile: { x, y },
        discovered: false,
        eventId: "ruins",
      });
    }
  }

  /** Carve one small freshwater lake on interior land — an early water source
   * to find. Shape is a blobby ellipse with a wobbling radius so lakes read as
   * natural ponds rather than perfect circles. */
  private carveLake(): void {
    const { rng } = this;
    for (let attempt = 0; attempt < 60; attempt++) {
      const lx = rng.int(10, this.w - 10);
      const ly = rng.int(10, this.h - 10);
      const t = this.tileAt(lx, ly);
      if (t && (t.biome === "grassland" || t.biome === "forest" || t.biome === "jungle")) {
        const rad = rng.range(2.2, 4.2);
        // Slightly elliptical + per-angle wobble so no two lakes look identical.
        const stretch = rng.range(0.7, 1.4);
        const phase = rng.range(0, Math.PI * 2);
        for (let y = Math.floor(ly - rad * 1.5); y <= ly + rad * 1.5; y++) {
          for (let x = Math.floor(lx - rad * 1.5); x <= lx + rad * 1.5; x++) {
            const tt = this.tileAt(x, y);
            if (!tt || tt.biome === "ocean") continue;
            const ex = (x - lx) * stretch;
            const ey = (y - ly) / stretch;
            const ang = Math.atan2(ey, ex);
            const wob = rad * (0.85 + 0.25 * Math.sin(ang * 3 + phase));
            if (Math.hypot(ex, ey) <= wob) tt.biome = "water";
          }
        }
        return;
      }
    }
  }

  private spawnNodes(): void {
    const { rng } = this;
    for (let y = 0; y < this.h; y++) {
      for (let x = 0; x < this.w; x++) {
        const tile = this.tiles[this.idx(x, y)];
        const candidates = Nodes.filter((n) => n.biome === tile.biome);
        if (candidates.length === 0) continue;
        // Density varies per biome to keep resources spread but findable.
        const density = tile.biome === "water" ? 0.5 : 0.14;
        if (!rng.chance(density)) continue;
        const def = rng.pick(candidates);
        tile.node = this.nodes.length;
        this.nodes.push({
          id: def.id,
          resource: def.resource,
          tile: { x, y },
          remaining: def.amount,
          color: def.color,
          icon: def.icon,
        });
      }
    }
  }

  /** Is this a habitable, buildable land tile? */
  isHabitable(x: number, y: number): boolean {
    const t = this.tileAt(x, y);
    return !!t && (t.biome === "grassland" || t.biome === "forest" || t.biome === "beach");
  }

  /**
   * Find `count` habitable spawn tiles spread apart across the isle — one per
   * civilization (spec §4). Greedy: keeps candidates at least `minSep` apart so
   * rivals don't start on top of each other.
   */
  findSpawns(count: number, rng: RNG): Vec2[] {
    const spawns: Vec2[] = [];
    const minSep = Math.min(this.w, this.h) * 0.3;
    for (let attempt = 0; attempt < 6000 && spawns.length < count; attempt++) {
      const x = rng.int(5, this.w - 5);
      const y = rng.int(5, this.h - 5);
      if (!this.isHabitable(x, y)) continue;
      // Reward sites near water + forest so every civ has a viable start.
      let nearWater = false;
      let nearWood = false;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const t = this.tileAt(x + dx, y + dy);
          if (t?.biome === "water") nearWater = true;
          if (t?.biome === "forest") nearWood = true;
        }
      if (!nearWater || !nearWood) continue;
      if (spawns.every((s) => Math.hypot(s.x - x, s.y - y) >= minSep)) {
        spawns.push({ x, y });
      }
    }
    // Fallback: relax constraints if the isle is small/awkward.
    for (let attempt = 0; attempt < 6000 && spawns.length < count; attempt++) {
      const x = rng.int(5, this.w - 5);
      const y = rng.int(5, this.h - 5);
      if (this.isHabitable(x, y) && spawns.every((s) => Math.hypot(s.x - x, s.y - y) >= minSep * 0.6)) {
        spawns.push({ x, y });
      }
    }
    return spawns;
  }

  /** Reveal fog of war in a radius (the viewing civ's knowledge). */
  reveal(cx: number, cy: number, radius: number): void {
    const r2 = radius * radius;
    for (let y = Math.floor(cy - radius); y <= cy + radius; y++) {
      for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
        const t = this.tileAt(x, y);
        if (!t) continue;
        const dx = x - cx;
        const dy = y - cy;
        if (dx * dx + dy * dy <= r2) t.explored = true;
      }
    }
  }
}
