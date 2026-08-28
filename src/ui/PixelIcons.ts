// Hand-drawn pixel-art icons standing in for the OS's smooth, full-color
// emoji glyphs (spec: "change the emojis to look like pixel emojis...
// everything must be pixels"). Every icon is a tiny bitmap — a grid of
// characters, one per pixel, keyed into a small per-icon palette — rendered
// once onto an offscreen canvas and cached as a data-URI <img>. Nearest-
// neighbor scaling (image-rendering:pixelated) keeps the blocky look at any
// display size, matching the rest of the game's pixel-art rendering.
//
// `emojiIcon()` is the one entry point most call sites use: pass whatever
// emoji character the UI used to show (or JSON data supplied, e.g. a
// resource's `icon` field) and get back the matching pixel icon's <img> HTML
// — falling back to the raw emoji itself for anything not yet in EMOJI_MAP,
// so an unmapped symbol degrades gracefully instead of vanishing.

type IconDef = { size: number; palette: Record<string, string>; rows: string[] };

const T = "."; // transparent

const ICONS: Record<string, IconDef> = {
  heart: {
    size: 10,
    palette: { R: "#8f2418", r: "#c94636", h: "#e0857a" },
    rows: [
      "..........",
      ".RR..RR...",
      "RrrRRrrR..",
      "RrrrrrrR..",
      "RrrrrrrR..",
      ".RrrrrR...",
      "..RrrR....",
      "...Rr.....",
      "....R.....",
      "..........",
    ],
  },
  meat: {
    size: 10,
    palette: { B: "#6b4a28", M: "#c9694a", m: "#e69577", W: "#f4ead8" },
    rows: [
      "...MMM....",
      "..MmmmM...",
      ".MmmmmmM..",
      ".MmmmmmM..",
      "..MmmmM.B.",
      "...MMM.BB.",
      "......BBB.",
      ".....BB...",
      "....BB....",
      "..........",
    ],
  },
  person: {
    size: 10,
    palette: { K: "#2c1e0d", S: "#d9a066", C: "#5a3b1e" },
    rows: [
      "...SSS....",
      "..SSSSS...",
      "..SSSSS...",
      "...SSS....",
      "..CCCCC...",
      ".CCCCCCC..",
      ".CCCCCCC..",
      ".CCCCCCC..",
      "..CC.CC...",
      "..CC.CC...",
    ],
  },
  smile: {
    size: 10,
    palette: { Y: "#c98a1c", K: "#2c1e0d" },
    rows: [
      "..YYYYYY..",
      ".YYYYYYYY.",
      "YYYKYYKYYY",
      "YYYYYYYYYY",
      "YKYYYYYYKY",
      "YYKYYYYKYY",
      "YYYKKKKYYY",
      ".YYYYYYYY.",
      "..YYYYYY..",
      "..........",
    ],
  },
  box: {
    size: 10,
    palette: { B: "#7c5227", b: "#a9781f", K: "#3a260f" },
    rows: [
      "..........",
      ".BBBBBBBB.",
      ".BbbbbbbB.",
      ".BbKKKKbB.",
      ".BbKbbKbB.",
      ".BbKbbKbB.",
      ".BbKKKKbB.",
      ".BbbbbbbB.",
      ".BBBBBBBB.",
      "..........",
    ],
  },
  coin: {
    size: 10,
    palette: { g: "#a9781f", G: "#d8b24c", k: "#5a3e12" },
    rows: [
      "..GGGGGG..",
      ".GGGGGGGG.",
      "GGGgggGGGG",
      "GGgGGGgGGG",
      "GGgGkkGgGG",
      "GGgGGGgGGG",
      "GGGgggGGGG",
      ".GGGGGGGG.",
      "..GGGGGG..",
      "..........",
    ],
  },
  wood: {
    size: 10,
    palette: { B: "#5a3b1e", b: "#8a5a2b", r: "#c7935a" },
    rows: [
      "..........",
      ".BBBBBBBB.",
      ".BrrrrrrB.",
      ".BrbbbbrB.",
      ".BrbrrbrB.",
      ".BrbbbbrB.",
      ".BrrrrrrB.",
      ".BBBBBBBB.",
      "..........",
      "..........",
    ],
  },
  stone: {
    size: 10,
    palette: { g: "#5a5a52", G: "#9aa0a6", w: "#c7ccd1" },
    rows: [
      "..........",
      "...GGGG...",
      "..GwwwGG..",
      ".GwwGGgG..",
      ".GGGgggG..",
      ".GgggGGG..",
      "..GGGGg...",
      "...gggg...",
      "..........",
      "..........",
    ],
  },
  water: {
    size: 10,
    palette: { B: "#2b6ea8", b: "#3ba3e0", w: "#a9d8f2" },
    rows: [
      "....b.....",
      "...bwb....",
      "..bBBBb...",
      ".bBbbbBb..",
      ".bBbwwbBb.",
      "bBbwwwwbBb",
      "bBbbbbbbBb",
      ".bBBBBBb..",
      "..bbbbb...",
      "..........",
    ],
  },
  wheat: {
    size: 10,
    palette: { B: "#7c5f1a", Y: "#c7b36a", y: "#e6d597" },
    rows: [
      "....B.....",
      "...YbY....",
      "..YyByY...",
      "....B.....",
      "...YbY....",
      "..YyByY...",
      "....B.....",
      "...YbY....",
      "....B.....",
      "....B.....",
    ],
  },
  fleur: {
    size: 10,
    palette: { g: "#a9781f", G: "#d8b24c" },
    rows: [
      "...GG.....",
      "..GggG....",
      "..GggG.GG.",
      "GgGGgGGggG",
      "GGGGgGGGGG",
      ".GGGgGGG..",
      "...GgG....",
      "..GGgGG...",
      "..GGGGG...",
      "..........",
    ],
  },
  speakerOn: {
    size: 10,
    palette: { B: "#5a3b1e", W: "#eef0f2" },
    rows: [
      "..B.......",
      ".BB..W....",
      "BBBB.W.W..",
      "BBBB.W.W..",
      "BBBB.W.W..",
      "BBBB.W.W..",
      "BBBB.W.W..",
      ".BB..W....",
      "..B.......",
      "..........",
    ],
  },
  speakerOff: {
    size: 10,
    palette: { B: "#5a3b1e", R: "#8f2418" },
    rows: [
      "..B.......",
      ".BB.......",
      "BBBB....R.",
      "BBBB...RR.",
      "BBBB..R.R.",
      "BBBB...RR.",
      "BBBB....R.",
      ".BB.......",
      "..B.......",
      "..........",
    ],
  },
  dagger: {
    size: 10,
    palette: { S: "#c7ccd1", s: "#eef0f2", B: "#5a3b1e" },
    rows: [
      "....Ss....",
      "...Ss.....",
      "..Ss......",
      ".Ss.......",
      "Ss........",
      "B.........",
      "..........",
      "..........",
      "..........",
      "..........",
    ],
  },
  bow: {
    size: 10,
    palette: { B: "#5a3b1e", S: "#c7ccd1" },
    rows: [
      "..B.......",
      ".B.S......",
      "B..S......",
      "B...S.....",
      "B....S....",
      "B....S....",
      "B...S.....",
      "B..S......",
      ".B.S......",
      "..B.......",
    ],
  },
  sword: {
    size: 10,
    palette: { S: "#c7ccd1", s: "#eef0f2", B: "#5a3b1e", G: "#a9781f" },
    rows: [
      ".......Ss.",
      "......Ss..",
      ".....Ss...",
      "....Ss....",
      "...Ss.....",
      "..Ss......",
      ".GGB......",
      "GBgB......",
      ".BgB......",
      "..B......."
    ],
  },
  swords: {
    size: 10,
    palette: { S: "#c7ccd1", s: "#eef0f2", B: "#5a3b1e" },
    rows: [
      "S.......s.",
      ".S.....s..",
      "..S...s...",
      "...S.s....",
      "....X.....",
      "...s.S....",
      "..s...S...",
      ".s.....S..",
      "B.......B.",
      "..........",
    ],
  },
  scroll: {
    size: 10,
    palette: { P: "#e6d9b0", p: "#c7b382", g: "#a9781f" },
    rows: [
      "..........",
      ".gPPPPPPg.",
      ".PppppppP.",
      ".PpPPPPpP.",
      ".PpPPPPpP.",
      ".PpPPPPpP.",
      ".PpPPPPpP.",
      ".PppppppP.",
      ".gPPPPPPg.",
      "..........",
    ],
  },
  ticket: {
    size: 10,
    palette: { R: "#8f2418", r: "#c94636", Y: "#d8b24c" },
    rows: [
      "..........",
      "RRRRRRRRRR",
      "RrrYrrYrrR",
      "RrrrrrrrrR",
      "RYrrrrrrYR",
      "RrrrrrrrrR",
      "RrrYrrYrrR",
      "RRRRRRRRRR",
      "..........",
      "..........",
    ],
  },
  idleZzz: {
    size: 10,
    palette: { B: "#5a4426" },
    rows: [
      "..........",
      "..BBB.....",
      "....B.....",
      "...B......",
      ".BBB......",
      ".....BB...",
      ".......B..",
      "......B...",
      "....BB....",
      "..........",
    ],
  },
  family: {
    size: 10,
    palette: { S: "#d9a066", C: "#5a3b1e", c: "#8a5a2b" },
    rows: [
      ".S....S...",
      "SSS..SSS..",
      ".S....S...",
      "CCC..CCC..",
      "CCC..CCC..",
      "CC.S..CC..",
      "CC.SS.CC..",
      "...S......",
      "..ccc.....",
      "..ccc.....",
    ],
  },
  crown: {
    size: 10,
    palette: { g: "#a9781f", G: "#d8b24c", r: "#8f2418" },
    rows: [
      "..........",
      "G..G..G...",
      "GG.GG.GG..",
      "GGGGGGGG..",
      "GgrgrgrG..",
      "GGGGGGGG..",
      "GGGGGGGG..",
      "..........",
      "..........",
      "..........",
    ],
  },
  temple: {
    size: 10,
    palette: { g: "#a9781f", W: "#e6d9b0", B: "#5a3b1e" },
    rows: [
      "....g.....",
      "...ggg....",
      "..ggggg...",
      "WWWWWWWWWW",
      "W.W.W.W.WW",
      "W.W.W.W.WW",
      "W.W.W.W.WW",
      "W.W.W.W.WW",
      "WWWWWWWWWW",
      "BBBBBBBBBB",
    ],
  },
  fishingRod: {
    size: 10,
    palette: { B: "#5a3b1e", b: "#3ba3e0", g: "#a9781f" },
    rows: [
      "g.........",
      ".B........",
      "..B.......",
      "...B......",
      "....B.....",
      ".....B....",
      "......B...",
      ".......b..",
      "......b.b.",
      "..........",
    ],
  },
  leaf: {
    size: 10,
    palette: { B: "#7a4a1e", G: "#c9694a" },
    rows: [
      "....GG....",
      "...GGGG...",
      "..GGGGGG..",
      ".GGGGGGGG.",
      "GGGGGGGGG.",
      ".GGGGGGG..",
      "..GGGGG...",
      "...B......",
      "..B.......",
      "..........",
    ],
  },
  sprout: {
    size: 10,
    palette: { G: "#5ad18a", B: "#3f6b2e" },
    rows: [
      "..........",
      "..G....G..",
      "..GG..GG..",
      "...GGGG...",
      "....GG....",
      "....GG....",
      "....GG....",
      "....GG....",
      "...BBBB...",
      "..........",
    ],
  },
  snowflake: {
    size: 10,
    palette: { w: "#a9d8f2", W: "#eef0f2" },
    rows: [
      "....w.....",
      "..w.w.w...",
      "...www....",
      "wwwWwwwww.",
      "..www.....",
      "..w.w.w...",
      "....w.....",
      "..........",
      "..........",
      "..........",
    ],
  },
  sun: {
    size: 10,
    palette: { Y: "#d8b24c", y: "#eed88a" },
    rows: [
      "..y....y..",
      ".y.YYYY.y.",
      "..YyyyyY..",
      "yYyyyyyyYy",
      "..YyyyyY..",
      "..YyyyyY..",
      "yYyyyyyyYy",
      "..YyyyyY..",
      ".y.YYYY.y.",
      "..y....y..",
    ],
  },
  cancel: {
    size: 10,
    palette: { R: "#8f2418", r: "#c94636" },
    rows: [
      "R........R",
      "Rr......rR",
      ".Rr....rR.",
      "..Rr..rR..",
      "...RrrR...",
      "...RrrR...",
      "..Rr..rR..",
      ".Rr....rR.",
      "Rr......rR",
      "R........R",
    ],
  },
  hand: {
    size: 10,
    palette: { S: "#d9a066", s: "#c98a52" },
    rows: [
      "..S.S.S...",
      "..S.S.S...",
      "..S.S.SS..",
      "..SSSSSs..",
      ".SSSSSSs..",
      "SSSSSSSs..",
      "SSSSSSs...",
      ".SSSSs....",
      "..Sss.....",
      "..........",
    ],
  },
  pick: {
    size: 10,
    palette: { B: "#5a3b1e", S: "#9aa0a6", s: "#c7ccd1" },
    rows: [
      "SSs.......",
      ".SSs......",
      "..SSs.....",
      "...SB.....",
      "...BsB....",
      "..BsB.....",
      ".BsB......",
      "BsB.......",
      "sB........",
      "..........",
    ],
  },
  axe: {
    size: 10,
    palette: { B: "#5a3b1e", S: "#9aa0a6", s: "#c7ccd1" },
    rows: [
      "..SSs.....",
      ".SssSS....",
      "SsssssS...",
      ".SssSSB...",
      "...B.B....",
      "...B.B....",
      "....B.....",
      "....B.....",
      "....B.....",
      "..........",
    ],
  },
  hammer: {
    size: 10,
    palette: { B: "#5a3b1e", S: "#9aa0a6", s: "#c7ccd1" },
    rows: [
      "..SSSS....",
      ".SssssS...",
      "SsssssS...",
      ".SssssS...",
      "..S.SB....",
      "...B.B....",
      "....B.B...",
      ".....B.B..",
      "......B...",
      "..........",
    ],
  },
  shield: {
    size: 10,
    palette: { g: "#a9781f", G: "#d8b24c", B: "#2f5d86" },
    rows: [
      "..gggggg..",
      ".gGBBBBGg.",
      ".gBBBBBBg.",
      ".gBBGGBBg.",
      ".gBBGGBBg.",
      ".gBBBBBBg.",
      "..gBBBBg..",
      "...gBBg...",
      "....gg....",
      "..........",
    ],
  },
  compass: {
    size: 10,
    palette: { G: "#a9781f", W: "#eef0f2", R: "#8f2418" },
    rows: [
      "...GGGG...",
      ".GGWWWWGG.",
      "GGWWWWWWGG",
      "GWWWWRWWWG",
      "GWWWRRRWWG",
      "GWWWWWWWWG",
      "GGWWWWWWGG",
      ".GGWWWWGG.",
      "...GGGG...",
      "..........",
    ],
  },
  brain: {
    size: 10,
    palette: { P: "#a98cf0", p: "#c9b8f5" },
    rows: [
      "..PPPP....",
      ".PppppP...",
      "PpPppPpP..",
      "PpppppppP.",
      "PpPppPpPP.",
      ".PpppppP..",
      "..PPPPP...",
      "..........",
      "..........",
      "..........",
    ],
  },
  flag: {
    size: 10,
    palette: { B: "#5a3b1e", R: "#8f2418", r: "#c94636" },
    rows: [
      "B.RRRRR...",
      "B.RrrrR...",
      "B.RRRRR...",
      "B.........",
      "B.........",
      "B.........",
      "B.........",
      "B.........",
      "BBB.......",
      "..........",
    ],
  },
  trophy: {
    size: 10,
    palette: { g: "#a9781f", G: "#d8b24c" },
    rows: [
      ".GGGGGG...",
      "gGGGGGGg..",
      "gGGGGGGg..",
      ".GGGGGG...",
      "..GGGG....",
      "..GGGG....",
      ".GGGGGG...",
      "GGGGGGGG..",
      "..........",
      "..........",
    ],
  },
  briefcase: {
    size: 10,
    palette: { B: "#5a3b1e", b: "#8a5a2b", g: "#a9781f" },
    rows: [
      "...BBBB...",
      "...B..B...",
      ".bbbbbbbb.",
      ".bBBBBBBb.",
      ".bgggggb..",
      ".bBBBBBBb.",
      ".bbbbbbbb.",
      "..........",
      "..........",
      "..........",
    ],
  },
  tools: {
    size: 10,
    palette: { B: "#5a3b1e", S: "#9aa0a6", s: "#c7ccd1" },
    rows: [
      "S........s",
      ".S......s.",
      "..S....s..",
      "...S..s...",
      "....SX....",
      "...s..S...",
      "..s....S..",
      ".s......S.",
      "B........B",
      "..........",
    ],
  },
  bank: {
    size: 10,
    palette: { g: "#a9781f", W: "#e6d9b0", B: "#5a3b1e" },
    rows: [
      "....g.....",
      "...ggg....",
      "..ggggg...",
      "WWWWWWWWWW",
      ".W.WW.W.W.",
      ".W.WW.W.W.",
      ".W.WW.W.W.",
      ".W.WW.W.W.",
      "WWWWWWWWWW",
      "BBBBBBBBBB",
    ],
  },
  handshake: {
    size: 10,
    palette: { S: "#d9a066", C: "#2f5d86", c: "#8f2418" },
    rows: [
      "..........",
      "..CCSS....",
      ".CCCSSc...",
      "CCCSSScc..",
      ".CCSSScc..",
      "..SSSScc..",
      "..SScccc..",
      "...cccc...",
      "..........",
      "..........",
    ],
  },
  jar: {
    size: 10,
    palette: { P: "#f06ac2", p: "#f7a8dc", B: "#5a3b1e" },
    rows: [
      "..BBBB....",
      "..BppB....",
      ".PPPPPP...",
      ".PppppP...",
      ".PppppP...",
      ".PppppP...",
      ".PppppP...",
      ".PPPPPP...",
      "..........",
      "..........",
    ],
  },
  salt: {
    size: 10,
    palette: { W: "#eef0f2", w: "#c7ccd1" },
    rows: [
      "..WwWwW...",
      ".WwWwWwW..",
      "WwWwWwWwW.",
      ".WwWwWwW..",
      "..WwWwW...",
      "...WwW....",
      "..........",
      "..........",
      "..........",
      "..........",
    ],
  },
  crystal: {
    size: 10,
    palette: { C: "#6ff0e0", c: "#b9f7ef" },
    rows: [
      "....C.....",
      "...ccC....",
      "..CccCC...",
      ".CccccC...",
      "..CccC....",
      "...cC.....",
      "....C.....",
      "..........",
      "..........",
      "..........",
    ],
  },
  chain: {
    size: 10,
    palette: { S: "#9aa0a6", s: "#c7ccd1" },
    rows: [
      ".SS.......",
      "S..S......",
      "S..SSS....",
      ".SS..S....",
      ".....S.SS.",
      ".....S.S.S",
      "......SS.S",
      "......S..S",
      "......SS..",
      "..........",
    ],
  },
  tree: {
    size: 10,
    palette: { G: "#3f6b2e", g: "#5a8f42", B: "#5a3b1e" },
    rows: [
      "...GGG....",
      "..GgGgG...",
      ".GgGGGgG..",
      "GgGGGGGgG.",
      ".GgGGGgG..",
      "..GgGgG...",
      "...GGG....",
      "....B.....",
      "....B.....",
      "..........",
    ],
  },
  berry: {
    size: 10,
    palette: { R: "#8f2418", r: "#c94636", G: "#3f6b2e" },
    rows: [
      "....G.....",
      "...GgG....",
      "..RR..RR..",
      ".RrrRRrrR.",
      ".RrrrrrrR.",
      "..RrrrrR..",
      "..RrrrrR..",
      "...RrrR...",
      "..........",
      "..........",
    ],
  },
  fire: {
    size: 10,
    palette: { R: "#8f2418", O: "#c94636", Y: "#d8b24c" },
    rows: [
      "....R.....",
      "...ROR....",
      "..ROOOR...",
      "..ROYOR...",
      ".ROOYYOR..",
      ".ROYYYYR..",
      "..ROYYOR..",
      "...ROOR...",
      "....RR....",
      "..........",
    ],
  },
  dog: {
    size: 10,
    palette: { B: "#8a5a2b", b: "#c7935a", K: "#2c1e0d" },
    rows: [
      "B.......B.",
      "BB......BB",
      ".Bbbbbbb..",
      ".bbKbbKb..",
      ".bbbbbbb..",
      "..bbbbb...",
      "..b...b...",
      ".bb...bb..",
      "..........",
      "..........",
    ],
  },
  horse: {
    size: 10,
    palette: { B: "#5a3b1e", b: "#8a5a2b" },
    rows: [
      ".....BB...",
      "....BbbB..",
      "...BbbbB..",
      "..Bbbbbbbb",
      ".Bbbbbbbb.",
      "..bbbbb...",
      "..b...b...",
      ".bb...bb..",
      "..........",
      "..........",
    ],
  },
  cat: {
    size: 10,
    palette: { G: "#5a5048", g: "#8a7d6e", K: "#2c1e0d", P: "#c98f7a" },
    rows: [
      "G.......G.",
      "GG.....GG.",
      ".GgggggG..",
      ".gKggKgg..",
      ".gggPgggG.",
      ".ggggggG..",
      "..gggggG..",
      "..g...gG..",
      ".gg...gg..",
      "..........",
    ],
  },
  hawk: {
    size: 10,
    palette: { B: "#6b4a28", b: "#a8895a", W: "#e8dcc4", K: "#2c1e0d" },
    rows: [
      "..........",
      "BB.....BB.",
      ".BBb.bBB..",
      "..BbWbB...",
      "..bWKWb...",
      "..bWWWb...",
      "...bWb....",
      "...b.b....",
      "..........",
      "..........",
    ],
  },
  dragon: {
    size: 10,
    palette: { G: "#3f6b2e", g: "#5a8f42", R: "#8f2418" },
    rows: [
      "...G......",
      "..GgG.....",
      ".GggGG....",
      "GgggggGG..",
      ".gggggGGG.",
      "..ggggGG..",
      "...R.R....",
      "..........",
      "..........",
      "..........",
    ],
  },
  globe: {
    size: 10,
    palette: { B: "#2f5d86", b: "#6ac2f0", G: "#3f6b2e" },
    rows: [
      "..bbbbb...",
      ".bBBGBBb..",
      "bBBBGGBBb.",
      "bBGBBBGBb.",
      "bBBBGBBBb.",
      "bBGBBBGBb.",
      ".bBBGBBb..",
      "..bbbbb...",
      "..........",
      "..........",
    ],
  },
  island: {
    size: 10,
    palette: { G: "#3f6b2e", Y: "#c7935a", B: "#3ba3e0" },
    rows: [
      "..........",
      "BBBBBBBBBB",
      "BB.YGGY.BB",
      "B.YGGGGY.B",
      "BYGGGGGGYB",
      "BYYYYYYYYB",
      "BBBBBBBBBB",
      "..........",
      "..........",
      "..........",
    ],
  },
  shop: {
    size: 10,
    palette: { R: "#8f2418", r: "#c94636", W: "#eef0f2", B: "#5a3b1e" },
    rows: [
      "RrRrRrRrRr",
      "RRRRRRRRRR",
      "WWWWWWWWWW",
      "W.W..W.W.W",
      "W.W..W.W.W",
      "W.W..W.W.W",
      "BBBBBBBBBB",
      "..........",
      "..........",
      "..........",
    ],
  },
  check: {
    size: 10,
    palette: { g: "#3f6b2e", G: "#5ad18a" },
    rows: [
      ".........G",
      "........Gg",
      ".......Gg.",
      "G.....Gg..",
      "Gg...Gg...",
      ".Gg.Gg....",
      "..GgGg....",
      "...Gg.....",
      "..........",
      "..........",
    ],
  },
  peace: {
    size: 10,
    palette: { W: "#eef0f2", w: "#c7ccd1" },
    rows: [
      "....W.....",
      "...WwW....",
      "...WwW....",
      "..WwWwW...",
      ".WwW.WwW..",
      "WwW...WwW.",
      "..W.W.W...",
      "..W.W.W...",
      "...WWW....",
      "..........",
    ],
  },
  star: {
    size: 10,
    palette: { Y: "#d8b24c", y: "#eed88a" },
    rows: [
      "....y.....",
      "....Y.....",
      "...YyY....",
      "yYYYYYYYy.",
      "..YyyyY...",
      ".YyyyyyY..",
      ".Yy...yY..",
      "Yy.....yY.",
      "..........",
      "..........",
    ],
  },
  party: {
    size: 10,
    palette: { R: "#8f2418", Y: "#d8b24c", B: "#2f5d86", G: "#5ad18a" },
    rows: [
      "R....Y....",
      ".....G....",
      "..........",
      "Y....B....",
      "....R.....",
      "..G....Y..",
      "..........",
      "B....G....",
      "....Y..R..",
      "..........",
    ],
  },
  skull: {
    size: 10,
    palette: { W: "#e8e2d0", K: "#1a1512" },
    rows: [
      "..WWWWWW..",
      ".WWWWWWWW.",
      "WWWWWWWWWW",
      "WWKKWWKKWW",
      "WWKKWWKKWW",
      "WWWWWWWWWW",
      ".WWKWKWWW.",
      "..WKWKWK..",
      "...WWWW...",
      "..........",
    ],
  },
};

