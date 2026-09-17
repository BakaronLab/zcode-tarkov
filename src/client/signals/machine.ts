/**
 * The event state machine.
 *
 * The injected client observes the renderer and decides when a sound should
 * play. A `MutationObserver` on its own is the wrong tool for that: ZCode
 * re-renders constantly, the same logical state appears and disappears between
 * animation frames, and a rule of "state changed → play" produces a machine gun.
 * This module is the layer that turns a stream of noisy observations into a
 * small number of events, and it is deliberately pure — no timers, no DOM, no
 * audio — so the whole contract is testable.
 *
 * The transition graph it implements:
 *
 *     idle ──▶ running ──▶ done          (a turn finished)
 *                 │  ▲
 *                 │  └── approval ──▶ running   (the user answered)
 *                 └──▶ error                    (failed or interrupted)
 *
 * and the rules that make it quiet:
 *
 *  - **Debounce on entry.** `running` must be observed for `entryTicks`
 *    consecutive observations before the machine believes it, so a one-frame
 *    render artifact cannot fire the start sound.
 *  - **Debounce on exit.** `done` fires only after `exitTicks` consecutive
 *    observations with no run in progress, so the gap between two tool calls is
 *    not read as "the task finished".
 *  - **Once per turn.** Within one running period, `done` fires exactly once,
 *    `error` at most once, and `start` once. Re-renders change nothing.
 *  - **Approval is edge-triggered and re-arms.** The approval sound fires on the
 *    rising edge of the approval UI, and the latch only clears once the approval
 *    UI has actually gone away — so `asked → decided` cannot re-fire, and a
 *    second approval later in the same turn still gets its sound.
 *  - **A new turn needs a new observation of `running`.** After `done`, the
 *    machine sits in `done` until `running` comes back; `done` cannot repeat.
 *  - **Error outranks done.** A turn that ended in an error must not also play
 *    the completion sound.
 *
 * Task identity is handled explicitly. When the signal layer can name the
 * current task (`taskKey`), a change of key is treated as a hard boundary: the
 * latches reset and, if the new task is already running, a `start` fires. When
 * it cannot — which is the common case, because ZCode's DOM does not expose a
 * stable task id — the machine deliberately errs toward *fewer* sounds: latches
 * persist across the whole session rather than risk a burst of duplicate
 * effects every time the renderer cannot tell two turns apart.
 */

import type { SfxEvent } from "../../prefs/types.js";

/** One reading of the renderer, taken by the signal layer. */
export interface Observation {
  /** The agent is working this instant. */
  running: boolean;
  /** The approval UI is asking the user something right now. */
  approval: boolean;
  /** An error or interruption is showing right now. */
  error: boolean;
  /**
   * Monotonic count of tool calls rendered in the current turn. Only increases
   * are meaningful; the machine compares against its own last reading.
   */
  toolCalls: number;
  /**
   * Monotonic count of reasoning/progress updates rendered in the current turn.
   * Only used by the status-text roller, never to make a sound.
   */
  progress: number;
  /**
   * A stable identity for the current task, when the DOM exposes one. Absent
   * means "unknown", never "same as before".
   */
  taskKey?: string;
}

export const EMPTY_OBSERVATION: Observation = {
  running: false,
  approval: false,
  error: false,
  toolCalls: 0,
  progress: 0,
};

export type Phase = "idle" | "running" | "approval" | "done" | "error";

export interface MachineOptions {
  /** Consecutive `running` observations required before a turn is believed. */
  entryTicks?: number;
  /** Consecutive quiet observations required before a turn is called finished. */
  exitTicks?: number;
  /** Per-event switches, mirroring the SFX preferences. */
  enabled?: Partial<Record<SfxEvent, boolean>>;
}

export const DEFAULT_ENTRY_TICKS = 2;
export const DEFAULT_EXIT_TICKS = 2;

export interface MachineState {
  phase: Phase;
  /** True once `start` has fired for the current turn. */
  startFired: boolean;
  /** True once `done` has fired for the current turn. */
  doneFired: boolean;
  /** True once `error` has fired for the current turn. */
  errorFired: boolean;
  /** True while the approval sound is latched off for the current ask. */
  approvalLatched: boolean;
  taskKey?: string;
  toolCalls: number;
  progress: number;
}

export class EventMachine {
  private readonly entryTicks: number;
  private readonly exitTicks: number;
  private readonly enabled: Partial<Record<SfxEvent, boolean>>;

  private phase: Phase = "idle";
  private runStreak = 0;
  private quietStreak = 0;
  private startFired = false;
  private doneFired = false;
  private errorFired = false;
  private approvalLatched = false;
  private sawApproval = false;
  private taskKey: string | undefined;
  private toolCalls = 0;
  private progress = 0;

  constructor(options: MachineOptions = {}) {
    this.entryTicks = Math.max(1, options.entryTicks ?? DEFAULT_ENTRY_TICKS);
    this.exitTicks = Math.max(1, options.exitTicks ?? DEFAULT_EXIT_TICKS);
    this.enabled = options.enabled ?? {};
  }

  /** The current phase, for the status roller and the settings panel. */
  get current(): Phase {
    return this.phase;
  }

  state(): MachineState {
    return {
      phase: this.phase,
      startFired: this.startFired,
      doneFired: this.doneFired,
      errorFired: this.errorFired,
      approvalLatched: this.approvalLatched,
      taskKey: this.taskKey,
      toolCalls: this.toolCalls,
      progress: this.progress,
    };
  }

  /** Resets every latch, as if the session had just loaded. */
  reset(): void {
    this.phase = "idle";
    this.runStreak = 0;
    this.quietStreak = 0;
    this.startFired = false;
    this.doneFired = false;
    this.errorFired = false;
    this.approvalLatched = false;
    this.sawApproval = false;
    this.taskKey = undefined;
    this.toolCalls = 0;
    this.progress = 0;
  }

