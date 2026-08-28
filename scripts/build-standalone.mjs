// Produces a single self-contained HTML file for sharing (e.g. with friends
// who just want to double-click and play solo — no server, no install).
// Real multiplayer still needs a hosted `npm run server`; this only bundles
// the offline single-player path (the client already falls back to
// LocalTransport whenever no ?server= is chosen on the main menu).
//
// Vite's production build already bundles every import (including the JSON
// data files, via resolveJsonModule) into one JS file with no runtime
// fetches — this script just inlines that file into index.html so there's
// nothing left to load externally. The one exception is public/sprites/,
// which Vite serves as static files rather than bundling — a double-clicked
// file:// page has no server to fetch those from, so we base64-inline them
// into a window.__EMBEDDED_SPRITES__ map that ImageSpriteAtlas checks first
// (see that file's header).

import { readFileSync, writeFileSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";

const distDir = "dist";
const outFile = "island-battles.html";
const spriteSets = [
  { dir: join("public", "sprites", "player"), global: "__EMBEDDED_SPRITES__" },
  { dir: join("public", "sprites", "citizens"), global: "__EMBEDDED_CITIZEN_SPRITES__" },
  { dir: join("public", "sprites", "animals"), global: "__EMBEDDED_ANIMAL_SPRITES__" },
  { dir: join("public", "sprites", "terrain"), global: "__EMBEDDED_TERRAIN_SPRITES__" },
  { dir: join("public", "sprites", "nodes"), global: "__EMBEDDED_NODE_SPRITES__" },
];

const html = readFileSync(join(distDir, "index.html"), "utf8");
const match = html.match(/<script type="module" crossorigin src="(\/assets\/[^"]+)"><\/script>/);
if (!match) {
  console.error("Could not find the built <script type=module> tag in dist/index.html");
  process.exit(1);
}

let spriteScript = "";
let totalSprites = 0;
for (const { dir, global } of spriteSets) {
  const entries = readdirSync(dir)
    .filter((f) => f.endsWith(".png"))
    .map((f) => {
      const key = f.replace(/\.png$/, "");
      const b64 = readFileSync(join(dir, f)).toString("base64");
      return `${JSON.stringify(key)}:${JSON.stringify(`data:image/png;base64,${b64}`)}`;
    });
  totalSprites += entries.length;
  spriteScript += `<script>window.${global}={${entries.join(",")}};</script>\n`;
}

const js = readFileSync(join(distDir, match[1]), "utf8");
if (/(^|[^.\w])import\s*[({]|^\s*export\s|import\.meta/m.test(js)) {
  console.error(
    "The built bundle contains import/export/import.meta — it can't safely " +
    "run as a classic (non-module) script. Someone added a real ESM feature; " +
    "either remove it or teach this script to keep type=module (and accept " +
    "that file:// double-click won't work in Chrome/Edge, since they block " +
    "module scripts under the file: protocol).",
  );
  process.exit(1);
}
// Plain classic script, not type="module": Chrome/Edge/Firefox all refuse to
// execute <script type="module"> when the page is opened via file:// (a
// double-clicked HTML file) — module script fetches are subject to the same
// CORS rules as any other fetch, and file:// requests fail that check. Vite's
// bundle has no import/export/dynamic-import/import.meta (checked above), so
// nothing here actually needs module semantics; a classic script runs fine
// under file://, http://, and https:// alike.
//
// A plain-string replacement arg to .replace() still gets $-pattern
// substitution applied (e.g. "$&" = the matched text) — and minified JS
// reliably contains "$&" sequences, which silently corrupted the inlined
// bundle. A function replacer bypasses that substitution entirely.
//
// Placement matters too: the original tag sits in <head> (that's where Vite
// put it), relying on type="module" always deferring until after DOM
// parsing. `defer` only affects scripts with a `src` — an inline classic
// script ignores it and runs immediately, before <div id="game"> in <body>
// exists yet, throwing "#game mount not found". So instead of replacing
// in place, strip the original tag from <head> and append the real script
// block just before </body>, once the DOM it needs already exists.
const withoutOriginal = html.replace(match[0], () => "");
const bodyClose = withoutOriginal.lastIndexOf("</body>");
if (bodyClose === -1) {
  console.error("Could not find </body> in dist/index.html");
  process.exit(1);
}
const inlined =
  withoutOriginal.slice(0, bodyClose) +
  `${spriteScript}<script>\n${js}\n</script>\n` +
  withoutOriginal.slice(bodyClose);

writeFileSync(outFile, inlined, "utf8");
const kb = (statSync(outFile).size / 1024).toFixed(1);
console.log(`Wrote ${outFile} (${kb} KB, incl. ${totalSprites} embedded sprites) — solo play only, open it directly in a browser.`);