// Emoji -> icon-key lookup. Anything not listed here just falls back to the
// original emoji character (rendered by the OS's font, not pixel art) —
// safer than a hard crash if a new emoji shows up somewhere unmapped.
const EMOJI_MAP: Record<string, string> = {
  "❤": "heart", "❤️": "heart",
  "🍖": "meat",
  "👤": "person", "👥": "person",
  "😊": "smile",
  "📦": "box",
  "🪙": "coin",
  "🪵": "wood",
  "🪨": "stone",
  "💧": "water",
  "🌾": "wheat",
  "⚜": "fleur",
  "⚔": "sword", "⚔️": "sword",
  "🤝": "handshake",
  "💼": "briefcase",
  "⚑": "flag", "🚩": "flag",
  "🎫": "ticket",
  "✓": "check", "✔": "check", "✅": "check",
  "🪓": "axe",
  "🧭": "compass",
  "🧠": "brain",
  "🛡": "shield", "🛡️": "shield",
  "🔨": "hammer",
  "🏆": "trophy",
  "✦": "sun", "✨": "sun",
  "🛠": "tools", "🛠️": "tools",
  "📜": "scroll",
  "💤": "idleZzz",
  "👪": "family",
  "👑": "crown",
  "🏛": "bank", "🏛️": "bank",
  "🎣": "fishingRod",
  "🍂": "leaf",
  "🌱": "sprout",
  "❄": "snowflake", "❄️": "snowflake",
  "✕": "cancel", "✖": "cancel", "❌": "cancel",
  "✋": "hand",
  "⛏": "pick", "⛏️": "pick",
  "⚒": "hammer", "⚒️": "hammer",
  "☀": "sun", "☀️": "sun",
  "↩": "cancel", "↩️": "cancel",
  "🌐": "globe",
  "🏝": "island", "🏝️": "island",
  "🏪": "shop",
  "🐉": "dragon", "🐲": "dragon",
  "🐎": "horse", "🐴": "horse",
  "🐶": "dog",
  "🌳": "tree", "🌲": "tree", "🌴": "tree",
  "🔥": "fire",
  "🫐": "berry", "🌿": "leaf",
  "🔮": "crystal",
  "🧂": "salt",
  "🏺": "jar",
  "⛓": "chain", "⛓️": "chain",
  "🎉": "party",
  "💀": "skull",
  "🏗": "hammer", "🏗️": "hammer",
  "★": "star", "⭐": "star",
  "☮": "peace", "☮️": "peace",
};

