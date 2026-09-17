/**
 * The pet's voice: a random clip from `voice/`, decoded once and kept.
 *
 * Nothing is bundled. The pool is whatever the user dropped into `voice/`, and
 * three consequences of that shape this module:
 *
 *  - **The list is fetched lazily.** A user who never clicks the pet causes no
 *    request at all, and a user whose `voice/` folder is empty gets silence
 *    rather than an error dialog about content the project cannot legally ship.
 *  - **Decoded audio is cached by bytes, not by entry count.** One voice line is
 *    tens of kilobytes while a mis-dropped recording can be an order of
 *    magnitude larger, so an entry-count bound would either re-decode
 *    constantly or hold far too much; `LruCache` owns that arithmetic.
 *  - **Every failure is silence.** An unreachable service, a clip the browser
 *    cannot decode, a locked `AudioContext`: none of them may throw into the
 *    click handler that asked for the sound, because the click's real job is
 *    the pet, not the noise.
 *
 * `pickIndex` is exported on its own so the "never the clip that just played"
 * rule can be tested without a DOM or an audio stack.
 */

import type { ClientContext } from "../core/context.js";
import { LruCache } from "../core/lru.js";

/**
 * The audio extensions the service serves for `voice/`.
 *
 * Deliberately a copy of the server's allowlist: the renderer bundle cannot
 * import that module (it pulls in `node:fs`). The server already filters the
 * pool, but the response is a network input, so a name is checked here before
 * it costs a fetch and a decode that can only fail.
 */
const AUDIO_EXTENSION = /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|webm|opus)$/i;

/** Decoded-buffer budget. A pool of short lines stays resident; a few long ones do not. */
const DECODED_BUDGET_BYTES = 24 * 1024 * 1024;

/**
 * How many decodes may be in flight at once.
 *
 * A user who clicks the pet repeatedly must not start one HTTP request per
 * click; past this limit a click resolves `false` immediately instead of
 * queueing, because a queue would delay the sound until after the clicking
 * stopped, which reads as a stutter rather than an answer.
 */
const MAX_CONCURRENT_DECODES = 2;

/**
 * How many copies of one clip may overlap.
 *
 * Three is the smallest number that lets a rapid triple-click answer each
 * press. Beyond that the copies phase-align into something that reads as a
 * glitch rather than a voice, and every copy is a live output node. A fourth
 * press inside the window is dropped rather than queued, for the same reason
 * the decode cap drops one: a queued sound arrives after the gesture that
 * asked for it.
 */
const MAX_SAME_CLIP_VOICES = 3;

/**
 * Picks the next pool index, never repeating `previous`.
 *
 * `previous` out of range (a refreshed pool, or the initial -1) is treated as
 * "no history" and every index is eligible. Returns -1 only when there is
 * nothing to pick; callers check the pool size first.
 */
export function pickIndex(previous: number, length: number, random: () => number = Math.random): number {
  if (!Number.isInteger(length) || length <= 0) return -1;
  if (length === 1) return 0;
  const history = Number.isInteger(previous) && previous >= 0 && previous < length ? previous : -1;
  const draw = unitInterval(random());
  // Draw from the `length - 1` indices that exclude the previous one, then skip
  // over it: that keeps the remaining indices exactly equiprobable, which a
  // rejection loop would not guarantee in bounded time.
  const offset = Math.floor(draw * (length - 1));
  return history >= 0 && offset >= history ? offset + 1 : offset;
}

export class PetVoice {
  private names: string[] = [];
  private loaded = false;
  private lastIndex = -1;
  private disposed = false;
  private readonly abort = new AbortController();
  private readonly buffers = new LruCache<AudioBuffer>(DECODED_BUDGET_BYTES);
  private readonly pending = new Map<string, Promise<AudioBuffer | undefined>>();
  private readonly voices = new Map<string, number>();
  private readonly sources = new Set<AudioBufferSourceNode>();
  private readonly elements = new Set<HTMLAudioElement>();

  constructor(private readonly ctx: ClientContext) {}

  get size(): number {
    return this.names.length;
  }

  /** Re-reads the pool. An unreachable service keeps the last known list. */
  async refresh(): Promise<number> {
    try {
      const response: unknown = await this.ctx.api.getPool("voice");
      const entries = isRecord(response) ? response.entries : undefined;
      this.names = voiceNames(entries);
      this.loaded = true;
    } catch {
      // A failed refresh must not empty a pool that was working: the service
      // being briefly unreachable is not the user deleting their clips.
    }
    return this.names.length;
  }

  async maybeSpeak(): Promise<boolean> {
    const audio = this.ctx.prefs().audio;
    // Re-checked here as well as at the click site: this is a public entry
    // point, and a mute preference only one caller honours is not a mute
    // preference.
    if (!audio.enabled || !audio.voice.enabled) return false;
    // Written as a positive comparison so a NaN chance (a hand-edited prefs
    // file) fails closed rather than rolling true every time.
    if (!(Math.random() < audio.voice.chance)) return false;
    return this.speak();
  }

  /**
   * Plays a clip without the chance roll, for the settings panel's test button.
   *
   * The enabled switches are the caller's business here: the point of the test
   * button is to prove the pool and the pipeline work, and a test that refuses
   * to run until every switch is on proves nothing.
   */
  async speak(): Promise<boolean> {
    if (this.disposed) return false;
    const names = await this.ensurePool();
    if (names.length === 0) return false;
    const index = pickIndex(this.lastIndex, names.length);
    this.lastIndex = index;
    return this.play(names[index]);
  }

