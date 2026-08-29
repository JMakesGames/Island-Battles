// Loads the real pixel-art player frames extracted from the art reference
// pack (VISUAL DIRECTION RESET) — 8 directions x 8 walk-cycle frames each,
// under public/sprites/player/{direction}_{col}.png. Vite serves anything in
// public/ at the same path, so these load via plain <img> src requests, no
// bundler import needed. Falls back to null per-frame until each image has
// finished loading (Renderer keeps using the procedural SpriteAtlas citizen
// sprite for anyone whose frame isn't ready yet, e.g. very first paint).
//
// Every leader (spec: "fix the other leaders, they are just cubes and
// circles right now... make it look like my leader, but change the color of
// their cape/shirt depending on what color team they are on") uses this same
// art, recolored per civ — see recolorCape below.
//
// The single-file standalone build (scripts/build-standalone.mjs) has no
// server to serve /sprites/... from, so it base64-inlines every frame into
// a `window.__EMBEDDED_SPRITES__` map and we prefer that when present.
import type { Direction8 } from "../core/types.ts";

declare global {
  interface Window {
    __EMBEDDED_SPRITES__?: Record<string, string>;
  }
}

const DIRECTIONS: Direction8[] = [
  "up", "upright", "right", "downright",
  "down", "downleft", "left", "upleft",
];
const FRAMES_PER_DIR = 8;
const MS_PER_FRAME = 75; // walk-cycle step rate — matched to the leader's speed boost

// The reference sheet's own row labels don't match what's actually drawn in
// them (e.g. the row printed "DOWN" shows a back-facing walk-away pose) —
// remap direction -> filename key here rather than re-extract.
//
// The diagonal/left-right rows turned out to be an unreliable extraction:
// "right", "upright", "downright", "downleft", and "left" all show the
// SAME rightward-leaning pose (confirmed by direct pixel inspection) —
// only "upleft" is genuinely left-leaning. Under the old table, facing
// "downleft" resolved to the "upright" file, which is one of the
// rightward-posed ones — the character played a rightward walk while
// moving down-left (bug report). Rather than trust any more of these
// inconsistent diagonal files, every leftward-ish direction now reuses the
// one verified-good rightward file ("right") and gets mirrored at draw
// time instead (see FLIP_LEFT below + Renderer's leader draw), the same
// technique already used for citizens/animals elsewhere in this file.
const FILE_DIR: Record<Direction8, Direction8> = {
  up: "down", down: "up",
  left: "right", right: "right",
  upright: "right", downright: "right",
  upleft: "right", downleft: "right",
};

/** Directions that need the shared rightward frame mirrored horizontally.
 * Inverted from the "obvious" left/right split on explicit user report
 * ("going left shows the right animation and vice versa — flip it, trust
 * me") — the source file's walk cycle reads as left-facing by default, not
 * right-facing as the rest of this file's naming assumed. */
export const FLIP_LEFT: Record<Direction8, boolean> = {
  up: false, down: false,
  right: true, upright: true, downright: true,
  left: false, upleft: false, downleft: false,
};

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const hue2rgb = (p: number, q: number, t: number): number => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [
    Math.round(hue2rgb(p, q, h + 1 / 3) * 255),
    Math.round(hue2rgb(p, q, h) * 255),
    Math.round(hue2rgb(p, q, h - 1 / 3) * 255),
  ];
}

function hexToHue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return rgbToHsl((n >> 16) & 255, (n >> 8) & 255, n & 255)[0];
}

// Sampled from the extracted art itself (public/sprites/player/*.png): the
// cloak/tunic sits at roughly hue 190-255° (blue-violet), while skin
// (~30-45°) and hair/shadow tones fall well clear of that band — so an
// in-place hue swap recolors only the garment and leaves everything else
// alone. Desaturated near-black shadow/outline pixels (sat < 0.12) are
// skipped too: shifting a nearly-gray pixel's hue does nothing visible but
// risks introducing color fringing at the cloak's dark edges.
const CAPE_HUE_MIN = 190 / 360;
const CAPE_HUE_MAX = 255 / 360;
const CAPE_SAT_MIN = 0.12;

function recolorCape(img: HTMLImageElement, targetHex: string): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const image = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const targetHue = hexToHue(targetHex);
  const d = image.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) continue;
    const [h, s, l] = rgbToHsl(d[i], d[i + 1], d[i + 2]);
    if (s < CAPE_SAT_MIN || h < CAPE_HUE_MIN || h > CAPE_HUE_MAX) continue;
    const [r, g, b] = hslToRgb(targetHue, s, l);
    d[i] = r;
    d[i + 1] = g;
    d[i + 2] = b;
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A ready-to-draw frame: HTMLCanvasElement lacks naturalWidth/Height, so
 * callers get the dimensions alongside the drawable element instead. */
export interface SpriteFrame {
  el: CanvasImageSource;
  width: number;
  height: number;
}

export class ImageSpriteAtlas {
  private frames = new Map<string, HTMLImageElement>();
  private loaded = new Set<string>();
  /** Recolored-per-team cache, keyed `${frameKey}|${colorHex}`. */
  private recolored = new Map<string, HTMLCanvasElement>();

  constructor() {
    const embedded = typeof window !== "undefined" ? window.__EMBEDDED_SPRITES__ : undefined;
    for (const dir of DIRECTIONS) {
      for (let col = 0; col < FRAMES_PER_DIR; col++) {
        const key = `${dir}_${col}`;
        const img = new Image();
        img.onload = () => this.loaded.add(key);
        img.src = embedded?.[key] ?? `/sprites/player/${key}.png`;
        this.frames.set(key, img);
      }
    }
  }

  /** True once every player walk frame has finished loading. */
  get ready(): boolean {
    return this.loaded.size === DIRECTIONS.length * FRAMES_PER_DIR;
  }

  /** The frame for a direction at a given animation time, recolored to
   * `teamColor`'s cape/cloak — null if that specific frame image hasn't
   * loaded yet.
   *
   * Column layout of the extracted sheet: col 0 is a hunched weapon-ready
   * stance; cols 1-7 are the walk cycle. Idle now holds col 1 (a clean upright
   * standing frame), NOT col 0 — the col-0 crouch tucks the head down into the
   * body, which is exactly the "head disappears when standing still / walking
   * up" bug (report). Col 0 is instead used only for the brief attack pose so
   * a swing reads as a distinct lunge. */
  frameFor(
    dir: Direction8,
    timeMs: number,
    moving: boolean,
    teamColor: string,
    attacking = false,
  ): SpriteFrame | null {
    const WALK_FRAMES = FRAMES_PER_DIR - 1;
    let col: number;
    if (attacking) col = 0;
    else if (moving) col = 1 + (Math.floor(timeMs / MS_PER_FRAME) % WALK_FRAMES);
    else col = 1; // upright standing idle, never the col-0 crouch
    const key = `${FILE_DIR[dir]}_${col}`;
    if (!this.loaded.has(key)) return null;
    const cacheKey = `${key}|${teamColor}`;
    let canvas = this.recolored.get(cacheKey);
    if (!canvas) {
      canvas = recolorCape(this.frames.get(key)!, teamColor);
      this.recolored.set(cacheKey, canvas);
    }
    return { el: canvas, width: canvas.width, height: canvas.height };
  }
}
