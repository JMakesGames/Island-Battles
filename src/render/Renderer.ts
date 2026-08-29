// Canvas renderer. Pixel-art via SpriteAtlas (nearest-neighbor, no
// anti-aliasing — see that file's header for the full rationale) blitted
// through a flat top-down orthogonal projection (Camera) — not true
// isometric; the "2.5D" read comes from presentation tricks (drop shadows,
// sprites anchored taller than their footprint), painter's-algorithm depth
// sorting by screen row, fog of war, and construction/citizen feedback (spec
// §37). Purely a view of GameState — it holds no game truth.

import type { GameState } from "../game/GameState.ts";
import type { Camera } from "./Camera.ts";
import type { Vec2 } from "../core/types.ts";
import { getBiome, getBuilding, getMarketItem, getCompanion } from "../game/config.ts";
import { SpriteAtlas } from "./SpriteAtlas.ts";
import { TerrainImageAtlas } from "./TerrainImageAtlas.ts";
import { NodeImageAtlas } from "./NodeImageAtlas.ts";
import { ImageSpriteAtlas, FLIP_LEFT } from "./ImageSpriteAtlas.ts";
import { CitizenImageAtlas } from "./CitizenImageAtlas.ts";
import { AnimalImageAtlas } from "./AnimalImageAtlas.ts";
import { hash01 } from "../core/hash.ts";
import { emojiIconCanvas, pixelIconCanvas } from "../ui/PixelIcons.ts";
import { animalAt, HITS_TO_KILL } from "../systems/WildlifeSystem.ts";

const RALLY_RADIUS = 2.5; // must match systems/LeaderSystem.ts

type Weather = "sunny" | "rain" | "storm" | "snow";
const RAIN_PARTICLES = 90;
const SNOW_PARTICLES = 70;

/** Purely cosmetic, client-derived from state.day + state.season — both
 * already replicated to every client via the normal Snapshot, so this needs
 * no new networked state or Simulation change to agree across multiplayer
 * clients, and it's never read back into gameplay (spec: rendering only). */
function weatherFor(day: number, season: string): Weather {
  const roll = hash01(day, 0, 4242);
  if (season === "winter") return roll < 0.65 ? "snow" : roll < 0.85 ? "sunny" : "rain";
  if (roll < 0.62) return "sunny";
  if (roll < 0.88) return "rain";
  return "storm";
}

/** Cosmetic day/night cycle — a screen-space tint driven by time-of-day, not
 * a new lighting model. Purely visual; gameplay never reads it. */
