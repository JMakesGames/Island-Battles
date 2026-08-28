// Real pixel-art citizen frames extracted from the art reference pack —
// six job "looks" (farmer/woodcutter/miner/builder/fisherman/child), each a
// short side-view walk cycle, under public/sprites/citizens/{job}_{n}.png.
// The game's CitizenJob ("idle"/"gather"/"haul"/"build"/"explore") isn't
// granular enough to map to a specific look (gather covers wood, stone,
// food, everything), so each citizen instead gets a stable look assigned
// from a hash of their id — same citizen always renders the same, and the
// population reads as visually varied instead of every worker being
// identical. Falls back to null (procedural sprite) until loaded.
declare global {
  interface Window {
    __EMBEDDED_CITIZEN_SPRITES__?: Record<string, string>;
  }
}

const JOB_FRAME_COUNTS: Record<string, number> = {
  farmer: 4,
  woodcutter: 5,
  miner: 5,
  builder: 3,
  fisherman: 4,
  child: 3,
};
const JOBS = Object.keys(JOB_FRAME_COUNTS);
const MS_PER_FRAME = 130;

function hash01(x: number, salt: number): number {
  let h = (x * 374761393 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}

export class CitizenImageAtlas {
  private frames = new Map<string, HTMLImageElement>();
  private loaded = new Set<string>();

  constructor() {
    const embedded = typeof window !== "undefined" ? window.__EMBEDDED_CITIZEN_SPRITES__ : undefined;
    for (const job of JOBS) {
      for (let i = 0; i < JOB_FRAME_COUNTS[job]; i++) {
        const key = `${job}_${i}`;
        const img = new Image();
        img.onload = () => this.loaded.add(key);
        img.src = embedded?.[key] ?? `/sprites/citizens/${key}.png`;
        this.frames.set(key, img);
      }
    }
  }

  /** Stable per-citizen look, independent of their current job assignment. */
  lookFor(citizenId: number): string {
    return JOBS[Math.floor(hash01(citizenId, 991) * JOBS.length)];
  }

  frameFor(citizenId: number, timeMs: number, moving: boolean): HTMLImageElement | null {
    const job = this.lookFor(citizenId);
    const count = JOB_FRAME_COUNTS[job];
    const col = moving ? Math.floor(timeMs / MS_PER_FRAME) % count : 0;
    const key = `${job}_${col}`;
    return this.loaded.has(key) ? this.frames.get(key)! : null;
  }
}