const canvasCache = new Map<string, HTMLCanvasElement>();
const urlCache = new Map<string, string>();

function renderIconCanvas(def: IconDef): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = def.size;
  canvas.height = def.size;
  const ctx = canvas.getContext("2d")!;
  for (let y = 0; y < def.rows.length; y++) {
    const row = def.rows[y];
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === T || ch === "X" || !def.palette[ch]) continue;
      ctx.fillStyle = def.palette[ch];
      ctx.fillRect(x, y, 1, 1);
    }
  }
  return canvas;
}

function iconCanvas(name: string): HTMLCanvasElement | null {
  const def = ICONS[name];
  if (!def) return null;
  let canvas = canvasCache.get(name);
  if (!canvas) {
    canvas = renderIconCanvas(def);
    canvasCache.set(name, canvas);
  }
  return canvas;
}

function iconUrl(name: string): string | null {
  const canvas = iconCanvas(name);
  if (!canvas) return null;
  let url = urlCache.get(name);
  if (!url) {
    url = canvas.toDataURL();
    urlCache.set(name, url);
  }
  return url;
}

/** A drawImage-ready canvas for a named pixel icon, or null if unknown — for
 * world-space cosmetics rendered straight onto the game canvas (Renderer.ts)
 * rather than DOM overlays, where an `<img>` tag can't be drawn. */