function nightAlpha(timeOfDay: number): number {
  // timeOfDay in [0,1): 0 = midnight, 0.5 = noon. Full dark from ~9pm-4am,
  // dawn/dusk twilight ramps either side, bright the rest of the day.
  const dist = Math.min(Math.abs(timeOfDay - 0), Math.abs(timeOfDay - 1)); // distance to midnight
  if (dist < 0.08) return 0.55; // dead of night
  if (dist < 0.2) return 0.55 * (1 - (dist - 0.08) / 0.12); // twilight ramp
  return 0;
}

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private atlas = new SpriteAtlas();
  private terrainAtlas = new TerrainImageAtlas();
  private nodeAtlas = new NodeImageAtlas();
  private playerAtlas = new ImageSpriteAtlas();
  private citizenAtlas = new CitizenImageAtlas();
  private animalAtlas = new AnimalImageAtlas();
  private prevPos = new Map<number, Vec2>();
  private lastMovedAt = new Map<number, number>();
  // Combat projectiles (spec: "arrows, weapons... should fly in the air and be
  // visible"). Purely a client-side visual: the authoritative sim resolves
  // combat as before; we just watch for the moment a citizen's attackCooldown
  // jumps to its max (== a swing just landed) and spawn a flying arrow (ranged
  // jobs) or a slash arc (melee) between attacker and target. No new networked
  // state, so it works identically in solo and multiplayer.
  private projectiles: { x: number; y: number; tx: number; ty: number; born: number; dur: number; kind: "arrow" | "slash" }[] = [];
  private lastAtkCd = new Map<number, number>();

  constructor(private canvas: HTMLCanvasElement, private cam: Camera) {
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("2D canvas context unavailable");
    ctx.imageSmoothingEnabled = false; // crisp pixel-art scaling, never blurry
    this.ctx = ctx;
  }

  resize(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.canvas.width = Math.floor(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.floor(this.canvas.clientHeight * dpr);
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.imageSmoothingEnabled = false;
  }

  draw(
    state: GameState,
    hover: Vec2 | null,
    placingId: string | null,
    myCivId: number,
    selectedCitizenId: number | null = null,
  ): void {
    this.cam.tick(); // ease any pending zoom-tier transition (smooth zoom)
    const { ctx, cam, canvas, atlas, nodeAtlas } = this;
    const ts = cam.tileSize;
    const now = performance.now();
    ctx.fillStyle = "#0a0d12";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Visible tile window.
    const topLeft = cam.screenToWorld(0, 0);
    const botRight = cam.screenToWorld(canvas.width, canvas.height);
    const x0 = Math.max(0, Math.floor(topLeft.x) - 1);
    const y0 = Math.max(0, Math.floor(topLeft.y) - 1);
    const x1 = Math.min(state.world.w - 1, Math.ceil(botRight.x) + 1);
    const y1 = Math.min(state.world.h - 1, Math.ceil(botRight.y) + 1);

    // Terrain textures are independent opaque photos, one per tile — no
    // amount of upscale smoothing removes a seam between two fully-opaque
    // images, since whichever is painted last just cuts a hard edge over its
    // neighbor (the earlier "bleed" attempt only moved the seam, it didn't
    // blend it). The real fix: paint a flat, same-biome-is-same-color base
    // across the whole grid first — biome.color is identical for every tile
    // of that biome, so two adjacent grass tiles' base layers are pixel-
    // identical and the boundary between them is invisible by construction —
    // then lay the real photo texture on top at partial alpha as *detail*,
    // not as the tile's sole identity. A translucent texture's mismatched
    // edge against its neighbor reads as natural variation in one continuous
    // field instead of a grid of distinct "cube" photos.
    ctx.imageSmoothingEnabled = true;
    const bleed = Math.max(2, ts * 0.12);
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const t = state.world.tiles[state.world.idx(x, y)];
        const s = cam.worldToScreen(x, y);
        if (!t.explored) {
          ctx.fillStyle = "#0d1117";
          ctx.fillRect(s.x, s.y, ts + 1, ts + 1);
          continue;
        }
        const biome = getBiome(t.biome);
        ctx.fillStyle = biome.color;
        ctx.fillRect(s.x, s.y, ts + 1, ts + 1);
        // Real extracted art (see TerrainImageAtlas) once it's loaded, blended
        // over the flat base above; the old flat-fill-plus-speckle procedural
        // tile is only a fallback for the first frame or so before those
        // images finish loading (drawn fully opaque — it already IS just a
        // flat color, no seam to hide).
        const realTile = this.terrainAtlas.tileFor(biome.sprite, x, y);
        if (realTile) {
          ctx.globalAlpha = 0.62;
          ctx.drawImage(realTile, s.x - bleed, s.y - bleed, ts + 1 + bleed * 2, ts + 1 + bleed * 2);
          ctx.globalAlpha = 1;
        } else {
          const tile = atlas.tileFor(biome.sprite, biome.color, x, y);
          ctx.drawImage(tile, 0, 0, tile.width, tile.height, s.x, s.y, ts + 1, ts + 1);
        }

        // Water animation: a soft diagonal glint sweeps each water/ocean tile
        // over time. The phase offset must vary smoothly with position (not
        // a per-tile hash) — hash01 gives every tile an uncorrelated random
        // phase, so at any instant roughly half the tiles sit near peak
        // brightness and half near zero, which reads as a flickering
        // checkerboard instead of a sweep (bug report: "still a
        // checkerboard"). A linear gradient across x+y makes neighboring
        // tiles' phases nearly identical, so the brightness flows as an
        // actual diagonal band.
        if (biome.sprite === "water" || biome.sprite === "ocean") {
          const phase = (now / 1400 + (x + y) * 0.05) % 1;
          const glintAlpha = Math.max(0, Math.sin(phase * Math.PI * 2)) * 0.16;
          if (glintAlpha > 0.01) {
            ctx.fillStyle = `rgba(210,240,255,${glintAlpha})`;
            ctx.fillRect(s.x, s.y, ts + 1, ts + 1);
          }
        }

        if (t.road) {
          const roadTile = this.terrainAtlas.road();
          if (roadTile) {
            ctx.drawImage(roadTile, s.x + ts * 0.1, s.y + ts * 0.1, ts * 0.8, ts * 0.8);
          } else {
            ctx.fillStyle = "rgba(138,125,99,0.55)";
            ctx.fillRect(s.x + ts * 0.15, s.y + ts * 0.15, ts * 0.7, ts * 0.7);
          }
        }

        // Discoverable sites (spec §13) — only ever drawn once explored, and
        // only until found, so the mystery reads clearly on the map.
        if (t.site >= 0) {
          const site = state.world.sites[t.site];
          if (!site.discovered) {
            const marker = atlas.site(site.kind);
            ctx.drawImage(marker, 0, 0, marker.width, marker.height, s.x, s.y, ts, ts);
          }
        }

        // Resource node marker. Foliage (trees/reeds/herbs) gets a gentle
        // sway, phase-offset per tile so a stand of trees doesn't move in
        // lockstep — the cheapest "living world" cue for vegetation.
        if (t.node >= 0) {
          const node = state.world.nodes[t.node];
          if (node.remaining > 0) {
            const key = spriteKeyForNode(node.id);
            // Real extracted art (see NodeImageAtlas) once it's loaded, same
            // fallback pattern as terrain: the old procedural icon covers
            // the first frame or so, and anything without a clean source
            // (trees — every reference tree is painted onto grass with no
            // separable edge to key transparent) permanently.
            const img = nodeAtlas.iconFor(key) ?? atlas.node(key, node.color);
            if (key === "tree" || key === "palm" || key === "reeds" || key === "herb") {
              const swayPhase = hash01(x, y, 63) * Math.PI * 2;
              const sway = Math.sin(now / 900 + swayPhase) * 0.05;
              const baseX = s.x + ts / 2, baseY = s.y + ts;
              ctx.save();
              ctx.translate(baseX, baseY);
              ctx.rotate(sway);
              ctx.translate(-baseX, -baseY);
              ctx.drawImage(img, s.x, s.y, ts, ts);
              ctx.restore();
            } else {
              ctx.drawImage(img, s.x, s.y, ts, ts);
            }
          }
        }
      }
    }
    ctx.imageSmoothingEnabled = false; // back to crisp for sprites/icons/UI markers

    // Buildings + citizens, per civ. Civs other than this client's are only
    // drawn on tiles it has explored, preserving the mystery of who lives
    // where (spec §13, §23) — "isPlayer" means "mine", not "civ 0".
    const explored = (x: number, y: number): boolean =>
      !!state.world.tileAt(Math.round(x), Math.round(y))?.explored;

    type Entity = { depth: number; draw: () => void };
    const entities: Entity[] = [];

    // Wildlife (spec: "ANIMALS MOVEMENT" showcase) — sparse, deterministic
    // per-tile spawns (same hash approach as vegetation sway) so every
    // client renders the same animals without any new networked state; they
    // wander in a small bounded loop around their home tile. Most are
    // decorative, but wolves/bears are real hunt targets that chase and
    // fight back (see systems/WildlifeSystem.ts, the single source of truth
    // for "is there an animal here" that this rendering pass mirrors
    // exactly) — pushAnimal is shared with the live-monster pass below it,
    // since both draw the same sprite, just at a different position.
    // Relative to the leader/citizen reference height of ts*1.7 ("a person" —
    // see the citizen draw below), so a wolf reads meaningfully smaller than
    // a horse instead of every species sharing one flat height (bug report:
    // "the wolf is bigger than the horse... sized to the size of a person").
    // Values are shoulder/body height as a fraction of a standing person.
    const ANIMAL_HEIGHT_FACTOR: Record<string, number> = {
      chicken: 0.28,
      sheep: 0.55,
      boar: 0.55,
      wolf: 0.62,
      deer: 0.85,
      alphawolf: 0.72,
      cow: 0.95,
      horse: 1.05,
      bear: 1.1,
    };
    const ANIMAL_DEFAULT_FACTOR = 0.7;

    const pushAnimal = (kind: string, wx: number, wy: number, facingLeft: boolean, wounds?: number): void => {
      entities.push({
        depth: wy,
        draw: () => {
          const s = cam.worldToScreen(wx, wy);
          const cx = s.x + ts / 2, cy = s.y + ts;
          ctx.fillStyle = "rgba(0,0,0,0.28)";
          ctx.beginPath();
          ctx.ellipse(cx, cy - ts * 0.05, ts * 0.22, ts * 0.09, 0, 0, Math.PI * 2);
          ctx.fill();
          const realFrame = this.animalAtlas.frameFor(kind, now);
          let drawH: number;
          if (realFrame) {
            const factor = ANIMAL_HEIGHT_FACTOR[kind] ?? ANIMAL_DEFAULT_FACTOR;
            drawH = ts * 1.7 * factor;
            const drawW = drawH * (realFrame.naturalWidth / realFrame.naturalHeight);
            ctx.save();
            ctx.imageSmoothingEnabled = true;
            // The extracted art itself already faces left, so only the
            // rightward-moving half needs a mirror flip.
            if (!facingLeft) {
              ctx.translate(cx, 0);
              ctx.scale(-1, 1);
              ctx.translate(-cx, 0);
            }
            ctx.drawImage(realFrame, cx - drawW / 2, cy - drawH, drawW, drawH);
            ctx.restore();
          } else {
            const sprite = atlas.animal(kind, facingLeft);
            drawH = ts * (sprite.height / 16);
            const drawW = ts * (sprite.width / 16);
            ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, cx - drawW / 2, cy - drawH, drawW, drawH);
          }
          // Combat clarity (spec) — a wounded wolf/bear shows how close it
          // is to going down, same "only show damage, not full health"
          // treatment as citizens above.
          if (wounds !== undefined && wounds > 0) {
            const needed = HITS_TO_KILL[kind] ?? 1;
            const frac = Math.max(0, 1 - wounds / needed);
            const barW = ts * 0.5, barH = Math.max(2, ts * 0.06);
            const barY = cy - drawH - ts * 0.12;
            ctx.fillStyle = "rgba(10,8,5,0.65)";
            ctx.fillRect(cx - barW / 2 - 1, barY - 1, barW + 2, barH + 2);
            ctx.fillStyle = frac > 0.5 ? "#d7a13b" : "#c94636";
            ctx.fillRect(cx - barW / 2, barY, barW * frac, barH);
          }
        },
      });
    };

    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const kind = animalAt(state, x, y);
        if (!kind) continue;
        const phase = hash01(x, y, 7333) * Math.PI * 2;
        const phase2 = hash01(x, y, 7334) * Math.PI * 2;
        const wx = x + Math.sin(now / 2200 + phase) * 0.5;
        const wy = y + Math.cos(now / 2600 + phase2) * 0.32;
        const facingLeft = Math.cos(now / 2200 + phase) < 0;
        pushAnimal(kind, wx, wy, facingLeft);
      }
    }

    // Awake wolves/bears (spec: "make the bear and the wolf chase the
    // player") — real, moving entities once a leader's gotten close enough
    // to notice them (WildlifeSystem.wakeNearbyMonsters); animalAt already
    // excludes their home tile from the decorative pass above, so this
    // replaces rather than duplicates that tile's rendering.
    for (const m of state.monsters) {
      const targetCiv = m.targetCiv != null ? state.civs[m.targetCiv] : undefined;
      const targetPos = targetCiv?.leader?.pos;
      const facingLeft = targetPos ? targetPos.x < m.pos.x : m.pos.x < m.home.x;
      pushAnimal(m.kind, m.pos.x, m.pos.y, facingLeft, m.wounds);
    }

    for (const civ of state.civs) {
      const isPlayer = civ.id === myCivId;
      // Real players sharing this match are never hidden behind fog from
      // each other (bug report: "when I moved on one screen, it would not
      // show for the other" — the two civs spawn far enough apart that
      // neither had explored the other's ground yet). Fog still hides
      // AI-controlled rival civs, preserving "the mystery of who lives
      // where" for them specifically.
      const alwaysVisible = isPlayer || !civ.isAI;
      for (const b of civ.buildings) {
        if (!alwaysVisible && !explored(b.tile.x, b.tile.y)) continue;
        entities.push({
          depth: b.tile.y,
          draw: () => {
            const s = cam.worldToScreen(b.tile.x, b.tile.y);
            const def = getBuilding(b.id);
            const sprite = atlas.building(def.sprite, def.size, def.color, b.complete);
            // Anchor the sprite's base to the tile's bottom edge — taller
            // sprites rise "above" the tile, the cheap 2.5D depth cue (see
            // file header).
            const drawH = ts * (sprite.height / 16);
            const drawW = ts * (sprite.width / 16);

            // A flat ground shadow, cast on the tile footprint rather than
            // baked into the sprite (which scales with height, not
            // footprint) — the cheapest cue that a tall sprite is actually
            // standing on the tile beneath it rather than floating in front.
            ctx.fillStyle = "rgba(0,0,0,0.3)";
            ctx.beginPath();
            ctx.ellipse(s.x + ts / 2, s.y + ts * 0.9, ts * 0.4, ts * 0.14, 0, 0, Math.PI * 2);
            ctx.fill();

            ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, s.x + (ts - drawW) / 2, s.y + ts - drawH, drawW, drawH);
            ctx.strokeStyle = civ.color;
            ctx.lineWidth = 1.5;
            ctx.strokeRect(s.x + 1, s.y + ts - drawH + 1, drawW - 2, drawH - 2);
            if (!b.complete) {
              const prog = 1 - b.buildRemaining / Math.max(1, def.buildTicks);
              ctx.fillStyle = "#ffd36a";
              ctx.fillRect(s.x + 2, s.y + ts - 3, (ts - 4) * prog, 3);
            } else if (def.provides.isTownCenter) {
              const skinId = civ.wallet.equipped.BUILDINGS;
              const skinIcon = skinId ? getMarketItem(skinId)?.icon : undefined;
              const markerCanvas = (skinIcon ? emojiIconCanvas(skinIcon) : null)
                ?? pixelIconCanvas(isPlayer ? "star" : "flag");
              if (markerCanvas) {
                const size = ts * 0.4;
                ctx.drawImage(
                  markerCanvas,
                  s.x + ts / 2 - size / 2,
                  s.y + ts - drawH - ts * 0.12 - size / 2,
                  size, size,
                );
              }
            } else if (def.id === "farm") {
              this.drawFarmCrops(ctx, s.x, s.y, ts, b.tile, state.timeOfDay);
            }
          },
        });
      }

      for (const c of civ.citizens) {
        if (!alwaysVisible && !explored(c.pos.x, c.pos.y)) continue;
        entities.push({
          depth: c.pos.y,
          draw: () => {
            const s = cam.worldToScreen(c.pos.x, c.pos.y);
            const cx = s.x + ts / 2;
            const cyBase = s.y + ts; // feet line — the tile's bottom edge

            // Every leader (spec: "fix the other leaders, they are just
            // cubes and circles... make it look like my leader, but change
            // the color of their cape") uses the real extracted walk-cycle
            // art, recolored to their civ's color (see ImageSpriteAtlas);
            // regular citizens keep a stable per-citizen job look, falling
            // back to the procedural sprite until a frame set has loaded.
            // The render loop (RENDER_MS) and the sim tick loop (TICK_MS) are
            // two independent 60Hz timers, not locked together — a render can
            // land between two ticks with no position change yet, which made
            // this flicker to a false "not moving" reading most frames and
            // pop the idle stance (a weapon-ready crouch, not a mid-stride
            // pose) into the middle of what should read as a walk cycle. A
            // short grace window after the last real position delta keeps
            // the walk animation stable through those gaps.
            const now = performance.now();
            const prev = this.prevPos.get(c.id);
            const movedNow = !!prev && (Math.abs(prev.x - c.pos.x) > 0.0005 || Math.abs(prev.y - c.pos.y) > 0.0005);
            if (movedNow) this.lastMovedAt.set(c.id, now);
            this.prevPos.set(c.id, { x: c.pos.x, y: c.pos.y });
            const moving = now - (this.lastMovedAt.get(c.id) ?? -Infinity) < 150;
            // Flash the attack lunge (col 0) in the fraction of a second right
            // after a swing lands — attackCooldown is set to its max on a hit
            // (CombatSystem) and ticks down, so a high value == just swung.
            const attacking = (c.attackCiv !== undefined || c.attackWallCiv !== undefined) && c.attackCooldown > 30;
            const playerFrame = c.isLeader
              ? this.playerAtlas.frameFor(c.facing, performance.now(), moving, civ.color, attacking)
              : null;

            // Grounded contact shadow — legibility cue so a citizen reads as
            // standing on the tile rather than pasted over it.
            ctx.fillStyle = "rgba(0,0,0,0.32)";
            ctx.beginPath();
            ctx.ellipse(cx, cyBase - ts * 0.06, ts * 0.16, ts * 0.07, 0, 0, Math.PI * 2);
            ctx.fill();

            const citizenFrame = !c.isLeader
              ? this.citizenAtlas.frameFor(c.id, performance.now(), moving)
              : null;

            let drawH: number;
            if (playerFrame) {
              drawH = ts * 1.7;
              const drawW = drawH * (playerFrame.width / playerFrame.height);
              // The extracted art is painterly/anti-aliased, not authored
              // pixel art like the rest of the atlas — nearest-neighbor
              // scaling (the canvas default here) makes it look jagged and
              // "off" compared to the reference photo. Smooth just this draw.
              ctx.save();
              ctx.imageSmoothingEnabled = true;
              if (FLIP_LEFT[c.facing]) {
                ctx.translate(cx, 0);
                ctx.scale(-1, 1);
                ctx.translate(-cx, 0);
              }
              ctx.drawImage(playerFrame.el, cx - drawW / 2, cyBase - drawH, drawW, drawH);
              ctx.restore();
            } else if (citizenFrame) {
              drawH = ts * 1.35;
              const drawW = drawH * (citizenFrame.naturalWidth / citizenFrame.naturalHeight);
              // Side-view art only, and it already faces left by default —
              // mirror for the right-facing half of the compass instead of
              // needing 8 separate directions per job.
              const flip = c.facing === "right" || c.facing === "upright" || c.facing === "downright";
              ctx.save();
              ctx.imageSmoothingEnabled = true;
              if (flip) {
                ctx.translate(cx, 0);
                ctx.scale(-1, 1);
                ctx.translate(-cx, 0);
              }
              ctx.drawImage(citizenFrame, cx - drawW / 2, cyBase - drawH, drawW, drawH);
              ctx.restore();
            } else {
              const sprite = atlas.citizen(civ.color, c.isLeader, !!c.carry);
              drawH = ts * (sprite.height / 16);
              const drawW = ts * (sprite.width / 16);
              const flip = c.facing === "left";
              ctx.save();
              if (flip) {
                ctx.translate(cx, 0);
                ctx.scale(-1, 1);
                ctx.translate(-cx, 0);
              }
              ctx.drawImage(sprite, 0, 0, sprite.width, sprite.height, cx - drawW / 2, cyBase - drawH, drawW, drawH);
              ctx.restore();
            }

            const cy = cyBase - drawH / 2; // sprite's rough vertical center, for rings/icons

            // Nametag over other real players' leaders only (bug report: "the
            // name should appear above the player, but only to other
            // players") — your own leader's name already sits in the HUD's
            // leader bar, and AI rivals stay anonymous until diplomacy/scouting
            // reveals them, so this is deliberately scoped to isLeader + human
            // + not-me.
            if (c.isLeader && !isPlayer && !civ.isAI) {
              // civ.leaderName is the raw name; c.name has a "(You)" suffix
              // baked in for the owning client (Civ.spawnCitizen) which must
              // never leak into how OTHER clients see this same leader.
              const label = civ.leaderName || civ.name;
              ctx.font = "600 12px Georgia, serif";
              ctx.textAlign = "center";
              const tagY = cyBase - drawH - ts * 0.12;
              const w = ctx.measureText(label).width;
              ctx.fillStyle = "rgba(20,14,6,0.6)";
              ctx.fillRect(cx - w / 2 - 5, tagY - 12, w + 10, 16);
              ctx.fillStyle = civ.color;
              ctx.fillText(label, cx, tagY);
              ctx.textAlign = "left";
            }

            // Animal companion (spec: "the animals should follow and be visible
            // to the player") — the equipped companion pads along just behind
            // and beside the leader, bobbing, so the buff you bought is always
            // on screen. Hawk rides a little higher (it circles overhead).
            if (c.isLeader) {
              const compId = civ.wallet?.equipped?.companion;
              const comp = compId ? getCompanion(compId) : undefined;
              if (comp) {
                const icon = pixelIconCanvas(comp.icon);
                if (icon) {
                  const bob = Math.sin(now / 380 + c.id) * ts * 0.05;
                  const overhead = comp.buff === "hawk";
                  const px = cx - ts * 0.55;
                  const py = overhead ? cyBase - drawH - ts * 0.2 + bob : cyBase - ts * 0.5 + bob;
                  const cs = ts * (overhead ? 0.5 : 0.62);
                  ctx.drawImage(icon, px - cs / 2, py - cs / 2, cs, cs);
                }
              }
            }

            // Interact range ring for the player's own leader — makes "Rally"
            // (spec §5 leader interacting with citizens) legible before E.
            if (c.isLeader && isPlayer) {
              ctx.strokeStyle = "rgba(255,211,106,0.35)";
              ctx.lineWidth = 1;
              ctx.beginPath();
              ctx.arc(cx, cyBase - ts * 0.1, RALLY_RADIUS * ts, 0, Math.PI * 2);
              ctx.stroke();
            }

            // Selection ring for a citizen awaiting a manual job assignment
            // (spec §6 — click a node/building to command them).
            if (isPlayer && c.id === selectedCitizenId) {
              ctx.strokeStyle = "#7fe08a";
              ctx.lineWidth = 2;
              ctx.beginPath();
              ctx.ellipse(cx, cyBase - ts * 0.1, ts * 0.4, ts * 0.18, 0, 0, Math.PI * 2);
              ctx.stroke();
            }

            // Combat clarity (spec: "the player should clearly understand
            // who is attacking, who is defending, what target a unit is
            // attacking, whether a citizen is guarding, whether a unit is
            // attacking a wall"). A slim health bar appears only once
            // there's actual damage to show — a full-health bar over every
            // citizen at all times would just be visual noise.
            const inMeleeOrRanged = c.attackCiv !== undefined;
            const sieging = c.attackWallCiv !== undefined;
            const guarding = !inMeleeOrRanged && !sieging && (c.job === "guard" || c.job === "archer");
            if (c.health < 100 || inMeleeOrRanged || sieging) {
              const barW = ts * 0.5, barH = Math.max(2, ts * 0.06);
              const barY = cyBase - drawH - ts * 0.14;
              const frac = Math.max(0, Math.min(1, c.health / 100));
              const barColor = frac > 0.6 ? "#5fae4a" : frac > 0.3 ? "#d7a13b" : "#c94636";
              ctx.fillStyle = "rgba(10,8,5,0.65)";
              ctx.fillRect(cx - barW / 2 - 1, barY - 1, barW + 2, barH + 2);
              ctx.fillStyle = barColor;
              ctx.fillRect(cx - barW / 2, barY, barW * frac, barH);
            }
            // A small state icon above the bar: who's fighting, sieging, or
            // just standing guard, at a glance — no need to click each unit.
            const stateIcon = inMeleeOrRanged ? "sword" : sieging ? "hammer" : guarding ? "shield" : null;
            if (stateIcon) {
              const iconCanvas = pixelIconCanvas(stateIcon);
              if (iconCanvas) {
                const isz = ts * 0.24;
                const iy = cyBase - drawH - ts * 0.14 - (c.health < 100 || inMeleeOrRanged || sieging ? ts * 0.1 : 0) - isz;
                ctx.drawImage(iconCanvas, cx - isz / 2, iy, isz, isz);
              }
            }
            // A thin line from an attacker to their live target — makes
            // "what is this unit attacking" legible without clicking it.
            if (inMeleeOrRanged) {
              const targetCiv = state.civs[c.attackCiv!];
              const target = targetCiv?.citizens.find((t) => t.id === c.attackId);
              if (target) {
                const ts2 = cam.worldToScreen(target.pos.x, target.pos.y);
                ctx.strokeStyle = "rgba(201,70,54,0.55)";
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(cx, cyBase - drawH * 0.5);
                ctx.lineTo(ts2.x + ts / 2, ts2.y + ts * 0.5);
                ctx.stroke();
                ctx.setLineDash([]);
              }
            }

            // Equipped leader cosmetics — visible to every civ that can see
            // this tile, same visibility rule as the citizen itself (§23).
            if (c.isLeader) {
              const cosmeticSize = ts * 0.3;
              const crownId = civ.wallet.equipped.CROWNS;
              const crownCanvas = crownId ? emojiIconCanvas(getMarketItem(crownId)?.icon ?? "") : null;
              if (crownCanvas) {
                ctx.drawImage(
                  crownCanvas,
                  cx - cosmeticSize / 2,
                  cyBase - drawH + ts * 0.12 - cosmeticSize / 2,
                  cosmeticSize, cosmeticSize,
                );
              }
              const mountId = civ.wallet.equipped.MOUNTS;
              const mountCanvas = mountId ? emojiIconCanvas(getMarketItem(mountId)?.icon ?? "") : null;
              if (mountCanvas) {
                ctx.drawImage(
                  mountCanvas,
                  cx + ts * 0.3 - cosmeticSize / 2,
                  cy + ts * 0.3 - cosmeticSize / 2,
                  cosmeticSize, cosmeticSize,
                );
              }
            }
          },
        });
      }
    }

    entities.sort((a, b) => a.depth - b.depth);
    for (const e of entities) e.draw();

    // Combat feedback: spawn projectiles for new swings, then draw them over
    // the units so arrows/slashes read clearly (spec: visible flying weapons).
    this.spawnCombatProjectiles(state, now);
    this.drawProjectiles(now, ts);

    // Placement ghost (player only).
    if (placingId && hover) {
      const tx = Math.round(hover.x);
      const ty = Math.round(hover.y);
      const s = cam.worldToScreen(tx, ty);
      const t = state.world.tileAt(tx, ty);
      const occupied = state.civs.some((civ) =>
        civ.buildings.some((b) => b.tile.x === tx && b.tile.y === ty),
      );
      const ok = !!t?.explored && getBiome(t.biome).buildable && !occupied;
      ctx.fillStyle = ok ? "rgba(120,240,140,0.35)" : "rgba(240,90,90,0.35)";
      ctx.fillRect(s.x, s.y, ts, ts);
      ctx.strokeStyle = ok ? "#7fe08a" : "#e0533b";
      ctx.strokeRect(s.x, s.y, ts, ts);
    }

    this.drawAmbient(state, now);
    this.drawWeather(weatherFor(state.day, state.season), now);
    this.drawNight(state, now);
  }

  /** Screen-space ambient life (spec: "add more life, make the game feel
   * exciting... the game feels boring, quite, and dead"). Cheap, stateless
   * cosmetics layered over the world: motes of pollen/dust drifting by day
   * that become glowing fireflies at night, plus a few birds gliding across
   * the sky. Purely decorative — never read back into gameplay. */
  private drawAmbient(state: GameState, now: number): void {
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;
    const night = nightAlpha(state.timeOfDay) > 0.18;

    const N = 18;
    for (let i = 0; i < N; i++) {
      const seed = i * 97.13;
      const speed = 6 + (i % 5) * 4;
      const x = (((Math.sin(seed) * 0.5 + 0.5) * w + now / 1000 * speed + i * 57) % (w + 40)) - 20;
      const y = (((Math.cos(seed * 1.7) * 0.5 + 0.5) * h + Math.sin(now / 1400 + i) * 20) % (h + 40)) - 20;
      const tw = Math.sin(now / 480 + i) * 0.5 + 0.5;
      if (night) {
        ctx.fillStyle = `rgba(255,226,132,${0.12 + 0.5 * tw})`;
        const r = 1.4 + tw * 1.6;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      } else {
        ctx.fillStyle = `rgba(255,250,228,${0.05 + 0.1 * tw})`;
        ctx.fillRect(x, y, 2, 2);
      }
    }

    // Birds glide across the upper sky by day, wings flapping.
    if (!night) {
      ctx.strokeStyle = "rgba(28,22,16,0.5)";
      ctx.lineWidth = 1.5;
      for (let b = 0; b < 3; b++) {
        const speed = 24 + b * 12;
        const bx = ((now / 1000 * speed + b * 280) % (w + 80)) - 40;
        const by = h * 0.1 + b * 26 + Math.sin(now / 900 + b) * 7;
        const flap = Math.sin(now / 170 + b * 2) * 3.5;
        ctx.beginPath();
        ctx.moveTo(bx - 6, by + flap);
        ctx.lineTo(bx, by);
        ctx.lineTo(bx + 6, by + flap);
        ctx.stroke();
      }
    }
  }

  /** Watch every citizen's attackCooldown; when it jumps up (a swing just
   * landed, CombatSystem sets it to max on a hit) spawn a projectile from the
   * attacker toward its current target. Ranged jobs loose an arrow; everyone
   * else shows a melee slash. */
  private spawnCombatProjectiles(state: GameState, now: number): void {
    for (const civ of state.civs) {
      for (const c of civ.citizens) {
        const last = this.lastAtkCd.get(c.id) ?? 0;
        this.lastAtkCd.set(c.id, c.attackCooldown);
        if (c.attackCooldown <= last + 20) continue; // not a fresh swing
        let target: Vec2 | null = null;
        if (c.attackCiv !== undefined && c.attackId !== undefined) {
          const t = state.civs[c.attackCiv]?.citizens.find((x) => x.id === c.attackId);
          if (t) target = t.pos;
        } else if (c.attackWallCiv !== undefined && c.attackWallTile) {
          target = c.attackWallTile;
        }
        if (!target) continue;
        // Only show combat the player can actually see (fog rules), else arrows
        // pop out of unexplored territory — real players stay visible to each
        // other regardless, same as their citizen sprites above.
        if (civ.isAI && !state.world.tileAt(Math.round(c.pos.x), Math.round(c.pos.y))?.explored) continue;
        const ranged = c.job === "archer";
        this.projectiles.push({
          x: c.pos.x, y: c.pos.y, tx: target.x, ty: target.y,
          born: now, dur: ranged ? 260 : 150, kind: ranged ? "arrow" : "slash",
        });
        if (this.projectiles.length > 120) this.projectiles.shift();
      }
    }
  }

  private drawProjectiles(now: number, ts: number): void {
    const { ctx, cam } = this;
    this.projectiles = this.projectiles.filter((p) => now - p.born < p.dur);
    for (const p of this.projectiles) {
      const t = Math.min(1, (now - p.born) / p.dur);
      if (p.kind === "arrow") {
        // Lerp with a gentle arc; orient the shaft along travel direction.
        const wx = p.x + (p.tx - p.x) * t;
        const wy = p.y + (p.ty - p.y) * t - Math.sin(t * Math.PI) * 0.5;
        const s = cam.worldToScreen(wx, wy);
        const end = cam.worldToScreen(p.tx, p.ty);
        const px = s.x + ts / 2, py = s.y + ts / 2;
        const ang = Math.atan2(end.y - s.y, end.x - s.x);
        ctx.save();
        ctx.translate(px, py);
        ctx.rotate(ang);
        ctx.strokeStyle = "#e8d8a0";
        ctx.lineWidth = Math.max(1.5, ts * 0.03);
        ctx.beginPath();
        ctx.moveTo(-ts * 0.18, 0);
        ctx.lineTo(ts * 0.16, 0);
        ctx.stroke();
        ctx.fillStyle = "#cfc089";
        ctx.beginPath();
        ctx.moveTo(ts * 0.22, 0);
        ctx.lineTo(ts * 0.12, -ts * 0.05);
        ctx.lineTo(ts * 0.12, ts * 0.05);
        ctx.fill();
        ctx.restore();
      } else {
        // A quick bright slash arc sweeping across the target.
        const s = cam.worldToScreen(p.tx, p.ty);
        ctx.strokeStyle = `rgba(255,244,206,${(1 - t) * 0.9})`;
        ctx.lineWidth = Math.max(2, ts * 0.05);
        ctx.beginPath();
        ctx.arc(s.x + ts / 2, s.y + ts * 0.5, ts * 0.38, -1.0 + t * 1.8, -0.2 + t * 1.8);
        ctx.stroke();
      }
    }
  }

  /** Full-screen weather overlay, drawn last so it sits over the whole
   * world. Screen-space, straightforward for a top-down camera. */
  private drawWeather(weather: Weather, now: number): void {
    if (weather === "sunny") return;
    const { ctx, canvas } = this;
    const w = canvas.width, h = canvas.height;

    if (weather === "rain" || weather === "storm") {
      ctx.fillStyle = weather === "storm" ? "rgba(10,14,22,0.22)" : "rgba(20,26,36,0.12)";
      ctx.fillRect(0, 0, w, h);
      ctx.strokeStyle = weather === "storm" ? "rgba(200,215,235,0.55)" : "rgba(190,205,225,0.4)";
      ctx.lineWidth = 1;
      const speed = weather === "storm" ? 1400 : 900;
      ctx.beginPath();
      for (let i = 0; i < RAIN_PARTICLES; i++) {
        const seedX = hash01(i, 1, 8123) * w;
        const seedY = hash01(i, 2, 8123) * h;
        const y = ((seedY + (now / 1000) * speed) % (h + 40)) - 20;
        const x = (seedX + y * 0.18) % w; // slight wind slant
        ctx.moveTo(x, y);
        ctx.lineTo(x - 3, y - 12);
      }
      ctx.stroke();

      if (weather === "storm") {
        const t = now % 6500;
        if (t < 90) {
          ctx.fillStyle = `rgba(255,255,255,${0.5 * (1 - t / 90)})`;
          ctx.fillRect(0, 0, w, h);
        }
      }
      return;
    }

    // Snow: soft drifting dots, no dark screen tint (snowfall reads as
    // bright, not stormy).
    ctx.fillStyle = "rgba(20,26,36,0.05)";
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = "rgba(255,255,255,0.85)";
    for (let i = 0; i < SNOW_PARTICLES; i++) {
      const seedX = hash01(i, 1, 5051) * w;
      const seedY = hash01(i, 2, 5051) * h;
      const speed = 60 + hash01(i, 3, 5051) * 60;
      const y = ((seedY + (now / 1000) * speed) % (h + 20)) - 10;
      const x = seedX + Math.sin(now / 900 + i) * 14;
      const r = 1 + hash01(i, 4, 5051) * 1.5;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /** Actual growing crops on a farm tile (spec: "there should be actual
   * crops growing, not whatever it is right now") — a small planted grid
   * that visibly sprouts, grows and ripens to gold across each day, reset
   * for the next. Purely cosmetic, driven by state.timeOfDay (rendering-only,
   * see GameState) so every client draws the same thing with no new synced
   * state, same approach as the vegetation-sway/weather cosmetics. */
  private drawFarmCrops(
    ctx: CanvasRenderingContext2D,
    sx: number,
    sy: number,
    ts: number,
    tile: Vec2,
    timeOfDay: number,
  ): void {
    const ROWS = 3;
    const COLS = 3;
    const pad = ts * 0.14;
    const cellW = (ts - pad * 2) / COLS;
    const cellH = (ts - pad * 2) / ROWS;
    // 0 at dawn -> 1 just before the next dawn, so crops visibly grow through
    // the day and reset with a fresh planting each morning.
    const growth = timeOfDay;
    for (let row = 0; row < ROWS; row++) {
      for (let col = 0; col < COLS; col++) {
        const jitter = hash01(tile.x * 3 + col, tile.y * 3 + row, 9911);
        const cx = sx + pad + cellW * (col + 0.5);
        const cyBase = sy + pad + cellH * (row + 1) - 1;
        const stalkH = cellH * (0.25 + 0.65 * growth) * (0.85 + jitter * 0.3);
        const ripe = growth > 0.7;
        ctx.strokeStyle = ripe ? "#e8c34a" : "#5c9a3a";
        ctx.lineWidth = Math.max(1, ts * 0.045);
        ctx.beginPath();
        ctx.moveTo(cx, cyBase);
        ctx.lineTo(cx, cyBase - stalkH);
        ctx.stroke();
        if (growth > 0.4) {
          // A little seed-head once the stalk has enough height to carry one.
          ctx.fillStyle = ripe ? "#f0d060" : "#7fb24a";
          ctx.beginPath();
          ctx.ellipse(cx, cyBase - stalkH, ts * 0.045, ts * 0.07, 0, 0, Math.PI * 2);
          ctx.fill();
        }
      }
    }
  }

  /** Cosmetic day/night tint, drawn last of all so it darkens weather too —
   * a real night really would. state.timeOfDay is rendering-only (see
   * GameState); gameplay never reads it. */
  private drawNight(state: GameState, _now: number): void {
    const alpha = nightAlpha(state.timeOfDay);
    if (alpha <= 0) return;
    const { ctx, canvas } = this;
    ctx.fillStyle = `rgba(6,10,26,${alpha})`;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
}

/** Maps a resource-node data id (e.g. "jungle_tree", "iron_ore") to one of
 * SpriteAtlas.node's drawn shapes. */
function spriteKeyForNode(nodeId: string): string {
  if (nodeId.includes("tree")) return nodeId.includes("jungle") ? "palm" : "tree";
  if (nodeId.includes("rock")) return "rock";
  if (nodeId.includes("ore")) return "ore";
  if (nodeId.includes("berry")) return "berry";
  if (nodeId.includes("reeds")) return "reeds";
  if (nodeId.includes("herb")) return "herb";
  if (nodeId.includes("crystal")) return "crystal";
  if (nodeId.includes("pond")) return "pond";
  return "generic";
}
