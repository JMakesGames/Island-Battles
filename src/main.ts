// Entry point. Shows the main menu, then boots a match into #game once the
// player picks a mode and (optionally) customizes their leader (spec §33
// first-time experience: a couple of clicks to a meaningful decision).
//
// A `?server=ws://host:port` query param pre-selects multiplayer mode and
// address — handy for sharing a direct-join link — but the menu is always
// shown first so a solo player never needs to touch a URL.
import { Game, type GameOptions } from "./game/Game.ts";
import { MainMenu } from "./ui/MainMenu.ts";

const mount = document.getElementById("game");
if (!mount) throw new Error("#game mount not found");

const presetServer = new URLSearchParams(location.search).get("server") ?? undefined;

// Only the very first boot honors a `?server=` preset link — once a match
// ends and the player is back at the menu, defaulting back into that same
// direct-join link would be surprising rather than convenient.
function startMenu(serverPreset?: string): void {
  const menu = new MainMenu(
    mount!,
    (opts: GameOptions) => {
      menu.destroy();
      const game = new Game(mount!, opts, () => {
        game.destroy();
        startMenu();
      });
      // Dev-only inspection handle; harmless in production builds.
      (window as unknown as { game: Game }).game = game;
    },
    serverPreset,
  );
}

startMenu(presetServer);
