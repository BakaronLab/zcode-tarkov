/**
 * The randomized running-status text.
 *
 * While the agent is working, the product replaces ZCode's own status line with
 * a tactical phrase and re-rolls it as the turn progresses. The hard part is not
 * picking phrases: it is doing this without breaking ZCode's live region, its
 * elapsed-time display, or its task state.
 *
 * The rule that shapes the whole module: **never write to React's text.** ZCode
 * owns that node, re-renders it on its own schedule, and an injected
 * `textContent =` is both immediately overwritten and capable of feeding a
 * `MutationObserver` into a loop. So the takeover is purely presentational —
 * an attribute plus a stylesheet rule that hides the original glyphs and draws
 * the phrase over them — and restoring it is removing the attribute. The native
 * text, its `aria-live` semantics, the timer and the task state are all
 * untouched because nothing about them is modified.
 *
 * Everything is driven by `StatusAnchor`, so the DOM technique is replaceable
 * and the rolling logic is testable on its own.
 */

import type { ClientContext } from "../core/context.js";
import type { StatusControl } from "../contracts.js";
import { nextIndex, resolvePool } from "../../status/pool.js";
import type { StatusLanguage } from "../../prefs/types.js";
import type { Phase } from "../signals/machine.js";

/**
 * The DOM half of the takeover.
 *
 * `show` may be called repeatedly with the same element; it must be cheap and
 * idempotent. `restore` must leave the element indistinguishable from one this
 * module never touched — including removing anything it added to the element or
 * to the document head.
 */
export interface StatusAnchor {
  /** The element to shadow, or undefined when ZCode's status line is absent. */
  find(): HTMLElement | undefined;
  /** Draws `phrase` over the native text. Never mutates the native text. */
  show(element: HTMLElement, phrase: string): void;
  /** Removes the takeover from `element` and releases any injected style. */
  restore(element: HTMLElement): void;
  /** Releases everything, for dispose. */
  dispose(): void;
}

export interface StatusRollerOptions {
  anchor: StatusAnchor;
  /** How often to re-roll while running, in ms, when nothing else triggers it. */
  intervalMs?: number;
  random?: () => number;
}

/** The fallback re-roll cadence while a task is running. */
export const DEFAULT_STATUS_INTERVAL_MS = 12_000;

export class StatusRoller implements StatusControl {
  private phrases: string[] = [];
  private source: "user" | "bundled" | "unknown" = "unknown";
  private lastIndex = -1;
  private current: string | undefined;
  private phase: Phase = "idle";
  private attached: HTMLElement | undefined;
  private timer: number | null = null;
  private unsubPrefs: (() => void) | undefined;
  private readonly random: () => number;

  constructor(
    private readonly ctx: ClientContext,
    private readonly options: StatusRollerOptions
  ) {
    this.random = options.random ?? Math.random;
  }

  start(): void {
    this.unsubPrefs = this.ctx.onPrefs(() => this.sync());
    void this.reload().then(() => this.sync());
  }

  dispose(): void {
    this.unsubPrefs?.();
    this.unsubPrefs = undefined;
    this.detach();
    this.options.anchor.dispose();
    this.phrases = [];
    this.current = undefined;
    this.source = "unknown";
  }

  // --- StatusControl ------------------------------------------------------

  async reload(): Promise<number> {
    const prefs = this.ctx.prefs();
    try {
      const result = await this.ctx.api.getStatusPhrases(prefs.status.language);
      const phrases = Array.isArray(result.phrases) ? result.phrases.filter((p) => typeof p === "string") : [];
      this.phrases = phrases;
      this.source = result.source === "user" ? "user" : phrases.length > 0 ? "bundled" : "unknown";
      // A pool the user just emptied must not leave a stale phrase on screen.
      if (this.phrases.length === 0) this.current = undefined;
      this.roll();
      return this.phrases.length;
    } catch {
      // A dead service must not clear a working pool, and must not blank the
      // status line. Keep whatever we have and let the panel report offline.
      return this.phrases.length;
    }
  }

  poolSource(): "user" | "bundled" | "unknown" {
    return this.source;
  }

  currentPhrase(): string | undefined {
    return this.current;
  }

  /** Local fallback pool, used before the first successful fetch. */
  seedLocalPool(language: StatusLanguage): void {
    if (this.phrases.length > 0) return;
    const resolved = resolvePool(language, undefined);
    this.phrases = resolved.phrases;
    this.source = "bundled";
  }

  // --- driven by the signal layer -----------------------------------------

  /** Called whenever the signal layer's phase changes. */
  setPhase(phase: Phase): void {
    if (phase === this.phase) return;
    this.phase = phase;
    if (phase === "running" || phase === "approval") {
      this.roll();
      this.sync();
    } else {
      this.detach();
    }
  }

  /**
   * Called when the turn made progress (a reasoning step, a tool call).
   *
   * The trigger switches decide whether that is worth a new phrase; the default
   * is yes for all three, which is what makes the text feel alive rather than
   * static.
   */
  onProgress(kind: "reasoning" | "tool" | "progress"): void {
    const prefs = this.ctx.prefs();
    if (prefs.status.triggers[kind] === false) return;
    if (this.phase !== "running" && this.phase !== "approval") return;
    this.roll();
    this.sync();
  }

  // --- internals ----------------------------------------------------------

  /** True when the takeover is allowed right now. */
  private active(): boolean {
    const prefs = this.ctx.prefs();
    if (!prefs.status.enabled) return false;
    if (this.phase !== "running" && this.phase !== "approval") return false;
    // Tarkov is the mode this belongs to; other modes need the explicit switch.
    if (this.ctx.theme() !== "tarkov" && !prefs.status.anyTheme) return false;
    return true;
  }

  /** Picks the next phrase, never the one already showing. */
  private roll(): void {
    if (this.phrases.length === 0) return;
    const index = nextIndex(this.lastIndex, this.phrases.length, this.random);
    this.lastIndex = index;
    this.current = this.phrases[index];
  }

  /** Applies or removes the takeover to match the current prefs and phase. */
  private sync(): void {
    if (!this.active()) {
      this.detach();
      return;
    }
    const prefs = this.ctx.prefs();
    if (this.phrases.length === 0) this.seedLocalPool(prefs.status.language);
    if (this.phrases.length === 0 || !this.current) {
      this.detach();
      return;
    }
    const element = this.options.anchor.find();
    if (!element) {
      // No status line in this document (the empty-chat screen has none). Not an
      // error: the phrase is kept so it is ready when one appears.
      this.attached = undefined;
      return;
    }
    this.attached = element;
    this.options.anchor.show(element, this.current);
    this.ensureTimer();
  }

  private detach(): void {
    if (this.attached) {
      this.options.anchor.restore(this.attached);
      this.attached = undefined;
    }
    this.clearTimer();
  }

  /**
   * A low-frequency re-roll while a turn is running.
   *
   * ZCode's own status text changes on its own schedule, and there are long
   * stretches — a slow model, a long tool call — where nothing observable
   * happens. Without this the phrase would sit unchanged for a minute and look
   * stuck. The interval is deliberately long: this must not be a poll loop.
   */
  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => {
      if (!this.active()) {
        this.detach();
        return;
      }
      this.roll();
      const element = this.attached ?? this.options.anchor.find();
      if (element && this.current) {
        this.attached = element;
        this.options.anchor.show(element, this.current);
      }
    }, this.options.intervalMs ?? DEFAULT_STATUS_INTERVAL_MS) as unknown as number;
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }
}