  /** Stops every voice this instance started and drops the caches. */
  dispose(): void {
    this.disposed = true;
    try {
      this.abort.abort();
    } catch {
      /* an aborted controller is not an error */
    }
    for (const source of [...this.sources]) {
      try {
        source.stop();
      } catch {
        /* already ended */
      }
    }
    this.sources.clear();
    for (const element of [...this.elements]) {
      try {
        element.pause();
      } catch {
        /* already stopped */
      }
    }
    this.elements.clear();
    this.voices.clear();
    this.pending.clear();
    this.buffers.clear();
    this.names = [];
    this.loaded = false;
    this.lastIndex = -1;
  }

  private async ensurePool(): Promise<string[]> {
    // A failed read is not marked loaded, so the next click retries it; there
    // is no timer here on purpose, and a click is the only thing that can
    // start the request.
    if (!this.loaded) await this.refresh();
    return this.names;
  }

  private async play(name: string): Promise<boolean> {
    if (this.disposed) return false;
    const context = this.ctx.audio.unlocked ? this.ctx.audio.context : undefined;
    if (context && this.ctx.audio.bus("voice")) {
      const buffer = await this.load(name, context);
      if (!buffer || this.disposed) return false;
      // Re-checked after the await: a burst of clicks can all pass the first
      // check while the decode is pending.
      if ((this.voices.get(name) ?? 0) >= MAX_SAME_CLIP_VOICES) return false;
      return this.startSource(name, buffer, context);
    }
    return this.playElement(name);
  }

  /**
   * Decodes a clip, reusing an in-flight decode of the same name.
   *
   * The pending map is also the concurrency limiter: one entry per running
   * decode, so two clicks on different clips can decode while a third waits for
   * the next click instead of piling on.
   */
  private load(name: string, context: AudioContext): Promise<AudioBuffer | undefined> {
    const cached = this.buffers.get(name);
    if (cached) return Promise.resolve(cached);
    const inFlight = this.pending.get(name);
    if (inFlight) return inFlight;
    if (this.pending.size >= MAX_CONCURRENT_DECODES) return Promise.resolve(undefined);
    const job = this.decode(name, context).finally(() => {
      this.pending.delete(name);
    });
    this.pending.set(name, job);
    return job;
  }

  private async decode(name: string, context: AudioContext): Promise<AudioBuffer | undefined> {
    try {
      const response = await fetch(this.ctx.api.mediaUrl("voice", name), { signal: this.abort.signal });
      if (!response.ok) return undefined;
      const bytes = await response.arrayBuffer();
      const buffer = await context.decodeAudioData(bytes);
      if (this.disposed) return undefined;
      // 4 bytes per float sample, which is what the decoded buffer actually
      // holds; the encoded size on disk says nothing about this.
      this.buffers.set(name, buffer, buffer.length * buffer.numberOfChannels * 4);
      return buffer;
    } catch {
      // Network, abort, or a codec this browser cannot decode; all of them mean
      // "no sound this time", never a rejected promise.
      return undefined;
    }
  }

  private startSource(name: string, buffer: AudioBuffer, context: AudioContext): boolean {
    const bus = this.ctx.audio.bus("voice");
    if (!bus) return false;
    // The slot is taken before the source exists so that only this call owns it;
    // releasing a slot that another copy of the clip is holding would let a
    // fourth click through the polyphony guard.
    if (!this.hold(name)) return false;
    let source: AudioBufferSourceNode;
    try {
      source = context.createBufferSource();
      source.buffer = buffer;
      // Connected dry: the voice bus already carries `master x voice` from the
      // engine's gain graph, and a per-source gain would apply the slider twice.
      source.connect(bus);
      source.onended = () => {
        try {
          source.disconnect();
        } catch {
          /* already disconnected */
        }
        this.sources.delete(source);
        this.release(name);
      };
      source.start();
    } catch {
      this.release(name);
      return false;
    }
    this.sources.add(source);
    return true;
  }

  /**
   * Plays through an `<audio>` element when the engine has no running context.
   *
   * Still guarded rather than removed: the platform may expose no
   * `AudioContext` at all, and a pet that only clicks silently is worse than
   * one that uses the element path with the element's own volume.
   */
  private async playElement(name: string): Promise<boolean> {
    let element: HTMLAudioElement;
    try {
      element = new Audio(this.ctx.api.mediaUrl("voice", name));
    } catch {
      return false;
    }
    if (!this.hold(name)) return false;
    // The element bypasses the engine's gain graph, so the master has to be
    // folded in by hand or this path ignores the master slider.
    const audio = this.ctx.prefs().audio;
    element.volume = clamp01(audio.voice.volume * audio.masterVolume);
    // `play()` rejecting and the element's own `error` event can both arrive for
    // one element; the flag keeps the second from freeing a slot another copy of
    // the clip is holding.
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      this.elements.delete(element);
      this.release(name);
    };
    element.addEventListener("ended", release, { once: true });
    element.addEventListener("error", release, { once: true });
    this.elements.add(element);
    try {
      await element.play();
      return true;
    } catch {
      release();
      return false;
    }
  }

  private hold(name: string): boolean {
    const active = this.voices.get(name) ?? 0;
    if (active >= MAX_SAME_CLIP_VOICES) return false;
    this.voices.set(name, active + 1);
    return true;
  }

  private release(name: string): void {
    const active = this.voices.get(name);
    if (active === undefined) return;
    if (active <= 1) this.voices.delete(name);
    else this.voices.set(name, active - 1);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The servable names in a pool response, in the order the service listed them. */
function voiceNames(entries: unknown): string[] {
  if (!Array.isArray(entries)) return [];
  const out: string[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    const name = entry.filename;
    if (typeof name === "string" && AUDIO_EXTENSION.test(name)) out.push(name);
  }
  return out;
}

/** Clamps a random draw into `[0, 1)` so a test's stub cannot index out of range. */
function unitInterval(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(0.9999999, Math.max(0, value));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
