/**
 * The interfaces the injected surfaces consume each other through.
 *
 * The settings centre is one window onto five subsystems it does not own, and
 * the dock is a second window onto one of them. Declaring those seams here —
 * rather than letting the panel import the player and the player import the
 * panel — keeps every module constructible on its own and makes the wiring in
 * `main.ts` the single place where the object graph is assembled.
 *
 * The rule these interfaces encode: a control object never returns data
 * directly for anything that can change on its own. Live values are read from
 * `state()` and pushed through `onState()`, so the dock, the panel and the
 * status roller cannot show three different ideas of what is playing.
 */

import type { Prefs } from "../prefs/types.js";

// --- background music --------------------------------------------------------

export interface BgmTrack {
  id: string;
  displayName: string;
  enabled: boolean;
  size: number;
  durationSeconds?: number;
}

export interface BgmState {
  /** Empty when nothing is loaded. */
  trackId?: string;
  title: string;
  /** True while audio is actually advancing. */
  playing: boolean;
  /** True when the autoplay policy is holding the context suspended. */
  locked: boolean;
  /** True when this renderer is the playback leader. */
  leader: boolean;
  positionSeconds: number;
  durationSeconds: number;
  volume: number;
  shuffle: boolean;
  repeat: "all" | "one";
  /** Every track in `music/`, including disabled ones. */
  tracks: BgmTrack[];
  /** True when `music/` holds no playable track at all. */
  empty: boolean;
}

export interface BgmControl {
  state(): BgmState;
  /** Subscribes to state changes; returns an unsubscribe function. */
  onState(listener: (state: BgmState) => void): () => void;
  play(): void;
  pause(): void;
  toggle(): void;
  next(): void;
  prev(): void;
  select(id: string): void;
  setVolume(volume: number): void;
  setShuffle(on: boolean): void;
  setRepeat(repeat: "all" | "one"): void;
  /** Seeks to a fraction of the track, 0-1. */
  seek(fraction: number): void;
  /** Re-reads the library from the service. */
  refresh(): Promise<void>;
  /** Uploads one file, reporting progress as a 0-1 fraction. */
  upload(file: File, onProgress?: (fraction: number) => void): Promise<void>;
  remove(name: string): Promise<void>;
  toggleTrack(name: string, enabled?: boolean): Promise<void>;
}

// --- pet ---------------------------------------------------------------------

export interface PetControl {
  /** Puts the pet back in its default corner and persists that. */
  resetPosition(): void;
  /** Re-reads the voice pool from the service. Returns the new size. */
  refreshVoicePool(): Promise<number>;
  /** How many voice clips the pool currently holds. */
  voicePoolSize(): number;
}

// --- status text -------------------------------------------------------------

export interface StatusControl {
  /** Re-reads the phrase pool from the service. Returns the phrase count. */
  reload(): Promise<number>;
  /** Where the current pool came from. */
  poolSource(): "user" | "bundled" | "unknown";
  /** The phrase currently shown, if the roller is active. */
  currentPhrase(): string | undefined;
}

// --- shared ------------------------------------------------------------------

/**
 * The two functions every surface uses to persist a preference change.
 *
 * `patch` resolves with the stored prefs (already clamped by the server);
 * `local` updates only the in-memory copy, for a value being dragged where a
 * round-trip per pixel would be wasteful. A drag ends with one `patch`.
 */
export interface PrefsWriter {
  patch(patch: DeepPartial<Prefs>): Promise<Prefs>;
  local(patch: DeepPartial<Prefs>): void;
}

export type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends readonly unknown[] ? T[K] : T[K] extends object ? DeepPartial<T[K]> : T[K];
};
