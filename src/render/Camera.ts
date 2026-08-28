// Camera maps world-tile space <-> screen pixels, with pan and zoom.
//
// Flat top-down orthogonal projection, not true isometric — the "2.5D" read
// comes entirely from Renderer's presentation tricks (drop shadows, sprites
// anchored taller than their footprint), not from the projection math. This
// is a deliberate reversion: an earlier pass tried a true isometric diamond
// grid and the tilted map read worse, not better — back to the original flat
// grid the game shipped with.
//
// Smooth zoom tiers (spec's Art Asset Standard: "camera must support smooth
// zooming from CHARACTER VIEW to SETTLEMENT VIEW to REGIONAL VIEW to WORLD
// VIEW"): tileSize eases toward a target each frame via tick() rather than
// snapping, so both preset-tier jumps and the scroll wheel feel continuous.
import type { Vec2 } from "../core/types.ts";

export type ZoomTier = "character" | "settlement" | "regional" | "world";

const TIER_SIZE: Record<ZoomTier, number> = {
  character: 46,
  settlement: 26,
  regional: 15,
  world: 7,
};

export class Camera {
  x = 0; // world-tile coords at screen center
  y = 0;
  tileSize = TIER_SIZE.settlement; // pixels per tile, eases toward targetTileSize
  minTile = 6;
  maxTile = 52;

  private targetTileSize = this.tileSize;

  constructor(private canvas: HTMLCanvasElement) {}

  worldToScreen(wx: number, wy: number): Vec2 {
    return {
      x: (wx - this.x) * this.tileSize + this.canvas.width / 2,
      y: (wy - this.y) * this.tileSize + this.canvas.height / 2,
    };
  }

  screenToWorld(sx: number, sy: number): Vec2 {
    return {
      x: (sx - this.canvas.width / 2) / this.tileSize + this.x,
      y: (sy - this.canvas.height / 2) / this.tileSize + this.y,
    };
  }

  pan(dxPixels: number, dyPixels: number): void {
    this.x -= dxPixels / this.tileSize;
    this.y -= dyPixels / this.tileSize;
  }

  zoomAt(sx: number, sy: number, delta: number): void {
    const before = this.screenToWorld(sx, sy);
    this.tileSize = Math.max(this.minTile, Math.min(this.maxTile, this.tileSize - delta * 2));
    this.targetTileSize = this.tileSize; // wheel zoom is immediate, not eased
    const after = this.screenToWorld(sx, sy);
    this.x += before.x - after.x;
    this.y += before.y - after.y;
  }

  /** Jump to a named zoom tier; the actual zoom eases in via tick(). */
  setTier(tier: ZoomTier): void {
    this.targetTileSize = TIER_SIZE[tier];
  }

  /** Ease tileSize toward its target. Call once per rendered frame. */
  tick(): void {
    const diff = this.targetTileSize - this.tileSize;
    if (Math.abs(diff) > 0.05) this.tileSize += diff * 0.12;
  }

  /** Smoothly pull the camera toward a world point (spec: follow the leader). */
  follow(wx: number, wy: number, strength = 0.08): void {
    this.x += (wx - this.x) * strength;
    this.y += (wy - this.y) * strength;
  }
}
