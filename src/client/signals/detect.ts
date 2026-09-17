/**
 * Reads ZCode's runtime state out of the renderer DOM.
 *
 * This module answers one question — *what is the agent doing right now?* — and
 * hands the answer to `EventMachine`, which decides whether that deserves a
 * sound. Splitting it that way is deliberate: the DOM is the part that a ZCode
 * update can break, and the state machine is the part that must stay correct
 * regardless, so the fragile half is isolated behind `Observation`.
 *
 * **Cost control.** The naive implementation — a deep `MutationObserver` on the
 * whole document that re-derives everything on every mutation — makes an idle
 * ZCode burn CPU, because the app mutates constantly. Instead:
 *
 *  - the observer watches a *bounded* region, not the document;
 *  - a mutation only sets a dirty flag;
 *  - a single sampling loop runs at most every `TICK_MS`, and only samples when
 *    the flag is set or the slow safety interval has elapsed.
 *
 * So the steady-state cost of an idle ZCode is one cheap timer, and the cost
 * while the agent works is bounded by the tick rate rather than by the mutation
 * rate.
 *
 * **Fail-soft.** Every probe is guarded and every selector list is a *list*: a
 * miss falls through to the next candidate and, when nothing matches, the module
 * reports "not running" rather than throwing. A ZCode update that renames a
 * class therefore costs the user sound effects until the table is updated — it
 * does not break the theme, the music, or the page.
 *
 * The selector tables below are the single place to update when ZCode changes.
 * Every entry in them was confirmed against a live ZCode 3.12.3.7463 renderer —
 * including, importantly, the entries that were *removed*: the previous draft of
 * this file guessed at `[data-slot="…"]` and `[aria-label="Stop"]` handles that
 * turned out never to match, and a selector that silently matches nothing is
 * worse than no selector, because it looks like it works. The provenance, the
 * state transition each signal was observed to move between, and the items that
 * could not be observed at all are recorded in
 * `docs/dev/zcode-runtime-signals.md`; keep the two in step.
 */

import type { Observation } from "./machine.js";

/** How often the sampler may run, in ms. The floor on reaction latency. */
export const TICK_MS = 400;

/**
 * How long after the last visible change the agent is still assumed to be
 * working. Chosen to comfortably exceed the gap between two rendered tokens on a
 * slow model while staying well under the machine's exit debounce, so a genuine
 * pause is still seen as a pause.
 */
export const ACTIVITY_WINDOW_MS = 2500;

/** The sampler also runs at least this often, even with no mutations at all. */
export const SAFETY_INTERVAL_MS = 2000;

/**
 * Containers the observer watches, most specific first.
 *
 * The transcript is where every relevant change happens; watching the document
 * would be both more expensive and noisier.
 */
export const ACTIVITY_ROOTS: readonly string[] = [
  '[data-testid="v4-timeline"]',
  '[data-testid="v4-pane-shell-workspace-main"]',
  'main',
];

/**
 * Elements whose presence means "the agent is working right now".
 *
 * The composer's action button *swaps* between send and stop with the run state,
 * which makes the stop control the single most reliable signal in the tree: it
 * only exists while the app has something to interrupt. Two independent
 * confirmations are carried alongside it, because a build that renames one test
 * id should not cost the user every sound effect.
 */
export const RUNNING_SELECTORS: readonly string[] = [
  '[data-testid="v4-stop"]',
  '[data-testid="v4-composer"][data-input-routing="enqueue"]',
  '[data-testid^="v4-turn-navigator-item-"][data-running="true"]',
  '[data-testid="chat-loading"][role="status"]',
];

/**
 * Elements whose presence means "the agent is waiting for the user".
 *
 * The approval is rendered *inline* in the transcript, not in a dialog — no
 * `role="alertdialog"` ever opens on 3.12.3 — so the option kind attributes are
 * the primary handle and the pending-tool trigger is the corroborating one.
 */
export const APPROVAL_SELECTORS: readonly string[] = [
  '[data-permission-option-kind]',
  '[data-testid^="tool-summary-trigger-permission:perm_"]',
];

/**
 * Elements whose presence means the turn failed or was interrupted.
 *
 * NOT OBSERVED on 3.12.3: an error turn was never reached during the
 * investigation, so these two are the only candidates the shipped bundle
 * suggests and neither has been seen rendered. The status machine treats a match
 * as authoritative and no match as "fine", which is the correct polarity for an
 * unverified signal — a build where these never match simply never plays the
 * error sound, and nothing else is affected.
 */
export const ERROR_SELECTORS: readonly string[] = [
  '[data-status="error"]',
  '[data-state="error"]',
  '[data-slot="error-banner"]',
];

/** Rendered tool calls, counted to detect that a call happened. */
export const TOOL_SELECTORS: readonly string[] = ['[data-testid^="chat-tool-call-block-"][data-tool-call-id]'];

