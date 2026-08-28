// A shareable single-file build may be opened via file:// or on an older
// browser where crypto.randomUUID isn't available, so this falls back to a
// Math.random-based id rather than crashing. Not cryptographically strong —
// fine for idempotency keys and a local player id, never used as a secret.
export function safeUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
