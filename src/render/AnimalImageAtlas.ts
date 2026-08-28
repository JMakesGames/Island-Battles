// Real pixel-art animal frames extracted from the art reference pack —
// under public/sprites/animals/{kind}_{n}.png. Purely cosmetic wildlife (see
// Renderer's wildlife pass); falls back to null (procedural sprite) until a
// given frame has loaded.
declare global {
  interface Window {
    __EMBEDDED_ANIMAL_SPRITES__?: Record<string, string>;
  }
}

const ANIMAL_FRAME_COUNTS: Record<string, number> = {
  deer: 4,
  wolf: 4,
  boar: 4,
  horse: 3,
  cow: 3,
  sheep: 3,
  chicken: 3,
};
const MS_PER_FRAME = 160;

export class AnimalImageAtlas {
  private frames = new Map<string, HTMLImageElement>();
  private loaded = new Set<string>();

  constructor() {
    const embedded = typeof window !== "undefined" ? window.__EMBEDDED_ANIMAL_SPRITES__ : undefined;
    for (const kind of Object.keys(ANIMAL_FRAME_COUNTS)) {
      for (let i = 0; i < ANIMAL_FRAME_COUNTS[kind]; i++) {
        const key = `${kind}_${i}`;
        const img = new Image();
        img.onload = () => this.loaded.add(key);
        img.src = embedded?.[key] ?? `/sprites/animals/${key}.png`;
        this.frames.set(key, img);
      }
    }
  }

  frameFor(kind: string, timeMs: number): HTMLImageElement | null {
    const count = ANIMAL_FRAME_COUNTS[kind];
    if (!count) return null;
    const col = Math.floor(timeMs / MS_PER_FRAME) % count;
    const key = `${kind}_${col}`;
    return this.loaded.has(key) ? this.frames.get(key)! : null;
  }
}
