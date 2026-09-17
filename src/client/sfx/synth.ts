/**
 * The bundled sound effects, synthesized at play time.
 *
 * No audio file ships with this project. The five event sounds are generated
 * with oscillators and a noise buffer inside the renderer's `AudioContext`, for
 * two reasons: shipping the game's own effects would be a copyright problem, and
 * shipping *any* recordings would put binary media in a repository whose whole
 * point is that the user supplies their own. A synthesized tone is a few lines
 * of gain arithmetic, is identical on every platform, and costs no download.
 *
 * The design brief is "tactical terminal", which in practice means:
 *
 *  - **short.** Nothing here runs past ~250 ms. These fire while the user is
 *    reading, and a sound that outlives the event it announces is noise.
 *  - **muted.** Peak gain is well under full scale, and every envelope decays
 *    exponentially rather than cutting off, because a hard stop on a sine is a
 *    click.
 *  - **non-musical.** Two-tone interval markers, not melodies. Nothing here
 *    implies a key or a rhythm that would fight whatever BGM is playing.
 *  - **not harsh.** Triangle and sine carriers; the only noise is a short,
 *    low-passed tick for the tool call. No square waves at high frequency.
 *
 * Each event is a small sequence of `tone()` steps plus, for `tool`, a noise
 * burst. `playSfx` is deliberately synchronous and returns nothing: an event
 * sound must never be able to fail the state machine that triggered it.
 */

import type { SfxEvent } from "../../prefs/types.js";

/** Peak amplitudes per event. These are pre-master-bus, so they are small. */
const LEVELS: Record<SfxEvent, number> = {
  start: 0.32,
  approval: 0.4,
  done: 0.34,
  error: 0.36,
  tool: 0.18,
};

export interface ToneStep {
  /** Start frequency in Hz. */
  from: number;
  /** End frequency in Hz; equal to `from` for a steady tone. */
  to: number;
  /** Offset from the start of the sequence, in seconds. */
  at: number;
  /** Sounding length in seconds. */
  duration: number;
  type: OscillatorType;
  /** Relative amplitude within the event, 0-1. */
  level: number;
}

/**
 * The step sequence for each event.
 *
 * Exported so the shape of every sound is asserted in tests without an
 * `AudioContext`: the tests can check that a sequence is short, bounded in
 * frequency, and that `error` descends while `done` resolves.
 */
export const SFX_SEQUENCES: Record<SfxEvent, ToneStep[]> = {
  // Upward two-tone: "channel open".
  start: [
    { from: 587, to: 587, at: 0, duration: 0.055, type: "triangle", level: 1 },
    { from: 880, to: 880, at: 0.07, duration: 0.09, type: "triangle", level: 0.9 },
  ],
  // A repeat pair on one pitch: the universal "needs your attention" shape,
  // deliberately distinct from `start` so the two are never confused.
  approval: [
    { from: 988, to: 988, at: 0, duration: 0.07, type: "triangle", level: 1 },
    { from: 988, to: 988, at: 0.14, duration: 0.07, type: "triangle", level: 1 },
  ],
  // Downward resolution: "done".
  done: [
    { from: 880, to: 880, at: 0, duration: 0.06, type: "triangle", level: 1 },
    { from: 659, to: 659, at: 0.075, duration: 0.12, type: "triangle", level: 0.85 },
  ],
  // Low, slightly detuned descent: wrong, without being an alarm.
  error: [
    { from: 233, to: 208, at: 0, duration: 0.13, type: "triangle", level: 1 },
    { from: 175, to: 147, at: 0.13, duration: 0.16, type: "sine", level: 0.8 },
  ],
  // A single soft tick. The noisiest event and the quietest by design, because
  // it fires once per tool call and is the one users switch off.
  tool: [{ from: 1200, to: 900, at: 0, duration: 0.03, type: "sine", level: 1 }],
};

/** Frequency bounds the tests hold every sequence to. */
export const MIN_TONE_HZ = 80;
export const MAX_TONE_HZ = 4000;
/** Nothing may ring for longer than this, measured to the last step's end. */
export const MAX_EVENT_SECONDS = 0.4;

/** Total wall-clock length of an event's sequence. */
export function sequenceDuration(steps: ToneStep[]): number {
  return steps.reduce((max, step) => Math.max(max, step.at + step.duration), 0);
}

/**
 * Schedules one tone.
 *
 * The envelope is a fast linear attack into an exponential decay. The decay
 * targets a hair above zero because `exponentialRampToValueAtTime` rejects a
 * zero target, and the 3 ms attack is short enough to read as instant while
 * still avoiding the click a step change would produce.
 */
function tone(ctx: AudioContext, destination: AudioNode, step: ToneStep, peak: number): void {
  const start = ctx.currentTime + step.at;
  const end = start + step.duration;
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = step.type;
  osc.frequency.setValueAtTime(step.from, start);
  if (step.to !== step.from) osc.frequency.linearRampToValueAtTime(step.to, end);
  const level = Math.max(0.0001, peak * step.level);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(level, start + 0.003);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  osc.connect(gain);
  gain.connect(destination);
  osc.start(start);
  osc.stop(end + 0.01);
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* already torn down */
    }
  };
}

/**
 * A short low-passed noise burst, used as the tool-call tick.
 *
 * The buffer is one second of noise, created once per call and discarded as
 * soon as the source ends. A cached buffer would be marginally cheaper but would
 * also need a lifetime tied to the context, and this fires at most once per tool
 * call.
 */
function noiseTick(ctx: AudioContext, destination: AudioNode, peak: number, at = 0, duration = 0.03): void {
  const frames = Math.max(1, Math.floor(ctx.sampleRate * duration));
  const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < frames; i += 1) {
    // Taper the noise itself, so the burst cannot click at its own edges even
    // if the gain envelope is stepped.
    const t = i / frames;
    data[i] = (Math.random() * 2 - 1) * (1 - t);
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  const filter = ctx.createBiquadFilter();
  filter.type = "lowpass";
  filter.frequency.setValueAtTime(2400, ctx.currentTime + at);
  const gain = ctx.createGain();
  const start = ctx.currentTime + at;
  const end = start + duration;
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(Math.max(0.0001, peak), start + 0.002);
  gain.gain.exponentialRampToValueAtTime(0.0001, end);
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  source.start(start);
  source.stop(end + 0.01);
  source.onended = () => {
    try {
      source.disconnect();
      filter.disconnect();
      gain.disconnect();
    } catch {
      /* already torn down */
    }
  };
}

/**
 * Plays one event sound.
 *
 * Returns false when there is nothing to play through — no context, a context
 * the autoplay policy is still holding, or a bus that is not wired — so the
 * caller can count a skipped effect rather than believe it played.
 */
export function playSfx(event: SfxEvent, ctx: AudioContext | undefined, destination: AudioNode | undefined): boolean {
  if (!ctx || !destination) return false;
  if (ctx.state !== "running") return false;
  const steps = SFX_SEQUENCES[event];
  if (!steps || steps.length === 0) return false;
  const peak = LEVELS[event] ?? 0.3;
  try {
    if (event === "tool") noiseTick(ctx, destination, peak);
    for (const step of steps) tone(ctx, destination, step, peak);
    return true;
  } catch {
    return false;
  }
}
