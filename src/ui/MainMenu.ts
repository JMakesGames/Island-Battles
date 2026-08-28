// The main menu (title, play mode, settings, leader customization, past
// civilizations). DOM overlay in the same style as Hud.ts. Shown before a
// match starts; calls onPlay once with everything Game needs to boot.

import type { GameOptions } from "../game/Game.ts";
import type { Civ } from "../game/Civ.ts";
import { getOrCreatePlayerId, loadProfile, saveProfile } from "../net/profileStore.client.ts";
import { listSaves, readSaveState, deleteSave, firstFreeSlot, SAVE_SLOTS } from "../net/saveStore.client.ts";
import { rehydrateSave } from "../net/serialize.ts";
import { CIV_COLORS } from "../game/GameState.ts";
import { Bundles, MarketItems, MarketCategories, Companions,
  BattlePassTiers, BattlePassMaxLevel, BattlePassPremiumPriceLt, BattlePassSeason } from "../game/config.ts";
import { purchaseItem, purchaseBundle, equipCosmetic } from "../systems/Economy.ts";
import { purchasePremiumPass, claimBattlePassReward, xpForLevel } from "../systems/BattlePass.ts";
import { restoreBattlePass, captureBattlePass } from "../core/profile.ts";
import { EventBus } from "../core/events.ts";
import { safeUUID } from "../core/uuid.ts";
import { emojiIcon, pixelIcon } from "./PixelIcons.ts";

// Rarity tints picked to stay legible as ink on parchment (bright neons wash
// out on the aged page).
const RARITY_COLOR: Record<string, string> = {
  common: "#6b6357",
  rare: "#2f5d86",
  epic: "#6a3b86",
  legendary: "#9a6a12",
  mythic: "#8f2f5a",
};

// Colors offered to the player for solo customization, deliberately excluding
// the two AI rivals' assigned colors (CIV_COLORS[1], [2]) so a human civ never
// looks identical to an AI one on the map (spec §5 "highly visible").
const LEADER_COLORS = [CIV_COLORS[0], CIV_COLORS[3], CIV_COLORS[4], CIV_COLORS[5]];

/** Best-guess multiplayer address for the server-URL field (spec: "put it on
 * Render/GitHub" — a friend opening the deployed link shouldn't have to know
 * or type a server address). server/index.ts serves this same client build
 * alongside its WebSocket endpoint on one Render URL, so once deployed the
 * right address is just "this page's own origin" — same host, ws upgraded to
 * wss under https like the browser already requires for mixed content. Local
 * dev is the one case that's NOT same-origin (the Vite dev server and `npm
 * run server` are two separate processes on two different ports), so that
 * falls back to the historical default instead of guessing wrong. */