/**
 * Rendered reasoning/progress rows, counted to detect that the turn advanced.
 *
 * The streaming-text marker is conditional — a turn that produces no reasoning
 * block has neither element — so a zero count here is normal, not a failure.
 */
export const PROGRESS_SELECTORS: readonly string[] = [
  '[data-reasoning-streaming-text="true"]',
  '[data-testid="chat-reasoning-trigger"]',
];

/** The first selector in a list that matches anything, and its match count. */
function countMatches(selectors: readonly string[], scope: ParentNode): number {
  for (const selector of selectors) {
    try {
      const found = scope.querySelectorAll(selector);
      if (found.length > 0) return found.length;
    } catch {
      // An unsupported selector is a programming error, not a runtime hazard;
      // move on to the next candidate rather than failing the sample.
      continue;
    }
  }
  return 0;
}

function anyMatch(selectors: readonly string[], scope: ParentNode): boolean {
  for (const selector of selectors) {
    try {
      if (scope.querySelector(selector)) return true;
    } catch {
      continue;
    }
  }
  return false;
}

/** The bounded region the observer watches, or undefined before it exists. */
function findActivityRoot(): Element | undefined {
  for (const selector of ACTIVITY_ROOTS) {
    try {
      const el = document.querySelector(selector);
      if (el) return el;
    } catch {
      continue;
    }
  }
  return undefined;
}

export interface SignalWatcherOptions {
  /** Receives every sample. Called at most once per tick. */
  onObservation(observation: Observation): void;
  /** Called when the turn advanced, for the status-text roller. */
  onProgress(kind: "reasoning" | "tool" | "progress"): void;
  /** Overrides the tick, for tests. */
  tickMs?: number;
}

export interface SignalWatcher {
  start(): void;
  stop(): void;
  /** Takes one reading now and returns it, without waiting for a tick. */
  sample(): Observation;
}

export function createSignalWatcher(options: SignalWatcherOptions): SignalWatcher {
  const tickMs = options.tickMs ?? TICK_MS;
  let observer: MutationObserver | undefined;
  let timer: number | null = null;
  let dirty = true;
  let lastMutationAt = 0;
  let lastSafetySampleAt = 0;
  let lastToolCalls = 0;
  let lastProgress = 0;
  let running = false;

  function sample(): Observation {
    const root: ParentNode = document;

    const toolCalls = countMatches(TOOL_SELECTORS, root);
    const progress = countMatches(PROGRESS_SELECTORS, root);
    const approval = anyMatch(APPROVAL_SELECTORS, root);
    const error = anyMatch(ERROR_SELECTORS, root);

    // "Running" is either explicitly signalled, or inferred from recent visible
    // activity. The explicit signal wins when it is present; the inference is
    // what keeps the feature working on a build where none of the explicit
    // selectors match.
    const explicit = anyMatch(RUNNING_SELECTORS, root);
    const recentActivity = Date.now() - lastMutationAt < ACTIVITY_WINDOW_MS;
    running = explicit || recentActivity;

    const observation: Observation = {
      running,
      approval,
      error,
      toolCalls,
      progress,
    };

    // Progress notifications are derived here rather than in the machine,
    // because only this layer knows the difference between "a tool call
    // appeared" and "the transcript was replaced".
    if (toolCalls > lastToolCalls) options.onProgress("tool");
    if (progress > lastProgress) options.onProgress("reasoning");
    lastToolCalls = toolCalls;
    lastProgress = progress;

    return observation;
  }

  function tick(): void {
    const now = Date.now();
    // Sample on a mutation, or on the slow safety interval — a turn can change
    // state (finish, fail) without mutating anything this observer sees.
    const due = now - lastSafetySampleAt >= SAFETY_INTERVAL_MS;
    if (!dirty && !due) return;
    dirty = false;
    lastSafetySampleAt = now;
    let observation: Observation;
    try {
      observation = sample();
    } catch {
      // A sample must never throw into the timer; the caller would stop
      // receiving observations entirely.
      return;
    }
    try {
      options.onObservation(observation);
    } catch {
      /* a consumer failure must not stop the watcher */
    }
  }

  return {
    start(): void {
      if (timer !== null) return;
      const root = findActivityRoot();
      try {
        if (typeof MutationObserver === "function") {
          observer = new MutationObserver(() => {
            dirty = true;
            lastMutationAt = Date.now();
          });
          // Bounded: the transcript subtree, not the document. `characterData`
          // is included because streamed text often changes in place rather
          // than by inserting nodes.
          observer.observe(root ?? document.documentElement, {
            childList: true,
            subtree: true,
            characterData: true,
          });
        }
      } catch {
        observer = undefined;
      }
      // The interval is the only timer; the observer just sets a flag. Nothing
      // here polls faster than `tickMs`.
      timer = setInterval(tick, tickMs) as unknown as number;
      tick();
    },

    stop(): void {
      try {
        observer?.disconnect();
      } catch {
        /* already disconnected */
      }
      observer = undefined;
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    },

    sample,
  };
}
