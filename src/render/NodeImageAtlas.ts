// Real pixel-art resource-node icons extracted from the same art reference
// pack as terrain/citizens/animals (spec: "the trees, rocks, wheat, and the
// weird mushroom things on the floor are still not in the form of the
// game" — a follow-up to the terrain fix: node markers were still the old
// flat procedural rectangles/dots, which now reads as mismatched next to
// real terrain). Under public/sprites/nodes/:
//   - wheat.png / herb.png / berry.png — cropped from page 5's "Crops /
//     Farming" icon grid (clean dark background, easy to key transparent).
//   - rock.png — the "Rock" isometric terrain tile's rock-mound art, keyed
//     transparent the same way (it was already isolated against black).
// Trees have no equivalent clean source (every tree in the pack is painted
// directly onto a grass background with no separable edge for a simple
// color-key cut — that needs real ML segmentation, out of scope here), so
// "tree"/"palm" still fall back to SpriteAtlas's procedural icon.
//
// Falls back to null (Renderer keeps using the procedural SpriteAtlas icon)
// until the relevant image has loaded — same pattern as TerrainImageAtlas.

declare global {
  interface Window {
    __EMBEDDED_NODE_SPRITES__?: Record<string, string>;
  }
}

const NODE_KEYS = ["wheat", "herb", "berry", "rock"] as const;
type NodeKey = (typeof NODE_KEYS)[number];

// Maps a resource-node sprite key (see Renderer's spriteKeyForNode) to one
// of the real extracted icons above.
const NODE_SOURCE: Record<string, NodeKey> = {
  reeds: "wheat",
  herb: "herb",
  berry: "berry",
  rock: "rock",
  ore: "rock",
};

export class NodeImageAtlas {
  private images = new Map<NodeKey, HTMLImageElement>();
  private loaded = new Set<NodeKey>();

  constructor() {
    const embedded = typeof window !== "undefined" ? window.__EMBEDDED_NODE_SPRITES__ : undefined;
    for (const key of NODE_KEYS) {
      const img = new Image();
      img.onload = () => this.loaded.add(key);
      img.src = embedded?.[key] ?? `/sprites/nodes/${key}.png`;
      this.images.set(key, img);
    }
  }

  /** The real icon for a node sprite key, or null if unmapped / not yet
   * loaded — Renderer falls back to SpriteAtlas.node() in that case. */
  iconFor(nodeSprite: string): HTMLImageElement | null {
    const key = NODE_SOURCE[nodeSprite];
    if (!key || !this.loaded.has(key)) return null;
    return this.images.get(key)!;
  }
}
