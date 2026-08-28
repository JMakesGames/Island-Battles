import { defineConfig } from "vite";

// Founders of the Giant Isle — dev/build config.
// Kept intentionally minimal; the game is dependency-free at runtime so it
// stays portable toward a future authoritative server + WebSocket client.
export default defineConfig({
  root: ".",
  server: { port: 5190, host: true },
  build: { target: "es2022", outDir: "dist" },
});
