/**
 * The v0.2 preferences schema.
 *
 * v0.1 kept a flat `config.json` under the plugin's own data directory holding
 * only appearance. v0.2 adds audio, pet and status, and those settings have to
 * outlive a ZCode update — which can replace the plugin data directory — so the
 * whole schema moved to a file the user owns:
 *
 *   %LOCALAPPDATA%\zcode-tarkov\data\prefs.json
 *
 * `appearance` carries the same fields v0.1 stored, with the same names and the
 * same units, so migration is a field-by-field copy and nothing is reinterpreted
 * on the way across.
 */

/** The subdirectories of the user data root that hold media. */
export const MEDIA_KINDS = ["music", "sounds", "voice", "pet", "status"] as const;
export type MediaKind = (typeof MEDIA_KINDS)[number];

/** The events that can play a sound effect. */
export const SFX_EVENTS = ["start", "approval", "done", "error", "tool"] as const;
export type SfxEvent = (typeof SFX_EVENTS)[number];

/** How the top tactical band is painted. */
export const BANNER_MODES = ["off", "compact", "full"] as const;
export type BannerMode = (typeof BANNER_MODES)[number];

export const COLOR_MODES = ["monet", "tarkov", "native"] as const;
export type ColorModeName = (typeof COLOR_MODES)[number];

export const WALLPAPER_FITS = ["cover", "contain", "smart"] as const;
export type WallpaperFitName = (typeof WALLPAPER_FITS)[number];

export const STATUS_LANGUAGES = ["zh", "en"] as const;
export type StatusLanguage = (typeof STATUS_LANGUAGES)[number];

/** What re-rolls the status phrase while a task is running. */
export const STATUS_TRIGGERS = ["reasoning", "tool", "progress"] as const;
export type StatusTrigger = (typeof STATUS_TRIGGERS)[number];

export interface BannerPrefs {
  /** `off` removes the band entirely and releases the space it reserved. */
  mode: BannerMode;
  text1: string;
  text2: string;
  /** Reserved band height in px for `full`; `compact` uses a fixed thin strip. */
  height: number;
  opacity: number;
}

/**
 * The beta notice drawn in place of the empty-chat greeting.
 *
 * Editable because it is the first thing a user sees and the one piece of copy
 * in the product they are most likely to want in their own words. `enabled:
 * false` omits the takeover entirely so ZCode's own greeting returns.
 */
export interface GreetingPrefs {
  enabled: boolean;
  line1: string;
  line2: string;
}

export interface AppearancePrefs {
  colorMode: ColorModeName;
  wallpaperVisible: boolean;
  blur: number;
  dim: number;
  fit: WallpaperFitName;
  /** Absolute path to the stored wallpaper, or undefined when none is set. */
  wallpaperPath?: string;
  banner: BannerPrefs;
  /**
   * The base surface colour, as `#rrggbb`.
   *
   * Everything else in the palette is derived from it, so one picker changes the
   * whole theme coherently instead of leaving warm-brown panels under a colour
   * they no longer match. The shipped value is returned untouched while it is
   * unchanged, so an install that never touches this renders exactly as before.
   */
  background: string;
  /**
   * The accent, as `#rrggbb`. Borders, focus rings, active states, the band and
   * the greeting badge all resolve to it.
   */
  accent: string;
  /** The greeting notice, in the user's own words if they want. */
  greeting: GreetingPrefs;
}

export interface BgmPrefs {
  enabled: boolean;
  volume: number;
  shuffle: boolean;
  /** `all` loops the playlist, `one` repeats the current track. */
  repeat: "all" | "one";
  /** Basename of the track to resume, so a reload does not lose the position. */
  trackId?: string;
  /**
   * Basenames the user switched off.
   *
   * Stored as an opt-out list rather than a per-track flag on disk so that
   * dropping a new file into `music/` makes it available immediately, with no
   * registration step and nothing to keep in sync.
   */
  disabledTracks: string[];
}

export interface SfxPrefs {
  enabled: boolean;
  volume: number;
  /** Per-event switches; a missing key means "use the default (on)". */
  events: Record<string, boolean>;
}

export interface VoicePrefs {
  enabled: boolean;
  volume: number;
  /** Probability, 0-1, that a pet click says something. */
  chance: number;
}

export interface AudioPrefs {
  enabled: boolean;
  masterVolume: number;
  bgm: BgmPrefs;
  sfx: SfxPrefs;
  voice: VoicePrefs;
}

export interface PetPrefs {
  enabled: boolean;
  /** Rendered width in px; the image keeps its aspect ratio. */
  scale: number;
  opacity: number;
  /** Last dragged position; undefined means "use the default corner". */
  position?: { x: number; y: number };
  /** Clicking the pet can play a random clip from the voice pool. */
  voiceOnClick: boolean;
}

export interface StatusPrefs {
  enabled: boolean;
  language: StatusLanguage;
  triggers: Record<string, boolean>;
  /**
   * Whether the status takeover also applies outside Tarkov mode.
   *
   * Off by default, and deliberately explicit: the status line is ZCode's own
   * live feedback, and a user who switched to Monet or Native has asked for
   * ZCode's colours back. Rewriting their status text because a *different*
   * mode's setting was left on is the kind of cross-theme leak that makes a
   * theme plugin feel untrustworthy, so it needs its own switch.
   */
  anyTheme: boolean;
}

export interface Prefs {
  version: number;
  appearance: AppearancePrefs;
  audio: AudioPrefs;
  pet: PetPrefs;
  status: StatusPrefs;
}

/** The current on-disk schema version. */
export const PREFS_VERSION = 2;
