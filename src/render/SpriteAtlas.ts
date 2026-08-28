// Procedural pixel-art sprites (spec's Art Asset Standard: crisp blocky pixels,
// nearest-neighbor scaling, no anti-aliasing, consistent pixel density). There
// is no image pipeline in this build — no PNGs to import — so every sprite is
// drawn once onto a small offscreen canvas at a fixed logical-pixel grid
// (terrain/resources: 16x16, citizens: 12x16, buildings: 16x16 to 28x28
// depending on size tier) and cached. The renderer blits that canvas scaled up
// with image smoothing OFF, which is what actually produces the "pixel art"
// look — scaling a tiny sharp image up is indistinguishable from a hand-drawn
// sprite sheet at gameplay zoom, without needing real art assets.
//
// A few biome variants per tile (deterministically chosen per-tile-position)
// avoid a dead-flat, obviously-tiled look while staying fast: variants are
// cached once, not redrawn per tile per frame.

type Canvas = HTMLCanvasElement;

function makeCanvas(w: number, h: number): { c: Canvas; ctx: CanvasRenderingContext2D } {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  return { c, ctx };
}

/** Tiny deterministic hash -> [0,1), so tile variants are stable across frames. */
function hash(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

function shade(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.max(0, Math.min(255, (n >> 16) + amt));
  const g = Math.max(0, Math.min(255, ((n >> 8) & 0xff) + amt));
  const b = Math.max(0, Math.min(255, (n & 0xff) + amt));
  return `rgb(${r},${g},${b})`;
}

const TILE_PX = 16;
const VARIANTS = 3;

export class SpriteAtlas {
  private tiles = new Map<string, Canvas[]>();
  private citizenCache = new Map<string, Canvas>();
  private buildingCache = new Map<string, Canvas>();
  private markerCache = new Map<string, Canvas>();

  /** A ground tile for the given biome + this tile's coordinates (stable variant). */
  tileFor(biomeSprite: string, color: string, x: number, y: number): Canvas {
    let variants = this.tiles.get(biomeSprite);
    if (!variants) {
      variants = Array.from({ length: VARIANTS }, (_, i) => this.buildTerrainTile(biomeSprite, color, i));
      this.tiles.set(biomeSprite, variants);
    }
    const idx = Math.floor(hash(x, y, 7) * VARIANTS);
    return variants[idx];
  }

  private buildTerrainTile(sprite: string, color: string, seed: number): Canvas {
    const { c, ctx } = makeCanvas(TILE_PX, TILE_PX);
    ctx.fillStyle = color;
    ctx.fillRect(0, 0, TILE_PX, TILE_PX);
    // Light dither speckle for texture — a handful of slightly shaded pixels.
    const speckles = sprite === "water" || sprite === "ocean" ? 3 : 10;
    for (let i = 0; i < speckles; i++) {
      const px = Math.floor(hash(i, seed, 11) * TILE_PX);
      const py = Math.floor(hash(i, seed, 23) * TILE_PX);
      const dark = hash(i, seed, 31) > 0.5;
      ctx.fillStyle = shade(color, dark ? -18 : 14);
      ctx.fillRect(px, py, 1, 1);
    }
    if (sprite === "water" || sprite === "ocean") {
      // A couple of horizontal highlight strokes read as gentle waves.
      ctx.fillStyle = shade(color, 22);
      ctx.fillRect(2, 5 + seed * 2, 4, 1);
      ctx.fillRect(9, 9 + seed, 3, 1);
    }
    if (sprite === "snow") {
      ctx.fillStyle = "rgba(255,255,255,0.5)";
      for (let i = 0; i < 6; i++) {
        ctx.fillRect(Math.floor(hash(i, seed, 41) * TILE_PX), Math.floor(hash(i, seed, 53) * TILE_PX), 1, 1);
      }
    }
    return c;
  }

  /** A resource node icon (tree, rock, berry bush, ...) drawn pixel-blocky.
   * Trees/palms render at 2x this atlas's usual resolution (see `res` below)
   * — a single 16x16 canvas wasn't enough room for a canopy that reads as
   * "leafy clusters" rather than one flat green disc (bug report: "trees
   * are still not right"). */
  node(sprite: string, color: string): Canvas {
    const key = `node:${sprite}:${color}`;
    let c = this.markerCache.get(key);
    if (c) return c;
    const isTree = sprite === "tree" || sprite === "palm";
    const res = isTree ? TILE_PX * 2 : TILE_PX;
    const scale = res / TILE_PX;
    const built = makeCanvas(res, res);
    const ctx = built.ctx;
    const dark = shade(color, -30);
    const light = shade(color, 30);
    switch (sprite) {
      case "tree":
      case "palm": {
        // A cluster of DISTINCT, individually-outlined leaf lobes (not one
        // merged blob) — each lobe gets its own dark rim + mid fill +
        // highlight, and the rims where lobes meet stay visible so the
        // canopy reads as a bumpy cluster of foliage, not a flat disc.
        const s = scale;
        ctx.fillStyle = "#4a3018";
        ctx.fillRect(7 * s, 11 * s, 2 * s, 5 * s); // trunk
        ctx.fillStyle = "#33200f";
        ctx.fillRect(8.5 * s, 12 * s, 0.8 * s, 4 * s); // trunk shade line
        ctx.fillStyle = "#5a3c20";
        ctx.fillRect(7 * s, 11 * s, 0.8 * s, 5 * s); // trunk highlight

        const rim = shade(color, -46);
        const mid = shade(color, -8);
        // Five offset lobes (not concentric) — deliberately irregular radii
        // and positions so the silhouette scallops instead of forming a
        // circle. Drawn back-to-front (top/rear lobes first).
        const lobes: [number, number, number][] = [
          [8, 4.6, 3.1], // top-center, rear
          [4.6, 7, 3.0], // left
          [11.6, 6.6, 3.2], // right (slightly bigger)
          [7.6, 8.8, 3.4], // bottom-center-left, front (biggest, foreground)
          [11, 9.4, 2.4], // bottom-right, small front accent
        ];
        for (const [lx, ly, lr] of lobes) {
          ctx.fillStyle = rim;
          ctx.beginPath();
          ctx.arc(lx * s, ly * s, (lr + 0.55) * s, 0, Math.PI * 2);
          ctx.fill();
        }
        for (const [lx, ly, lr] of lobes) {
          ctx.fillStyle = mid;
          ctx.beginPath();
          ctx.arc(lx * s, ly * s, lr * s, 0, Math.PI * 2);
          ctx.fill();
          // Highlight crescent on the upper-left of each lobe.
          ctx.fillStyle = light;
          ctx.beginPath();
          ctx.arc((lx - lr * 0.32) * s, (ly - lr * 0.38) * s, lr * 0.42 * s, 0, Math.PI * 2);
          ctx.fill();
        }
        // A few near-black gap flecks between lobes read as depth/leaf-shadow.
        ctx.fillStyle = "rgba(10,20,8,0.55)";
        for (const [gx, gy] of [[7, 6.6], [10.2, 8], [6, 9.6], [12.4, 7.6]] as [number, number][]) {
          ctx.beginPath();
          ctx.arc(gx * s, gy * s, 0.6 * s, 0, Math.PI * 2);
          ctx.fill();
        }
        break;
      }
      case "rock":
      case "ore": {
        // Rounded boulder cluster with a cast shadow and lit tops — a fallback
        // for the rare tile before the real NodeImageAtlas rock art loads.
        ctx.fillStyle = "rgba(0,0,0,0.28)";
        ctx.beginPath();
        ctx.ellipse(8, 12, 6, 2.4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = shade(color, -34);
        ctx.beginPath(); ctx.ellipse(8, 10, 6, 4, 0, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = color;
        ctx.beginPath(); ctx.arc(6, 8, 3.6, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(10, 9, 3.2, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = light;
        ctx.beginPath(); ctx.arc(5.4, 7, 1.5, 0, Math.PI * 2); ctx.fill();
        ctx.beginPath(); ctx.arc(9.6, 8, 1.2, 0, Math.PI * 2); ctx.fill();
        break;
      }
      case "berry":
        ctx.fillStyle = shade(color, -40);
        ctx.fillRect(3, 6, 10, 7);
        for (const [bx, by] of [[4, 7], [8, 6], [6, 9], [10, 9]]) {
          ctx.fillStyle = color;
          ctx.fillRect(bx, by, 2, 2);
        }
        break;
      case "reeds":
      case "herb":
        ctx.fillStyle = color;
        for (let i = 0; i < 5; i++) {
          const bx = 3 + i * 2;
          ctx.fillRect(bx, 4 + (i % 2) * 2, 1, 10 - (i % 2) * 2);
        }
        break;
      case "crystal":
        ctx.fillStyle = dark;
        ctx.fillRect(6, 3, 4, 10);
        ctx.fillStyle = color;
        ctx.fillRect(5, 5, 6, 6);
        ctx.fillStyle = "rgba(255,255,255,0.7)";
        ctx.fillRect(6, 5, 2, 2);
        break;
      case "pond":
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.ellipse(8, 8, 6, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      default:
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(8, 8, 5, 0, Math.PI * 2);
        ctx.fill();
    }
    this.markerCache.set(key, built.c);
    return built.c;
  }

  /** A citizen or leader sprite: small blocky body + head, civ-colored tunic.
   * Proportions/hat/boots echo the extracted player art's silhouette (brimmed
   * hat, dark boots, warm skin tone) so procedural citizens read as the same
   * "world" as the real-art leader instead of a different, flatter style. */
  citizen(civColor: string, isLeader: boolean, carrying: boolean): Canvas {
    const key = `cit:${civColor}:${isLeader}:${carrying}`;
    let c = this.citizenCache.get(key);
    if (c) return c;
    const w = isLeader ? 14 : 12;
    // Taller canvas than the pre-art-pack version: fits a hat brim above the
    // head without clipping, and scales the citizen up toward the real
    // player art's on-screen height (drawn at 1.7x tile in Renderer) so
    // regular citizens don't look like a different, tinier species standing
    // next to the leader.
    const h = isLeader ? 24 : 22;
    const built = makeCanvas(w, h);
    const ctx = built.ctx;
    const skin = "#e8b48a";
    const boot = "#4a3524";
    // Shadow.
    ctx.fillStyle = "rgba(0,0,0,0.35)";
    ctx.beginPath();
    ctx.ellipse(w / 2, h - 2, w / 2 - 1, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // Boots.
    ctx.fillStyle = boot;
    ctx.fillRect(w / 2 - 3, h - 4, 2, 3);
    ctx.fillRect(w / 2 + 1, h - 4, 2, 3);
    // Legs.
    ctx.fillStyle = shade(civColor, -40);
    ctx.fillRect(w / 2 - 3, h - 9, 2, 5);
    ctx.fillRect(w / 2 + 1, h - 9, 2, 5);
    // Tunic body.
    ctx.fillStyle = civColor;
    ctx.fillRect(w / 2 - 4, h - 15, 8, 6);
    ctx.fillStyle = shade(civColor, 20);
    ctx.fillRect(w / 2 - 4, h - 15, 8, 2);
    // A darker belt line grounds the tunic against the legs.
    ctx.fillStyle = shade(civColor, -25);
    ctx.fillRect(w / 2 - 4, h - 9, 8, 1);
    // Head.
    ctx.fillStyle = skin;
    ctx.fillRect(w / 2 - 3, h - 20, 6, 6);
    // Brimmed hat — the player art's most recognizable silhouette cue.
    const hatColor = shade(civColor, -55);
    ctx.fillStyle = hatColor;
    ctx.fillRect(w / 2 - 4, h - 21, 8, 1); // brim
    ctx.fillRect(w / 2 - 3, h - 23, 6, 3); // crown
    // Leader accent: a small circlet worn over the hat.
    if (isLeader) {
      ctx.fillStyle = "#ffd36a";
      ctx.fillRect(w / 2 - 3, h - 22, 6, 1);
    }
    // Carried resource marker.
    if (carrying) {
      ctx.fillStyle = "#7fe08a";
      ctx.fillRect(w - 3, h - 18, 3, 3);
    }
    this.citizenCache.set(key, built.c);
    return built.c;
  }

  /** A building: blocky structure sized by tier, colored by its data color. */
  building(sprite: string, size: string, color: string, complete: boolean): Canvas {
    const key = `bld:${sprite}:${size}:${color}:${complete}`;
    let c = this.buildingCache.get(key);
    if (c) return c;
    const dims: Record<string, number> = { small: 18, medium: 22, large: 27 };
    const s = dims[size] ?? 18;
    const built = makeCanvas(s, s);
    const ctx = built.ctx;
    const base = complete ? color : "rgba(255,255,255,0.5)";
    const dark = complete ? shade(color, -35) : "rgba(255,255,255,0.3)";
    const light = complete ? shade(color, 25) : "rgba(255,255,255,0.7)";
    // Shadow footprint.
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(s / 2, s - 2, s / 2 - 1, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    // Body.
    const bodyH = Math.floor(s * 0.55);
    ctx.fillStyle = dark;
    ctx.fillRect(1, s - bodyH - 1, s - 2, bodyH);
    ctx.fillStyle = base;
    ctx.fillRect(2, s - bodyH, s - 4, bodyH - 2);
    // Roof (triangle-ish via stacked rects for a blocky pixel-roof look).
    const roofY = s - bodyH - 1;
    for (let i = 0; i < 4; i++) {
      const inset = i;
      ctx.fillStyle = i % 2 === 0 ? light : base;
      ctx.fillRect(2 + inset, roofY - 4 + i, s - 4 - inset * 2, 1);
    }
    // A door/window blip so it reads as a structure, not a blob.
    ctx.fillStyle = "rgba(20,20,25,0.6)";
    ctx.fillRect(s / 2 - 1, s - 5, 3, 4);
    this.buildingCache.set(key, built.c);
    return built.c;
  }

  /** A discoverable site marker (ruins/cave) — a small mysterious glyph tile. */
  site(kind: string): Canvas {
    const key = `site:${kind}`;
    let c = this.markerCache.get(key);
    if (c) return c;
    const built = makeCanvas(TILE_PX, TILE_PX);
    const ctx = built.ctx;
    if (kind === "ruins") {
      ctx.fillStyle = "#8a8f96";
      ctx.fillRect(3, 6, 3, 8);
      ctx.fillRect(10, 5, 3, 9);
      ctx.fillRect(6, 9, 4, 5);
      ctx.fillStyle = "#5a5f66";
      ctx.fillRect(3, 6, 3, 2);
      ctx.fillRect(10, 5, 3, 2);
    } else {
      ctx.fillStyle = "#2a2f38";
      ctx.beginPath();
      ctx.ellipse(8, 10, 6, 5, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = "#0d0f13";
      ctx.beginPath();
      ctx.ellipse(8, 10, 3.5, 3, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    this.markerCache.set(key, built.c);
    return built.c;
  }

  /** Decorative wildlife (spec: "ANIMALS MOVEMENT" showcase) — small blocky
   * silhouettes in the same flat pixel-art language as everything else in
   * this file. Purely cosmetic (see Renderer's wildlife pass); not gameplay
   * entities, so there's no id/stats, just a kind -> shape lookup. */
  animal(kind: string, facingLeft: boolean): Canvas {
    const key = `animal:${kind}:${facingLeft}`;
    let c = this.markerCache.get(key);
    if (c) return c;
    // Bear renders at 2x this atlas's usual animal resolution — the old
    // 20x16 blocky-rectangle silhouette read as an anonymous dark block, not
    // "a bear" (bug report: "the bear needs an artwork"); the extra room
    // lets it use the same rounded, individually-shaded-lobe technique as
    // the tree canopy redesign instead of flat rectangles.
    const isBear = kind === "bear";
    const scale = isBear ? 2 : 1;
    const w = 20 * scale, h = 16 * scale;
    const built = makeCanvas(w, h);
    const ctx = built.ctx;
    ctx.save();
    if (facingLeft) {
      ctx.translate(w, 0);
      ctx.scale(-1, 1);
    }
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.beginPath();
    ctx.ellipse(w / 2, h - 2, w / 2 - 2, 2, 0, 0, Math.PI * 2);
    ctx.fill();
    switch (kind) {
      case "deer": {
        const body = "#a8734a", dark = shade(body, -30), light = shade(body, 25);
        ctx.fillStyle = dark;
        ctx.fillRect(4, h - 8, 2, 5);
        ctx.fillRect(13, h - 8, 2, 5);
        ctx.fillStyle = body;
        ctx.fillRect(3, h - 12, 13, 6);
        ctx.fillStyle = light;
        ctx.fillRect(3, h - 12, 13, 2);
        ctx.fillStyle = body;
        ctx.fillRect(14, h - 14, 5, 5); // neck/head
        ctx.fillStyle = dark;
        ctx.fillRect(16, h - 16, 1, 3); // antler hint
        break;
      }
      case "wolf": {
        const body = "#7a7f88", dark = shade(body, -35);
        ctx.fillStyle = dark;
        ctx.fillRect(4, h - 7, 2, 4);
        ctx.fillRect(12, h - 7, 2, 4);
        ctx.fillStyle = body;
        ctx.fillRect(3, h - 10, 12, 5);
        ctx.fillStyle = body;
        ctx.fillRect(13, h - 11, 5, 4);
        ctx.fillStyle = dark;
        ctx.fillRect(17, h - 12, 2, 1); // ear
        break;
      }
      case "alphawolf": {
        // Wildlife variety's "rarer alpha tier" — a bigger, darker wolf
        // with a rust-red eye accent so it reads as the pack leader even
        // at a glance, distinct from a plain wolf's flat grey.
        const body = "#3f4249", dark = shade(body, -35), eye = "#c94636";
        ctx.fillStyle = dark;
        ctx.fillRect(3, h - 8, 3, 5);
        ctx.fillRect(13, h - 8, 3, 5);
        ctx.fillStyle = body;
        ctx.fillRect(2, h - 12, 15, 6);
        ctx.fillStyle = body;
        ctx.fillRect(15, h - 14, 6, 5);
        ctx.fillStyle = dark;
        ctx.fillRect(19, h - 15, 2, 2); // ear
        ctx.fillStyle = eye;
        ctx.fillRect(17, h - 12, 1, 1);
        break;
      }
      case "bear": {
        // A rare, dangerous forest encounter (spec: "fight the player when
        // in range" + "2 shots") — deliberately bulkier and darker than the
        // wolf so it reads as more threatening at a glance. Rounded,
        // individually-shaded lobes (same technique as the tree canopy)
        // instead of flat rectangles, at 2x resolution (see `scale` above).
        const s = scale;
        const H = 16; // unscaled reference height this design was authored at
        const body = "#4a3320", rim = shade(body, -42), mid = shade(body, -14), light = shade(body, 22);
        // Legs — stubby rounded, planted under the hunched body.
        ctx.fillStyle = rim;
        for (const [lx, ly] of [[4, H - 7], [8, H - 7], [13, H - 7], [17, H - 7]] as [number, number][]) {
          ctx.beginPath();
          ctx.ellipse(lx * s, ly * s, 1.9 * s, 3.6 * s, 0, 0, Math.PI * 2);
          ctx.fill();
        }
        // Hunched body hump — the bear's defining silhouette cue.
        ctx.fillStyle = rim;
        ctx.beginPath();
        ctx.ellipse(9.5 * s, (H - 10) * s, 9.2 * s, 6.4 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.ellipse(9 * s, (H - 10.5) * s, 8.2 * s, 5.4 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = light;
        ctx.beginPath();
        ctx.ellipse(7.5 * s, (H - 13) * s, 4.4 * s, 2.4 * s, -0.2, 0, Math.PI * 2);
        ctx.fill();
        // Head, held low and forward.
        ctx.fillStyle = rim;
        ctx.beginPath();
        ctx.ellipse(17 * s, (H - 11) * s, 3.6 * s, 3.1 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = mid;
        ctx.beginPath();
        ctx.ellipse(17.4 * s, (H - 10.6) * s, 3 * s, 2.6 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        // Snout.
        ctx.fillStyle = rim;
        ctx.beginPath();
        ctx.ellipse(18.8 * s, (H - 9.6) * s, 1.6 * s, 1.2 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = "#1a1310";
        ctx.beginPath();
        ctx.ellipse(19.6 * s, (H - 9.6) * s, 0.6 * s, 0.5 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        // Round ears.
        ctx.fillStyle = rim;
        ctx.beginPath();
        ctx.ellipse(15.6 * s, (H - 14) * s, 1.3 * s, 1.3 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(18.4 * s, (H - 14) * s, 1.3 * s, 1.3 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        // Small dark eye.
        ctx.fillStyle = "#1a1310";
        ctx.beginPath();
        ctx.ellipse(18.2 * s, (H - 11.4) * s, 0.5 * s, 0.5 * s, 0, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
      case "horse": {
        const body = "#5a3c26", dark = shade(body, -30), light = shade(body, 20);
        ctx.fillStyle = dark;
        ctx.fillRect(4, h - 9, 2, 6);
        ctx.fillRect(14, h - 9, 2, 6);
        ctx.fillStyle = body;
        ctx.fillRect(3, h - 13, 15, 6);
        ctx.fillStyle = light;
        ctx.fillRect(3, h - 13, 15, 2);
        ctx.fillStyle = body;
        ctx.fillRect(16, h - 16, 4, 6); // neck/head up
        break;
      }
      case "cow": {
        const body = "#e6e0d4", dark = "#3a3530";
        ctx.fillStyle = dark;
        ctx.fillRect(4, h - 8, 2, 5);
        ctx.fillRect(13, h - 8, 2, 5);
        ctx.fillStyle = body;
        ctx.fillRect(3, h - 12, 14, 6);
        ctx.fillStyle = dark;
        ctx.fillRect(6, h - 11, 3, 3);
        ctx.fillRect(11, h - 10, 2, 2);
        ctx.fillStyle = body;
        ctx.fillRect(15, h - 13, 4, 5);
        break;
      }
      case "sheep": {
        const body = "#efe9df", dark = "#4a453e";
        ctx.fillStyle = dark;
        ctx.fillRect(4, h - 7, 2, 4);
        ctx.fillRect(11, h - 7, 2, 4);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(9, h - 9, 7, 5, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = dark;
        ctx.fillRect(14, h - 11, 4, 4);
        break;
      }
      case "chicken":
      default: {
        const body = "#f2ede0", accent = "#c94b2b";
        ctx.fillStyle = shade(body, -20);
        ctx.fillRect(7, h - 5, 2, 3);
        ctx.fillRect(10, h - 5, 2, 3);
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(9, h - 8, 5, 4, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = body;
        ctx.fillRect(12, h - 12, 3, 4);
        ctx.fillStyle = accent;
        ctx.fillRect(13, h - 13, 2, 2);
        break;
      }
    }
    ctx.restore();
    this.markerCache.set(key, built.c);
    return built.c;
  }
}

export const TILE_LOGICAL_PX = TILE_PX;
