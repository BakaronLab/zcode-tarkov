/**
 * The client context: everything the injected modules are handed at start-up.
 *
 * Every surface (dock, pet, settings centre, status roller) receives this one
 * object rather than reaching for globals. That keeps the modules independently
 * constructible — a test can build a real context with a stubbed transport — and
 * it makes the wiring in `main.ts` the single place where the pieces are
 * connected, which is the only way to be sure the teardown path is complete.
 *
 * The preferences are held here as the single in-memory copy. Surfaces read
 * `context.prefs()` and write through `context.patchPrefs()`, which round-trips
 * to the service and then notifies every subscriber — so two UIs showing the
 * same setting cannot drift apart, and a write that the server clamped (a
 * slider pushed past its range) is reflected back rather than assumed.
 */

import type { AudioEngine } from "./audio.js";
import type { HostApi } from "./api.js";
import type { Prefs } from "../../prefs/types.js";

/** One place to draw the Tarkov-vs-neutral distinction. */
export type ClientTheme = "tarkov" | "neutral";

export interface ClientContext {
  api: HostApi;
  audio: AudioEngine;
  /** The current preferences. Never undefined: defaults are seeded at start-up. */
  prefs(): Prefs;
  /**
   * Applies a partial prefs patch and resolves with the server's stored result.
   *
   * Rejects when the service is unreachable, so a caller that needs to know
   * (an upload, a delete) can report it, while the sliders simply let the
   * rejection propagate into the shared error path.
   */
  patchPrefs(patch: unknown): Promise<Prefs>;
  /** Subscribes to preference changes. Returns an unsubscribe function. */
  onPrefs(listener: (prefs: Prefs) => void): () => void;
  /** Whether the client paints the Tarkov skin. */
  theme(): ClientTheme;
  /** Re-reads the theme from the appearance preference and repaints. */
  syncTheme(): void;
  /** A short-lived message near the dock. */
  toast(message: string): void;
  /** Reports a failure that the user should see, with a consistent wording. */
  toastError(err: unknown, fallback: string): void;
  /** The element every injected surface is parented to. */
  uiRoot(): HTMLElement;
}

/** Extracts a human message from an unknown throwable. */
export function errorMessage(err: unknown, fallback: string): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err.length > 0) return err;
  return fallback;
}
