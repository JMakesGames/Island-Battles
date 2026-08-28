// Real pixel-art ground textures extracted from the same art reference pack
// as the citizen/animal/player sprites (spec: "the grass does not work for
// me... fix the art, anything that looks different from the characters and
// animals") — previously terrain was 100% procedural (SpriteAtlas: a flat
// fill + a handful of random 1px speckles), which read as flat/blocky next
// to the pack's painterly figures. These are cropped interior patches from
// the pack's isometric terrain-tile reference sheet (page 5: Grass, Dirt,
// Road, Water, Rock, Mountain), under public/sprites/terrain/.
//
// Three independent (not mirrored) crops per biome, `{biome}_0/1/2.png` —
// mirroring a single patch to fake variety produced an obvious kaleidoscope
// seam where the mirrored halves met, so instead each variant is a distinct
// crop from a clean area of the source tile, matching SpriteAtlas's existing
// VARIANT_COUNT=3 per-tile-hash selection scheme exactly.
//
// Biomes without their own extracted art (forest, jungle, swamp, ocean)
// derive from the nearest real texture via a multiply-blend tint (see
// BIOME_SOURCE) rather than falling back to the old flat-fill technique —
// still real brushed texture underneath, just recolored.
//
// Falls back to null (Renderer keeps using the procedural SpriteAtlas tile)
// until the relevant image has finished loading, same pattern as
// ImageSpriteAtlas's per-frame readiness check.

declare global {
  interface Window {
    __EMBEDDED_TERRAIN_SPRITES__?: Record<string, string>;
  }
}

const VARIANT_COUNT = 3;
const SOURCE_KEYS = ["grass", "sand", "water", "rock", "snow"] as const;
type SourceKey = (typeof SOURCE_KEYS)[number];

interface BiomeSource {
  source: SourceKey;
  /** Multiply-blend tint hex — recolors a real texture rather than inventing a flat fill. */
  tint?: string;
}

const BIOME_SOURCE: Record<string, BiomeSource> = {
  grass: { source: "grass" },
  beach: { source: "sand" },
  forest: { source: "grass", tint: "#2c5a30" },
  jungle: { source: "grass", tint: "#153d1c" },
  swamp: { source: "grass", tint: "#4a4a34" },
  mountain: { source: "rock" },
  snow: { source: "snow" },
  water: { source: "water" },
  ocean: { source: "water", tint: "#123252" },
};

/** Tiny deterministic hash -> [0,1) — must match SpriteAtlas's variant pick
 * so a given tile's chosen index stays stable across frames (not required to
 * be numerically identical to SpriteAtlas's hash, just stable per-tile). */
function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

function tint(img: HTMLImageElement, hex: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = hex;
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.globalCompositeOperation = "source-over";
  return c;
}

export class TerrainImageAtlas {
  private images = new Map<string, HTMLImageElement>();
  private loaded = new Set<string>();
  private tinted = new Map<string, HTMLCanvasElement>();

  constructor() {
    const embedded = typeof window !== "undefined" ? window.__EMBEDDED_TERRAIN_SPRITES__ : undefined;
    const load = (key: string): void => {
      const img = new Image();
      img.onload = () => this.loaded.add(key);
      img.src = embedded?.[key] ?? `/sprites/terrain/${key}.png`;
      this.images.set(key, img);
    };
    for (const source of SOURCE_KEYS) {
      for (let i = 0; i < VARIANT_COUNT; i++) load(`${source}_${i}`);
    }
    load("road_0");
  }

  /** The ground texture for a biome sprite key at this tile's coordinates
   * (stable variant + tint), or null if that biome has no mapping / the
   * image hasn't loaded yet — Renderer falls back to the procedural tile. */
  tileFor(biomeSprite: string, x: number, y: number): CanvasImageSource | null {
    const cfg = BIOME_SOURCE[biomeSprite];
    if (!cfg) return null;
    const idx = Math.floor(hash(x, y, 7) * VARIANT_COUNT);
    const key = `${cfg.source}_${idx}`;
    if (!this.loaded.has(key)) return null;
    if (!cfg.tint) return this.images.get(key)!;
    const cacheKey = `${key}|${cfg.tint}`;
    let canvas = this.tinted.get(cacheKey);
    if (!canvas) {
      canvas = tint(this.images.get(key)!, cfg.tint);
      this.tinted.set(cacheKey, canvas);
    }
    return canvas;
  }

  /** The cobblestone road overlay texture, or null until loaded. */
  road(): CanvasImageSource | null {
    return this.loaded.has("road_0") ? this.images.get("road_0")! : null;
  }
}
