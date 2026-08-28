# Island Battles — Art Asset Request

I'm building a browser game called **Island Battles** (a multiplayer civ-building / survival game — think a lightweight Settlers/Banished with wildlife, combat, and diplomacy). It renders in an HTML5 Canvas with a flat top-down "2.5D" camera (not true isometric — sprites are just anchored taller than their footprint to fake depth). Everything uses **pixel art with painterly shading** — semi-realistic little sprites, not flat 1-bit blocky pixel art. Backgrounds must be **transparent PNG**.

I need a few specific assets to replace placeholder/procedural art. Please generate each as a **separate transparent PNG**.

## Existing style reference (for consistency)

These are examples of assets already in the game, extracted from a licensed art pack — match this exact style (painterly pixel shading, soft anti-aliased edges, natural color palette, subtle drop-shadow-free silhouette):

- **Animals** are drawn **side-view, walking pose, facing left**, roughly 140–170px wide x 110–135px tall, transparent background. Example subjects already done: wolf, horse, deer, boar, cow, sheep, chicken.
- **Resource nodes** (bushes, rocks, wheat) are drawn **from a slight top-down/three-quarter angle**, roughly 50–95px square, transparent background, sitting as if viewed from just above.

## What I need

### 1. Bear (side-view, walking) — highest priority
Same style/angle as the wolf and horse reference above: side-view, walking pose, facing left, transparent background, roughly 160–200px wide x 130–160px tall (bear should read as bulkier/taller than the wolf, comparable to or slightly bigger than the horse). A big forest brown bear, slightly hunched, rounded muscular build, small round ears, dark snout. Should read as "dangerous forest predator" at a glance — currently I only have a crude programmer-art placeholder for this one.

### 2. Tree (top-down node icon) — highest priority
Same style/angle as the berry bush / rock reference above: three-quarter top-down view, transparent background, roughly 60–90px square. A single deciduous tree with a **rounded, lobed/clustered canopy** (should read as distinct leafy clusters, not one flat green blob) and a visible brown trunk peeking out at the base. I'd like two variants if possible:
   - a temperate/grassland tree (mid-green canopy)
   - a jungle/palm tree (tall thin trunk, fan-shaped fronds, tropical green)

### 3. (Nice to have) Alpha wolf (side-view, walking)
Same spec as the bear — side-view, walking, facing left, transparent background, ~150–180px wide. A larger, darker wolf than the regular wolf (near-black fur, one small rust-red accent like an eye glow) to read as a "pack leader" tier enemy.

## Technical constraints (please follow exactly)
- Transparent background (no white/checkerboard baked in).
- Side-view assets face **left**.
- No drop shadow baked into the image — the game engine draws its own shadow underneath.
- Keep the color palette natural/muted (earth tones, forest greens/browns) to match the rest of the world.
- Export as PNG, one asset per file.

Thanks!