function guessServerUrl(): string {
  if (typeof location === "undefined" || location.protocol === "file:") return "ws://localhost:8790";
  if (location.hostname === "localhost" || location.hostname === "127.0.0.1") return "ws://localhost:8790";
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}`;
}

export class MainMenu {
  private root: HTMLElement;
  private mode: "solo" | "multiplayer";
  private color = LEADER_COLORS[0];
  /** Opt-in difficulty (spec: leader death shouldn't unfairly end a normal
   * run by default) — off unless the player explicitly asks for permadeath. */
  private hardcore = false;
  private marketOpen = false;
  private battlePassOpen = false;
  private bus = new EventBus();

  constructor(
    mount: HTMLElement,
    private onPlay: (opts: GameOptions) => void,
    private defaultServerUrl?: string,
  ) {
    this.mode = defaultServerUrl ? "multiplayer" : "solo";
    this.root = document.createElement("div");
    // A candle-lit great hall: warm amber glow fading into near-black oak,
    // so the parchment charter in the middle looks lit from within.
    this.root.style.cssText =
      "position:absolute;inset:0;display:flex;align-items:center;justify-content:center;" +
      "background:radial-gradient(ellipse 80% 70% at 50% 42%, #43301a 0%, #241708 45%, #120b04 78%, #080502 100%);" +
      "font:15px/1.5 'Iowan Old Style','Palatino Linotype','Book Antiqua',Georgia,serif;" +
      "color:var(--ink);overflow:auto;padding:20px;";
    mount.appendChild(this.root);
    this.render();
  }

  destroy(): void {
    this.root.remove();
  }

  private render(): void {
    const playerId = getOrCreatePlayerId();
    const profile = loadProfile(playerId);
    const history = profile.history.slice().reverse();

    const card = document.createElement("div");
    // The founding charter: a parchment sheet in a heavy oak frame banded
    // with gilt. Now a wide two-column spread that fills the screen (spec:
    // "should fit the entire screen and not 1/3 of it") — a hero column on
    // the left for founding a realm, a ledger column on the right for saved
    // realms, the market and the season pass. Collapses to one column on
    // narrow screens.
    card.style.cssText =
      "width:min(1120px, 96vw);color:var(--ink);border-radius:6px;padding:26px clamp(20px,4vw,48px);" +
      "background:linear-gradient(158deg,var(--parch-1) 0%,var(--parch-2) 55%,var(--parch-3) 100%);" +
      "border:5px solid var(--oak-dk);" +
      "box-shadow:inset 0 0 0 2px var(--gilt), inset 0 0 60px rgba(120,80,28,0.30)," +
      "0 22px 70px rgba(0,0,0,0.7);";

    card.innerHTML = `
      <div style="text-align:center;margin-bottom:20px">
        <div style="color:var(--gilt);letter-spacing:.5em;font-size:12px;margin-bottom:6px">${pixelIcon("fleur")} ${pixelIcon("fleur")} ${pixelIcon("fleur")}</div>
        <div style="font-size:46px;line-height:1;font-weight:800;letter-spacing:.06em;color:var(--royal);
             text-shadow:0 2px 0 rgba(255,244,210,0.55), 0 3px 6px rgba(60,20,10,0.4)">ISLAND&nbsp;BATTLES</div>
        <div style="font-size:13px;font-style:italic;color:var(--ink-soft);letter-spacing:.1em;margin-top:6px">JMakesGames Presents</div>
        <div style="height:2px;background:linear-gradient(90deg,transparent,var(--gilt),transparent);margin:12px 40px 8px"></div>
        <div style="font-size:13px;color:var(--ink-soft);font-style:italic">Raise a people. Feed them, arm them, and battle for the isle.</div>
      </div>
    `;

    // Two-column body: `leftCol` gets the founding controls, `rightCol` gets
    // realms/market/pass. `auto-fit` collapses to a single column when the
    // card is too narrow (mobile / small windows).
    const grid = document.createElement("div");
    grid.style.cssText = "display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:10px 34px;align-items:start";
    const leftCol = document.createElement("div");
    const rightCol = document.createElement("div");
    grid.append(leftCol, rightCol);
    card.appendChild(grid);

    // --- Mode select ---
    const modeRow = document.createElement("div");
    modeRow.style.cssText = "display:flex;gap:8px;margin-bottom:14px";
    const soloBtn = this.modeButton(`${pixelIcon("island")} Solo (Offline)`, "solo");
    const mpBtn = this.modeButton(`${pixelIcon("globe")} Multiplayer`, "multiplayer");
    modeRow.append(soloBtn, mpBtn);
    leftCol.appendChild(modeRow);

    // --- Server URL (multiplayer only) ---
    const serverWrap = document.createElement("div");
    serverWrap.style.cssText = "display:none;margin-bottom:14px";
    const serverLabel = document.createElement("div");
    serverLabel.style.cssText = "font-size:12px;color:var(--ink-soft);margin-bottom:4px";
    serverLabel.textContent = "Server address (ask your host, or run `npm run server`):";
    const serverInput = document.createElement("input");
    serverInput.type = "text";
    serverInput.value = this.defaultServerUrl ?? guessServerUrl();
    serverInput.style.cssText = this.inputStyle();
    serverWrap.append(serverLabel, serverInput);
    leftCol.appendChild(serverWrap);

    // --- Leader name ---
    const nameWrap = document.createElement("div");
    nameWrap.style.cssText = "margin-bottom:14px";
    const nameLabel = document.createElement("div");
    nameLabel.style.cssText = "font-size:12px;color:var(--ink-soft);margin-bottom:4px";
    nameLabel.textContent = "Name your ruler (or leave blank and fate will name them):";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.maxLength = 24;
    nameInput.placeholder = "e.g. Aldric the Bold";
    nameInput.style.cssText = this.inputStyle();
    nameWrap.append(nameLabel, nameInput);
    leftCol.appendChild(nameWrap);

    // --- Leader color (solo only) ---
    const colorWrap = document.createElement("div");
    colorWrap.style.cssText = "margin-bottom:18px";
    const colorLabel = document.createElement("div");
    colorLabel.style.cssText = "font-size:12px;color:var(--ink-soft);margin-bottom:6px";
    colorLabel.textContent = "Your banner (solo only — multiplayer assigns each player a colour):";
    const swatchRow = document.createElement("div");
    swatchRow.style.cssText = "display:flex;gap:10px";
    for (const c of LEADER_COLORS) {
      const sw = document.createElement("button");
      // Heraldic shield swatches ringed in oak, the chosen one crowned in gilt.
      sw.style.cssText =
        `width:36px;height:40px;border-radius:6px 6px 10px 10px;cursor:pointer;background:${c};` +
        `border:3px solid ${c === this.color ? "var(--gilt-lt)" : "var(--oak-dk)"};` +
        "box-shadow:inset 0 2px 4px rgba(255,255,255,0.3), inset 0 -3px 6px rgba(0,0,0,0.4);";
      sw.onclick = () => {
        this.color = c;
        swatchRow.querySelectorAll("button").forEach((b) => (b.style.borderColor = "var(--oak-dk)"));
        sw.style.borderColor = "var(--gilt-lt)";
      };
      swatchRow.appendChild(sw);
    }
    colorWrap.append(colorLabel, swatchRow);
    leftCol.appendChild(colorWrap);

    // --- Hardcore mode (solo only) — off by default (spec: losing your
    // leader to a random wolf or a lost skirmish shouldn't unfairly end a
    // normal run; a surviving citizen steps up instead — see
    // LeaderSystem.promoteNewLeader). Opting in restores the original
    // permadeath-and-defect behavior for players who want the harder run. ---
    const hardcoreWrap = document.createElement("label");
    hardcoreWrap.style.cssText =
      "display:flex;align-items:center;gap:8px;margin-bottom:18px;cursor:pointer;font-size:12px;color:var(--ink-soft);";
    const hardcoreBox = document.createElement("input");
    hardcoreBox.type = "checkbox";
    hardcoreBox.checked = this.hardcore;
    hardcoreBox.style.cssText = "width:16px;height:16px;cursor:pointer;accent-color:var(--gilt);";
    hardcoreBox.onchange = () => { this.hardcore = hardcoreBox.checked; };
    const hardcoreText = document.createElement("span");
    hardcoreText.innerHTML =
      "<b style=\"color:var(--royal)\">Hardcore mode</b> — if your leader falls, your realm ends " +
      "for good instead of a survivor stepping up to lead.";
    hardcoreWrap.append(hardcoreBox, hardcoreText);
    leftCol.appendChild(hardcoreWrap);

    // --- Legacy Market (spec §22/§26 no-pay-to-win: cosmetics only, and
    // only reachable here — never mid-match — so LT spending is always a
    // between-games decision, not something that can interrupt play). ---
    const marketBtn = document.createElement("button");
    marketBtn.innerHTML = `${pixelIcon("shop")} Legacy Market — ${pixelIcon("coin")} ${profile.wallet.lt} LT`;
    marketBtn.style.cssText = this.wideWoodStyle();
    const marketPanel = document.createElement("div");
    marketPanel.style.cssText =
      `display:${this.marketOpen ? "block" : "none"};margin-bottom:18px;max-height:280px;overflow:auto;`;
    marketBtn.onclick = () => {
      this.marketOpen = !this.marketOpen;
      this.render();
    };
    rightCol.append(marketBtn, marketPanel);
    if (this.marketOpen) this.renderMarket(marketPanel, profile);

    // --- Battle Pass (spec §25) — moved here from the in-match HUD: it
    // spends the same Legacy Tokens as the market, so it gets the same
    // no-spending-mid-match treatment. XP still accrues from real gameplay
    // during a match (see Civ.battlePassXp/LeaderSystem/SurvivalSystem etc.);
    // only purchasing premium and claiming rewards happens here. ---
    const bpBtn = document.createElement("button");
    bpBtn.innerHTML = `${pixelIcon("ticket")} Season Pass — Lv ${profile.battlePass.level}/${BattlePassMaxLevel}`;
    bpBtn.style.cssText = this.wideWoodStyle();
    const bpPanel = document.createElement("div");
    bpPanel.style.cssText =
      `display:${this.battlePassOpen ? "block" : "none"};margin-bottom:18px;max-height:320px;overflow:auto;`;
    bpBtn.onclick = () => {
      this.battlePassOpen = !this.battlePassOpen;
      this.render();
    };
    rightCol.append(bpBtn, bpPanel);
    if (this.battlePassOpen) this.renderBattlePass(bpPanel, profile);

    // --- Play button ---
    const playBtn = document.createElement("button");
    playBtn.innerHTML = `${pixelIcon("sword")}  Found Your Realm`;
    // The royal seal: gilt on gilt with a deep-red rim, the one button the
    // eye should fall on.
    playBtn.style.cssText =
      "width:100%;padding:14px;border-radius:5px;cursor:pointer;font:inherit;font-weight:800;" +
      "font-size:18px;letter-spacing:.05em;margin:4px 0 8px;color:#3a1608;" +
      "border:3px solid var(--royal);" +
      "background:linear-gradient(180deg,var(--gilt-lt) 0%,var(--gilt) 60%,#8a6216 100%);" +
      "text-shadow:0 1px 0 rgba(255,245,210,0.6);" +
      "box-shadow:inset 0 1px 0 rgba(255,245,205,0.6),inset 0 -3px 6px rgba(90,50,10,0.45),0 4px 10px rgba(0,0,0,0.5);";
    // In solo, a new realm takes the first free save slot (spec: up to 3
    // revisitable worlds). When all three are full the big button is disabled
    // and the player is pointed at the slots below to continue or delete one.
    const free = firstFreeSlot();
    const slotsFull = this.mode === "solo" && free < 0;
    if (slotsFull) {
      playBtn.disabled = true;
      playBtn.style.opacity = "0.5";
      playBtn.style.cursor = "not-allowed";
    }
    playBtn.onclick = () => {
      if (slotsFull) return;
      const leaderName = nameInput.value.trim() || undefined;
      this.onPlay(
        this.mode === "multiplayer"
          ? { serverUrl: serverInput.value.trim(), leaderName }
          : { leaderName, civColor: this.color, hardcoreLeaderDeath: this.hardcore, saveSlot: free >= 0 ? free : undefined },
      );
    };
    leftCol.appendChild(playBtn);

    const hint = document.createElement("div");
    hint.style.cssText = "font-size:11px;color:var(--ink-soft);text-align:center;margin-bottom:18px;font-style:italic";
    hint.textContent = slotsFull
      ? "All 3 realms are in use — continue one below, or delete it to found a new realm."
      : "Click to found your Camp · WASD or click to march · E to act · T to eat";
    leftCol.appendChild(hint);

    // --- Your Realms: 3 revisitable save slots (spec: "past saved file world
    // that the player can revisit and continue... only 3 worlds"). ---
    const slotsHead = document.createElement("div");
    slotsHead.style.cssText =
      "font-weight:700;color:var(--royal);letter-spacing:.05em;text-transform:uppercase;font-size:13px;" +
      "border-bottom:2px solid var(--gilt);padding-bottom:3px;margin-bottom:8px";
    slotsHead.innerHTML = `${pixelIcon("fleur")} Your Realms`;
    rightCol.appendChild(slotsHead);
    const saves = listSaves();
    for (let i = 0; i < SAVE_SLOTS; i++) {
      const meta = saves[i];
      const rowEl = document.createElement("div");
      rowEl.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;gap:8px;" +
        "padding:8px 10px;margin-bottom:6px;border:2px solid var(--oak-dk);border-radius:4px;" +
        "background:rgba(90,60,25,0.12)";
      if (meta) {
        const when = new Date(meta.savedAt).toLocaleDateString();
        rowEl.innerHTML =
          `<div><div style="font-weight:700;color:var(--ink)">${pixelIcon("crown")} ${meta.name}</div>` +
          `<div style="font-size:11px;color:var(--ink-soft)">Day ${meta.day} · ${meta.season} · saved ${when}</div></div>`;
        const btnWrap = document.createElement("div");
        btnWrap.style.cssText = "display:flex;gap:6px";
        const cont = document.createElement("button");
        cont.textContent = "Continue";
        cont.style.cssText = this.woodStyle("width:auto;padding:7px 12px;margin:0;background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));color:#2c1e0d;border-color:#5a3e12");
        cont.onclick = () => {
          const raw = readSaveState(i);
          if (!raw) return;
          try {
            const state = rehydrateSave(JSON.parse(raw));
            this.onPlay({ restoreState: state as unknown as GameOptions["restoreState"], saveSlot: i });
          } catch {
            // corrupt save — leave the slot; deleting is the escape hatch
          }
        };
        const del = document.createElement("button");
        del.textContent = "Delete";
        del.style.cssText = this.woodStyle("width:auto;padding:7px 12px;margin:0;background:linear-gradient(180deg,var(--royal-lt),var(--royal));border-color:#3a0f0a");
        del.onclick = () => { deleteSave(i); this.render(); };
        btnWrap.append(cont, del);
        rowEl.appendChild(btnWrap);
      } else {
        rowEl.innerHTML =
          `<div style="color:var(--ink-soft);font-style:italic">${pixelIcon("scroll")} Empty realm — found a new one above</div>`;
      }
      rightCol.appendChild(rowEl);
    }

    // --- Fallen Realms (spec §15 Chronicles) — flavor history of dead civs. ---
    if (history.length > 0) {
      const histHead = document.createElement("div");
      histHead.style.cssText =
        "font-weight:700;color:var(--royal);letter-spacing:.05em;text-transform:uppercase;font-size:13px;" +
        "border-bottom:2px solid var(--gilt);padding-bottom:3px;margin:14px 0 8px";
      histHead.innerHTML = `${pixelIcon("skull")} Fallen Realms`;
      rightCol.appendChild(histHead);
      const histList = document.createElement("div");
      histList.style.cssText = "max-height:140px;overflow:auto;font-size:12px";
      histList.innerHTML = history
        .slice()
        .reverse()
        .map(
          (h) =>
            `<div style="padding:6px 0;border-bottom:1px solid rgba(90,60,25,0.3)">` +
            `<b style="color:var(--ink)">${h.civName}</b> — ${h.daysSurvived}d, peak ${pixelIcon("person")}${h.peakPopulation}` +
            `<div style="color:var(--ink-soft)">${pixelIcon("sword")} ${h.warsDeclared} wars · ${pixelIcon("handshake")} ${h.alliancesFormed} alliances · ${new Date(h.endedAt).toLocaleDateString()}</div>` +
            `</div>`,
        )
        .join("");
      rightCol.appendChild(histList);
    }

    this.root.innerHTML = "";
    this.root.appendChild(card);

    // Wire mode toggle visibility now that elements exist in the DOM.
    const applyMode = () => {
      serverWrap.style.display = this.mode === "multiplayer" ? "block" : "none";
      colorWrap.style.display = this.mode === "multiplayer" ? "none" : "block";
    };
    soloBtn.onclick = () => {
      this.mode = "solo";
      this.refreshModeButtons(soloBtn, mpBtn);
      applyMode();
    };
    mpBtn.onclick = () => {
      this.mode = "multiplayer";
      this.refreshModeButtons(soloBtn, mpBtn);
      applyMode();
    };
    applyMode();
  }

  /** Same catalog/pricing as the old in-match panel, but mutating the
   * persisted profile's wallet directly (via the same server-authoritative
   * Economy functions, just with no live match/Simulation to route through —
   * there's nothing to cheat here since it's the player's own save file). */
  private renderMarket(panel: HTMLElement, profile: ReturnType<typeof loadProfile>): void {
    const civ = { wallet: profile.wallet } as unknown as Civ;
    const owned = (id: string) => civ.wallet.inventory.includes(id);
    const refresh = () => {
      saveProfile(profile);
      this.render();
    };

    panel.innerHTML = "";

    // --- Animal companions (spec: "every item in the LT shop is an animal
    // with a buff... the animals should follow and be visible"). Buy with
    // EARNED Legacy Tokens; equip one at a time via the "companion" slot. ---
    const compHead = document.createElement("div");
    compHead.style.cssText = this.marketSectionStyle();
    compHead.textContent = "Companions";
    panel.appendChild(compHead);
    for (const comp of Companions) {
      const isOwned = owned(comp.id);
      const isActive = civ.wallet.equipped.companion === comp.id;
      const row = document.createElement("div");
      row.style.cssText =
        "display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(90,60,25,0.3);gap:8px;";
      row.innerHTML =
        `<div style="flex:1"><div style="font-weight:700;color:var(--ink)">${pixelIcon(comp.icon)} ${comp.name}</div>` +
        `<div style="font-size:11px;color:var(--ink-soft)">${comp.desc}</div></div>`;
      let btn: HTMLButtonElement;
      if (isOwned) {
        btn = this.marketButton(true, true, isActive ? `Active ${pixelIcon("check")}` : "Summon", () => {
          // Toggle the active companion (empty string = dismiss).
          civ.wallet.equipped.companion = isActive ? "" : comp.id;
          refresh();
        });
      } else {
        btn = this.marketButton(false, civ.wallet.lt >= comp.price, `${comp.price} LT`, () => {
          if (civ.wallet.lt < comp.price) return;
          civ.wallet.lt -= comp.price;
          civ.wallet.inventory.push(comp.id);
          civ.wallet.equipped.companion = comp.id; // auto-summon a fresh purchase
          refresh();
        });
      }
      row.appendChild(btn);
      panel.appendChild(row);
    }

    if (Bundles.length) {
      const head = document.createElement("div");
      head.style.cssText = this.marketSectionStyle();
      head.textContent = "Bundles";
      panel.appendChild(head);
      for (const bundle of Bundles) {
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(90,60,25,0.3);gap:8px;";
        row.innerHTML =
          `<div><div style="font-weight:700;color:var(--ink)">${bundle.name}</div>` +
          `<div style="font-size:11px;color:var(--ink-soft)">${bundle.contents.length} items</div></div>`;
        row.appendChild(
          this.marketButton(owned(bundle.id), civ.wallet.lt >= bundle.lt, `${bundle.lt} LT`, () => {
            purchaseBundle(civ, bundle.id, safeUUID(), this.bus);
            refresh();
          }),
        );
        panel.appendChild(row);
      }
    }

    for (const category of MarketCategories) {
      const items = MarketItems.filter((i) => i.category === category);
      if (!items.length) continue;
      const head = document.createElement("div");
      head.style.cssText = this.marketSectionStyle();
      head.textContent = category.replace(/_/g, " ");
      panel.appendChild(head);
      for (const item of items) {
        const isOwned = owned(item.id);
        const row = document.createElement("div");
        row.style.cssText =
          "display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid rgba(90,60,25,0.3);gap:8px;";
        row.innerHTML =
          `<div><div style="font-weight:700;color:var(--ink)">${emojiIcon(item.icon ?? "")} ${item.name}</div>` +
          `<div style="font-size:11px;font-weight:600;color:${RARITY_COLOR[item.rarity]}">${item.rarity}</div></div>`;
        const btn = isOwned
          ? this.marketButton(true, true, civ.wallet.equipped[item.category] === item.id ? `Equipped ${pixelIcon("check")}` : "Equip", () => {
              equipCosmetic(civ, item.id, this.bus);
              refresh();
            })
          : this.marketButton(false, civ.wallet.lt >= item.lt, `${item.lt} LT`, () => {
              purchaseItem(civ, item.id, safeUUID(), this.bus);
              refresh();
            });
        row.appendChild(btn);
        panel.appendChild(row);
      }
    }

    // NOTE: the old "Coffers of Gold" block (buy LT for USD) was removed —
    // spec: "remove it so the player must earn their LT". Legacy Tokens now
    // come only from gameplay (battle-pass progress, in-game tasks, match
    // rewards), so cosmetics above are a pure earn-and-spend sink.
    const earnNote = document.createElement("div");
    earnNote.style.cssText = "font-size:11px;color:var(--ink-soft);margin-top:8px;font-style:italic;text-align:center";
    earnNote.innerHTML = `${pixelIcon("coin")} Legacy Tokens are earned through play — complete tasks and matches to grow your coffers.`;
    panel.appendChild(earnNote);
  }

  /** Free + premium tracks side by side at each milestone level, same as the
   * old in-match panel — just operating on the persisted profile via a
   * synthetic Civ-shaped object (restoreBattlePass/captureBattlePass bridge
   * the flat profile fields the BattlePass.ts functions expect to mutate). */
  private renderBattlePass(panel: HTMLElement, profile: ReturnType<typeof loadProfile>): void {
    const civ = { wallet: profile.wallet, isAI: false } as unknown as Civ;
    restoreBattlePass(civ, profile);
    const refresh = () => {
      captureBattlePass(civ, profile);
      saveProfile(profile);
      this.render();
    };

    const need = xpForLevel(civ.battlePassLevel);
    const pct = civ.battlePassLevel >= BattlePassMaxLevel ? 100 : Math.round((civ.battlePassXp / need) * 100);
    panel.innerHTML =
      `<div style="font-weight:700;color:var(--royal);text-transform:uppercase;letter-spacing:.05em;` +
      `border-bottom:1px solid var(--gilt);padding-bottom:2px;margin-bottom:4px">${pixelIcon("ticket")} ${BattlePassSeason.name}</div>` +
      `<div style="font-size:11px;color:var(--ink-soft);margin-bottom:6px">Level ${civ.battlePassLevel}/${BattlePassMaxLevel}` +
      (civ.battlePassPremium ? ` · <span style="color:var(--gilt);font-weight:700">Premium</span>` : "") + `</div>` +
      `<div style="height:8px;border-radius:2px;background:rgba(60,40,18,0.35);border:1px solid var(--oak-dk);margin-bottom:10px">` +
      `<div style="height:100%;border-radius:1px;width:${pct}%;background:linear-gradient(90deg,var(--gilt),var(--gilt-lt))"></div></div>`;

    if (!civ.battlePassPremium) {
      const buyBtn = document.createElement("button");
      buyBtn.innerHTML =
        `<div style="font-weight:700">Unlock Premium Pass</div>` +
        `<div style="font-size:11px;opacity:.85">${BattlePassPremiumPriceLt} LT</div>`;
      buyBtn.disabled = civ.wallet.lt < BattlePassPremiumPriceLt;
      buyBtn.style.cssText = this.woodStyle(
        "width:100%;padding:8px;margin-bottom:10px;text-align:center;" +
        "background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));color:#3a1608;border-color:var(--royal);",
      );
      buyBtn.onclick = () => {
        purchasePremiumPass(civ, safeUUID(), this.bus);
        refresh();
      };
      panel.appendChild(buyBtn);
    }

    for (const tier of BattlePassTiers) {
      const row = document.createElement("div");
      row.style.cssText = "margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid rgba(90,60,25,0.3)";
      const label = document.createElement("div");
      label.style.cssText = "font-weight:700;font-size:12px;margin-bottom:4px;color:var(--ink)";
      label.textContent = `Level ${tier.level}`;
      row.appendChild(label);
      const tracks = document.createElement("div");
      tracks.style.cssText = "display:flex;gap:6px";
      tracks.appendChild(this.battlePassRewardCell(civ, tier.level, "free", tier.free, refresh));
      tracks.appendChild(this.battlePassRewardCell(civ, tier.level, "premium", tier.premium, refresh));
      row.appendChild(tracks);
      panel.appendChild(row);
    }
  }

  private battlePassRewardCell(
    civ: Civ,
    level: number,
    track: "free" | "premium",
    reward: { type: string; id?: string; amount?: number },
    refresh: () => void,
  ): HTMLElement {
    const claimed = civ.battlePassClaimed.includes(`${level}:${track}`);
    const reached = civ.battlePassLevel >= level;
    const eligible = reached && (track === "free" || civ.battlePassPremium);

    const cell = document.createElement("div");
    cell.style.cssText = "flex:1;padding:6px 7px;border-radius:3px;background:rgba(120,80,28,0.10);border:1px solid rgba(90,60,25,0.35);";
    const rewardLabel =
      reward.type === "lt" ? `${pixelIcon("coin")} ${reward.amount} LT` : (reward.id ?? reward.type).replace(/_/g, " ");
    cell.innerHTML =
      `<div style="font-size:10px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.05em">${track}</div>` +
      `<div style="font-size:11px;margin-bottom:4px;color:var(--ink)">${rewardLabel}</div>`;
    const btn = document.createElement("button");
    btn.innerHTML = claimed ? `Claimed ${pixelIcon("check")}` : "Claim";
    btn.disabled = claimed || !eligible;
    btn.title = !reached ? "Level not reached yet" : track === "premium" && !civ.battlePassPremium ? "Needs premium pass" : "";
    btn.style.cssText = claimed
      ? this.woodStyle("width:100%;font-size:11px;padding:3px 6px;background:linear-gradient(180deg,#5a7a3e,#3f5a28);border-color:#243a15;color:#eef6dc;")
      : this.woodStyle("width:100%;font-size:11px;padding:3px 6px;");
    if (!claimed && eligible) {
      btn.onclick = () => {
        claimBattlePassReward(civ, level, track, this.bus);
        refresh();
      };
    }
    cell.appendChild(btn);
    return cell;
  }

  /** A carved-oak tablet (matches the in-game HUD buttons). */
  private woodStyle(extra = ""): string {
    return (
      "cursor:pointer;font:inherit;font-weight:600;color:#f3e6c4;border-radius:3px;" +
      "border:2px solid var(--oak-dk);text-shadow:0 1px 1px rgba(0,0,0,0.5);" +
      "background:linear-gradient(180deg,var(--oak-lt) 0%,var(--oak) 55%,var(--oak-dk) 100%);" +
      "box-shadow:inset 0 1px 0 rgba(255,225,165,0.35),inset 0 -3px 5px rgba(0,0,0,0.4),0 2px 3px rgba(0,0,0,0.45);" +
      extra
    );
  }

  /** Full-width wood toggle used for the Market / Season Pass headers. */
  private wideWoodStyle(): string {
    return this.woodStyle("width:100%;padding:11px;font-size:14px;margin-bottom:14px;");
  }

  /** A rubricated section heading inside a parchment panel. */
  private marketSectionStyle(): string {
    return (
      "font-weight:700;color:var(--royal);text-transform:uppercase;letter-spacing:.05em;font-size:12px;" +
      "margin:12px 0 4px;border-bottom:1px solid var(--gilt);padding-bottom:2px;text-transform:capitalize;"
    );
  }

  private marketButton(owned: boolean, affordable: boolean, label: string, onBuy: () => void): HTMLButtonElement {
    const b = document.createElement("button");
    b.innerHTML = label;
    b.disabled = !owned && !affordable;
    b.style.cssText = owned
      ? this.woodStyle("font-size:12px;padding:5px 11px;min-width:72px;background:linear-gradient(180deg,#5a7a3e,#3f5a28);border-color:#243a15;color:#eef6dc;")
      : this.woodStyle("font-size:12px;padding:5px 11px;min-width:72px;");
    if (owned || affordable) b.onclick = onBuy;
    return b;
  }

  private modeButton(label: string, mode: "solo" | "multiplayer"): HTMLButtonElement {
    const b = document.createElement("button");
    b.innerHTML = label;
    b.dataset.mode = mode;
    b.style.cssText = this.modeButtonStyle(mode === this.mode);
    return b;
  }

  private refreshModeButtons(soloBtn: HTMLButtonElement, mpBtn: HTMLButtonElement): void {
    soloBtn.style.cssText = this.modeButtonStyle(this.mode === "solo");
    mpBtn.style.cssText = this.modeButtonStyle(this.mode === "multiplayer");
  }

  /** The active mode reads as a gilt-embossed tablet; the other as plain oak. */
  private modeButtonStyle(active: boolean): string {
    return active
      ? "flex:1;padding:11px;cursor:pointer;font:inherit;font-weight:700;border-radius:3px;color:#3a1608;" +
        "border:2px solid var(--royal);text-shadow:0 1px 0 rgba(255,245,205,0.5);" +
        "background:linear-gradient(180deg,var(--gilt-lt),var(--gilt));" +
        "box-shadow:inset 0 1px 0 rgba(255,245,205,0.6),inset 0 -3px 6px rgba(90,50,10,0.4);"
      : this.woodStyle("flex:1;padding:11px;");
  }

  /** An inked line on a slightly recessed slip of parchment. */
  private inputStyle(): string {
    return (
      "width:100%;padding:9px 11px;border-radius:3px;font:inherit;box-sizing:border-box;color:var(--ink);" +
      "border:2px solid var(--oak-dk);background:rgba(255,248,225,0.65);" +
      "box-shadow:inset 0 2px 4px rgba(90,60,25,0.3);outline:none;"
    );
  }
}