export function pixelIconCanvas(name: string): HTMLCanvasElement | null {
  return iconCanvas(name);
}

/** Same lookup as emojiIcon but returns a canvas-drawable image (or null if
 * unmapped) instead of HTML, for Renderer.ts's world-space cosmetics. */
export function emojiIconCanvas(emoji: string): HTMLCanvasElement | null {
  const key = EMOJI_MAP[emoji];
  return key ? iconCanvas(key) : null;
}

/** An `<img>` tag for a named pixel icon (see ICONS above), sized to `px`. */
export function pixelIcon(name: string, px = 14): string {
  const url = iconUrl(name);
  if (!url) return "";
  return `<img src="${url}" width="${px}" height="${px}" alt="" ` +
    `style="image-rendering:pixelated;vertical-align:-3px;display:inline-block">`;
}

/** Swap a raw emoji character for its pixel-art equivalent, falling back to
 * the emoji itself if it isn't mapped yet — the one call most UI code needs. */
export function emojiIcon(emoji: string, px = 14): string {
  const key = EMOJI_MAP[emoji];
  if (!key) return emoji;
  const html = pixelIcon(key, px);
  return html || emoji;
}

// Toast/log strings arrive from the server-authoritative systems (e.g.
// SurvivalSystem, Diplomacy, TechSystem) as plain sentences with an emoji
// baked in — those files can't import this one (they also run on the
// headless Node server, no DOM/canvas). Instead the client-only Hud scans
// the finished sentence for any mapped emoji and swaps it in-place. Sorted
// longest-first so e.g. "❤️" (with variation selector) matches before "❤".
const EMOJI_SCAN = new RegExp(
  Object.keys(EMOJI_MAP)
    .sort((a, b) => b.length - a.length)
    .map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|"),
  "g",
);

/** Replace every mapped emoji found anywhere in `text` with its pixel-icon
 * HTML, leaving the rest of the sentence untouched. */
export function emojiifyText(text: string, px = 14): string {
  return text.replace(EMOJI_SCAN, (m) => emojiIcon(m, px));
}
