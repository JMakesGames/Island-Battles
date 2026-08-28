// Citizens are named, not numbered — players should grow attached to them
// (spec §6). A seeded generator keeps rosters reproducible per match.
import type { RNG } from "../core/rng.ts";

const FIRST = [
  "Bela", "Corin", "Dara", "Edda", "Faro", "Gwen", "Hale", "Ivo", "Juna",
  "Kael", "Lira", "Milo", "Nara", "Oren", "Petra", "Rild", "Sable", "Tovi",
  "Ussa", "Voss", "Wyn", "Yara", "Zeph",
];
const EPITHET = [
  "the Steady", "of the Reeds", "Longstride", "the Kind", "Ashfoot",
  "the Bold", "Quicklamp", "of the Cove", "the Patient", "Ironhand",
];

export function makeName(rng: RNG, withEpithet = false): string {
  const first = rng.pick(FIRST);
  return withEpithet ? `${first} ${rng.pick(EPITHET)}` : first;
}
