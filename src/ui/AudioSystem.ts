// Procedural sound effects (spec: "sound — there's no audio at all right
// now, which is a big gap"). Short synthesized tones via the Web Audio API
// — no shipped audio files at all, matching this project's fully-procedural
// assets ethos (see PixelIcons.ts's hand-drawn icon bitmaps, SpriteAtlas.ts's
// procedural sprites). A single lazily-created AudioContext, since browsers
// block audio before any user gesture — the first click naturally satisfies
// that, so no special "enable audio" prompt is needed.

export type SoundName = "click" | "hit" | "hurt" | "success" | "achievement" | "error";

let ctx: AudioContext | null = null;
let muted = false;
let volume = 0.8; // 0..1 master scale (spec: pause-menu volume control)

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

/** One short envelope-shaped tone: quick attack, exponential decay — the
 * classic cheap-and-cheerful chiptune blip, built from nothing but an
 * oscillator and a gain ramp. */
function tone(ac: AudioContext, freq: number, start: number, dur: number, type: OscillatorType, peakGain: number): void {
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, ac.currentTime + start);
  gain.gain.setValueAtTime(0, ac.currentTime + start);
  gain.gain.linearRampToValueAtTime(peakGain * volume, ac.currentTime + start + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.001, ac.currentTime + start + dur);
  osc.connect(gain);
  gain.connect(ac.destination);
  osc.start(ac.currentTime + start);
  osc.stop(ac.currentTime + start + dur + 0.02);
}

const RECIPES: Record<SoundName, (ac: AudioContext) => void> = {
  click: (ac) => tone(ac, 700, 0, 0.05, "square", 0.05),
  hit: (ac) => {
    tone(ac, 180, 0, 0.08, "square", 0.09);
    tone(ac, 90, 0.02, 0.06, "square", 0.06);
  },
  hurt: (ac) => tone(ac, 140, 0, 0.18, "sawtooth", 0.07),
  success: (ac) => {
    tone(ac, 520, 0, 0.08, "square", 0.06);
    tone(ac, 780, 0.07, 0.1, "square", 0.06);
  },
  achievement: (ac) => {
    tone(ac, 523, 0, 0.09, "square", 0.06);
    tone(ac, 659, 0.09, 0.09, "square", 0.06);
    tone(ac, 784, 0.18, 0.16, "square", 0.07);
  },
  error: (ac) => tone(ac, 110, 0, 0.15, "square", 0.06),
};

/** Plays a short synthesized sound; silently does nothing if muted, audio
 * isn't available, or the browser hasn't unlocked it yet — sound is pure
 * feedback, never something gameplay can depend on. */
export function playSound(name: SoundName): void {
  if (muted) return;
  const ac = getCtx();
  if (!ac) return;
  try {
    RECIPES[name](ac);
  } catch {
    // Audio is best-effort — never let a synthesis error interrupt play.
  }
}

export function setMuted(v: boolean): void {
  muted = v;
}

export function isMuted(): boolean {
  return muted;
}

/** Master volume 0..1 (spec: pause-menu volume slider). Scales every tone's
 * peak gain; 0 is effectively silent even when not muted. */
export function setVolume(v: number): void {
  volume = Math.max(0, Math.min(1, v));
}

export function getVolume(): number {
  return volume;
}
