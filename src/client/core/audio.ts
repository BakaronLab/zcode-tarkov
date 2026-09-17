/**
 * The renderer's audio engine: one `AudioContext`, four gain buses, and the
 * autoplay-policy unlock.
 *
 * Chromium will not let a page start an `AudioContext` before the user has
 * interacted with it, and an injected script has no privileged exemption. The
 * policy is respected rather than fought:
 *
 *  - The context is created **lazily**, on the first real need. Creating one at
 *    injection time would produce a permanently `suspended` context and a
 *    console warning on every load for users who never enable audio.
 *  - `resume()` is only ever called from inside a genuine user-gesture handler.
 *    A timer-driven retry is exactly what the policy is designed to defeat, and
 *    a retry loop is what fills the console with warnings, so there is none.
 *  - A one-shot capture-phase listener on `pointerdown`, `keydown` and `touchstart`
 *    unlocks as soon as the user does anything at all, which is what makes the
 *    first click on the BGM dock or the "Enable audio" button work.
 *  - Until that happens the engine reports `locked`, and the dock and settings
 *    panel render that state instead of pretending to play. Nothing is queued
 *    and nothing is lost: the caller re-checks `unlocked` and starts playback
 *    itself once it flips.
 *
 * The four buses exist so the settings panel's sliders map onto real gain
 * nodes: an event effect, the music, and a pet voice each need their own level
 * under one master, and doing that with per-element `volume` would make the
 * master unable to affect a stream that is already playing.
 */

export type Bus = "sfx" | "bgm" | "voice";

export interface AudioVolumes {
  master: number;
  sfx: number;
  bgm: number;
  voice: number;
}

export class AudioEngine {
  private ctx: AudioContext | undefined;
  private master: GainNode | undefined;
  private readonly buses = new Map<Bus, GainNode>();
  private unlockedFlag = false;
  private unlockAttempted = false;
  private readonly listeners = new Set<(unlocked: boolean) => void>();
  private detachGesture: (() => void) | undefined;

  constructor(private readonly volumes: AudioVolumes) {}

  /** True once a user gesture has let the context actually run. */
  get unlocked(): boolean {
    return this.unlockedFlag;
  }

  /** True when a context exists but the policy is still holding it suspended. */
  get locked(): boolean {
    return this.ctx !== undefined && this.ctx.state !== "running";
  }

  get context(): AudioContext | undefined {
    return this.ctx;
  }

  onUnlock(listener: (unlocked: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Returns the context, creating it on first use.
   *
   * Returns undefined when the platform has no `AudioContext` at all — an older
   * Electron, or a renderer with audio disabled — so every caller can degrade to
   * "no sound" without a thrown error.
   */
  ensureContext(): AudioContext | undefined {
    if (this.ctx) return this.ctx;
    try {
      const Ctor = window.AudioContext ?? (window as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return undefined;
      const ctx = new Ctor();
      this.ctx = ctx;
      this.master = ctx.createGain();
      this.master.connect(ctx.destination);
      for (const bus of ["sfx", "bgm", "voice"] as Bus[]) {
        const gain = ctx.createGain();
        gain.connect(this.master);
        this.buses.set(bus, gain);
      }
      this.applyVolumes(this.volumes);
      // A context created inside a gesture can already be running; that counts
      // as unlocked and must be reported, or playback would wait forever for a
      // second gesture that is never needed.
      if (contextState(ctx) === "running") this.markUnlocked(true);
      else ctx.onstatechange = () => this.markUnlocked(contextState(ctx) === "running");
      return ctx;
    } catch {
      return undefined;
    }
  }

  /** The gain node a bus feeds through, creating the graph if needed. */
  bus(bus: Bus): GainNode | undefined {
    this.ensureContext();
    return this.buses.get(bus);
  }

  /**
   * Attempts to resume the context. Must be called from a user-gesture handler
   * to have any effect; safe to call at other times (it simply fails).
   */
  async tryUnlock(): Promise<boolean> {
    const ctx = this.ensureContext();
    if (!ctx) return false;
    if (ctx.state === "running") {
      this.markUnlocked(true);
      return true;
    }
    this.unlockAttempted = true;
    try {
      await ctx.resume();
    } catch {
      return false;
    }
    // Read the state through a function: the checks above narrow `ctx.state` at
    // compile time, and after an await that narrowing is a lie — the context can
    // have started running (or been closed) while the promise was pending.
    const ok = contextState(ctx) === "running";
    if (ok) this.markUnlocked(true);
    return ok;
  }

  /**
   * Installs the one-shot gesture listeners that unlock the engine.
   *
   * Capture phase and `once`-like behaviour: the first qualifying event wins,
   * the listeners remove themselves, and a gesture that fails to unlock is not
   * retried in a loop.
   */
  installGestureUnlock(target: EventTarget = document): void {
    if (this.detachGesture) return;
    const events = ["pointerdown", "keydown", "touchstart"] as const;
    let done = false;
    const handler = () => {
      if (done) return;
      done = true;
      void this.tryUnlock().then((ok) => {
        if (ok) this.removeGesture(target, events, handler);
      });
    };
    for (const name of events) target.addEventListener(name, handler, { capture: true, passive: true });
    this.detachGesture = () => {
      done = true;
      this.removeGesture(target, events, handler);
    };
  }

  /** Removes the gesture listeners; called on dispose. */
  removeGestureUnlock(): void {
    this.detachGesture?.();
    this.detachGesture = undefined;
  }

  /** Pushes new levels onto the live gain nodes. */
  applyVolumes(volumes: AudioVolumes): void {
    Object.assign(this.volumes, volumes);
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    // Short ramps instead of jumps: a step change in gain on a playing source
    // is audible as a click.
    const ramp = (node: GainNode | undefined, value: number) => {
      if (!node) return;
      try {
        node.gain.setTargetAtTime(clamp01(value), now, 0.02);
      } catch {
        node.gain.value = clamp01(value);
      }
    };
    ramp(this.master, this.volumes.master);
    ramp(this.buses.get("sfx"), this.volumes.sfx);
    ramp(this.buses.get("bgm"), this.volumes.bgm);
    ramp(this.buses.get("voice"), this.volumes.voice);
  }

  /** Releases the context. Called when the theme is torn down. */
  dispose(): void {
    this.removeGestureUnlock();
    this.listeners.clear();
    try {
      void this.ctx?.close();
    } catch {
      /* already closed */
    }
    this.ctx = undefined;
    this.master = undefined;
    this.buses.clear();
    this.unlockedFlag = false;
  }

  /** True when an unlock was tried and did not take, for the UI's hint text. */
  get unlockFailed(): boolean {
    return this.unlockAttempted && !this.unlockedFlag;
  }

  private markUnlocked(value: boolean): void {
    if (this.unlockedFlag === value) return;
    this.unlockedFlag = value;
    if (value) this.unlockAttempted = false;
    for (const listener of this.listeners) {
      try {
        listener(value);
      } catch {
        /* a listener must not break the engine */
      }
    }
  }

  private removeGesture(target: EventTarget, events: readonly string[], handler: EventListener): void {
    for (const name of events) {
      try {
        target.removeEventListener(name, handler, { capture: true });
      } catch {
        /* nothing to remove */
      }
    }
  }
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Reads an `AudioContext`'s state without letting the compiler narrow it.
 *
 * Every state check in this module happens across an `await`, where a narrowed
 * union is stale; routing them all through one function keeps the narrowing
 * local and the intent obvious.
 */
function contextState(ctx: AudioContext): AudioContextState {
  return ctx.state;
}
