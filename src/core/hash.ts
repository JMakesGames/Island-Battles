// Deterministic per-tile hash, shared by the Renderer (cosmetic placement:
// vegetation sway, water shimmer, wildlife spawns) and gameplay systems that
// need to agree on "what's at this tile" without any extra networked state
// (e.g. WildlifeSystem hunting the same animal the client is drawing).
export function hash01(x: number, y: number, salt: number): number {
  let h = (x * 374761393 + y * 668265263 + salt * 2246822519) | 0;
  h = (h ^ (h >>> 13)) * 1274126177;
  h = h ^ (h >>> 16);
  return ((h >>> 0) % 10000) / 10000;
}