  /**
   * Feeds one observation in and returns the events that should sound.
   *
   * Returns an empty array for the overwhelming majority of calls, which is the
   * point.
   */
  update(obs: Observation): SfxEvent[] {
    const events: SfxEvent[] = [];

    // A named task that differs from the last one is a hard boundary. When
    // neither side has a key, the comparison is skipped rather than guessed.
    if (obs.taskKey !== undefined && this.taskKey !== undefined && obs.taskKey !== this.taskKey) {
      this.resetTurnLatches();
    }
    if (obs.taskKey !== undefined) this.taskKey = obs.taskKey;

    // Tool calls: a strict increase is one or more new calls. A decrease means
    // the transcript was swapped (a different session, or a virtualised list
    // scrolling), which is not an event and only resets the baseline.
    if (obs.toolCalls < this.toolCalls) {
      this.toolCalls = obs.toolCalls;
    } else if (obs.toolCalls > this.toolCalls) {
      const delta = obs.toolCalls - this.toolCalls;
      this.toolCalls = obs.toolCalls;
      if (this.phase === "running" || this.phase === "approval") {
        // One sound per observation, not one per call: a burst of five parallel
        // tool calls is one moment of activity, not five.
        if (delta > 0 && this.isEnabled("tool")) events.push("tool");
      }
    }
    if (obs.progress > this.progress) this.progress = obs.progress;

    // --- running / idle streaks ------------------------------------------
    if (obs.running) {
      this.runStreak += 1;
      this.quietStreak = 0;
    } else {
      this.quietStreak += 1;
      this.runStreak = 0;
    }

    // --- error: edge-triggered, once per turn -----------------------------
    if (obs.error && !this.errorFired) {
      this.errorFired = true;
      this.phase = "error";
      if (this.isEnabled("error")) events.push("error");
      // The turn is over as far as sound is concerned; a `done` for the same
      // turn would be a lie.
      this.doneFired = true;
      return events;
    }

    // --- approval: rising edge, re-arms when the UI goes away --------------
    if (obs.approval) {
      this.sawApproval = true;
      if (!this.approvalLatched) {
        this.approvalLatched = true;
        this.phase = "approval";
        if (this.isEnabled("approval")) events.push("approval");
      } else if (this.phase === "running" && this.runStreak >= this.entryTicks) {
        // Already sounded for this ask; keep the phase reflecting the UI.
        this.phase = "approval";
      }
    } else if (this.sawApproval) {
      // The ask is gone. Re-arm so a later approval in the same turn is heard,
      // and let the turn continue.
      this.sawApproval = false;
      this.approvalLatched = false;
      if (this.phase === "approval") this.phase = this.runStreak > 0 ? "running" : this.phase;
    }

    // --- start: rising edge of a settled run ------------------------------
    if (this.runStreak >= this.entryTicks) {
      // A settled run that follows a finished turn is a **new turn**, and the
      // per-turn latches have to be cleared before it can sound. This is the
      // only reset that happens in production: the signal layer cannot name a
      // task (ZCode exposes no stable task id), so the "taskKey changed"
      // boundary above never triggers, and a machine that kept its latches would
      // fire once per renderer session and then go silent forever.
      //
      // An error only ends a turn once it has cleared. While an error is on
      // screen the turn is still the one that failed, however long the agent
      // keeps working, so re-arming there would replay the start sound
      // underneath a failure the user is already reading. `doneFired` is set by
      // the error path too (a failed turn must not also play the completion
      // sound), so checking it alone would treat every sample after an error as
      // a fresh turn.
      const previousTurnOver = !obs.error && (this.doneFired || this.errorFired);
      if (previousTurnOver) this.beginNewTurn();
      if (!this.startFired) {
        this.startFired = true;
        this.phase = "running";
        if (this.isEnabled("start")) events.push("start");
      } else if (this.phase !== "approval") {
        // Already running this turn; keep the phase honest without re-firing.
        this.phase = "running";
      }
    }

    // --- done: settled quiet after a run ----------------------------------
    if (this.quietStreak >= this.exitTicks && this.startFired && !this.doneFired) {
      this.doneFired = true;
      this.phase = "done";
      if (this.isEnabled("done")) events.push("done");
    } else if (this.quietStreak >= this.exitTicks && !this.startFired) {
      // Never observed a run: the session is simply idle.
      this.phase = "idle";
    }

    return events;
  }

  /**
   * Clears the once-per-turn latches so a following turn can sound.
   *
   * The rendered-content counters are deliberately **not** reset. They count
   * elements that exist in the transcript for the rest of the session, so
   * zeroing them would make the very next sample look like a large increase and
   * fire a spurious event for work that had already been reported. A different
   * *task*, by contrast, replaces the transcript, which is why
   * `resetTurnLatches` does clear them.
   */
  private beginNewTurn(): void {
    this.startFired = false;
    this.doneFired = false;
    this.errorFired = false;
    this.approvalLatched = false;
    this.sawApproval = false;
  }

  /** Clears the once-per-turn latches so an already-running task can re-fire. */
  private resetTurnLatches(): void {
    this.startFired = false;
    this.doneFired = false;
    this.errorFired = false;
    this.approvalLatched = false;
    this.sawApproval = false;
    this.runStreak = 0;
    this.quietStreak = 0;
    this.toolCalls = 0;
    this.progress = 0;
    if (this.phase !== "idle") this.phase = "running";
  }

  private isEnabled(event: SfxEvent): boolean {
    return this.enabled[event] !== false;
  }
}
