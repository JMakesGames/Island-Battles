// Minimal typed event bus. Systems stay decoupled by publishing/subscribing
// here rather than calling each other directly (spec §34 separation). This is
// the seam the network layer (net/Simulation.ts, net/Transport.ts) relays
// verbatim to clients — every variant must stay plain, serializable data.

export type GameSignal =
  | { type: "resourceChanged" }
  | { type: "citizenRecruited"; name: string }
  | { type: "buildingPlaced"; id: string }
  | { type: "buildingComplete"; id: string }
  | { type: "dayPassed"; day: number; season: string }
  | { type: "chronicle"; text: string }
  // civ: which human civ this decision is for — a networked match may have
  // several, so the client filters to the one that's theirs (spec §36 Phase 5).
  | { type: "eventTriggered"; eventId: string; civ: number }
  | { type: "rivalDiscovered" }
  | { type: "diplomacyChanged" }
  | { type: "proposalReceived"; fromCiv: number; toCiv: number }
  | { type: "marketChanged" }
  | { type: "researchComplete"; civ: number; techId: string }
  | { type: "leaderLevelUp"; civ: number; level: number; traitId: string }
  | { type: "victory"; kind: string; civId: number; civName: string; day: number }
  | { type: "toast"; text: string };

type Handler = (s: GameSignal) => void;

export class EventBus {
  private handlers = new Set<Handler>();

  on(handler: Handler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  emit(signal: GameSignal): void {
    for (const h of this.handlers) h(signal);
  }
}
