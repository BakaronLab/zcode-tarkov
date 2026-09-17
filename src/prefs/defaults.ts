/**
 * The default preferences.
 *
 * Every default here is also the value a malformed or partially-written
 * `prefs.json` falls back to, field by field, so this module is the schema's
 * effective definition — `prefs.ts` only has to know how to coerce a bad value
 * back to what is written here.
 *
 * The two upstream-project rules that shape the numbers:
 *  - nothing is loud by default (SFX 0.55, BGM 0.35 against a 0.7 master), and
 *  - nothing is bundled: the voice pool is enabled but empty, and BGM is on but
 *    has no tracks until the user adds one, so a fresh install is silent rather
 *    than pretending to have content it cannot legally ship.
 */

import { TARKOV_ACCENT, TARKOV_BACKGROUND } from "../themes/palette.js";
import { DEFAULT_GREETING } from "../themes/tarkov.js";
import type { BannerPrefs, Prefs } from "./types.js";
import { PREFS_VERSION } from "./types.js";

/** The v0.1 band copy, kept verbatim so an upgrade does not silently reword it. */
export const DEFAULT_BANNER_TEXT = {
  line1: "ATTENTION! ZCODE TACTICAL INTERFACE ACTIVE",
  line2:
    "Experimental interface. Verify your task, tool calls and working tree before deployment.",
} as const;

export function defaultBanner(): BannerPrefs {
  return {
    // v0.1 always showed the band; v0.2 keeps that as the default, and the
    // switch exists so a user who finds it noisy can remove it completely.
    mode: "full",
    text1: DEFAULT_BANNER_TEXT.line1,
    text2: DEFAULT_BANNER_TEXT.line2,
    height: 56,
    opacity: 0.92,
  };
}

export function defaultPrefs(): Prefs {
  return {
    version: PREFS_VERSION,
    appearance: {
      colorMode: "tarkov",
      wallpaperVisible: false,
      blur: 0,
      dim: 22,
      fit: "cover",
      wallpaperPath: undefined,
      banner: defaultBanner(),
      // The shipped colours. While these two are unchanged the theme renders the
      // hand-tuned palette byte-for-byte; a derivation only runs once the user
      // actually picks a colour, so upgrading cannot shift anyone's theme.
      background: TARKOV_BACKGROUND,
      accent: TARKOV_ACCENT,
      greeting: {
        enabled: true,
        line1: DEFAULT_GREETING.line1,
        line2: DEFAULT_GREETING.line2,
      },
    },
    audio: {
      enabled: true,
      masterVolume: 0.7,
      bgm: {
        enabled: true,
        volume: 0.35,
        shuffle: true,
        repeat: "all",
        trackId: undefined,
        disabledTracks: [],
      },
      sfx: {
        enabled: true,
        volume: 0.55,
        // Every event starts on; `tool` is the noisy one and can be switched off
        // from the panel without touching the other four.
        events: { start: true, approval: true, done: true, error: true, tool: true },
      },
      voice: {
        enabled: true,
        volume: 0.75,
        chance: 1,
      },
    },
    pet: {
      enabled: true,
      scale: 84,
      opacity: 0.95,
      position: undefined,
      voiceOnClick: true,
    },
    status: {
      // Off by default, unlike every other subsystem, and for a specific
      // reason rather than caution in general: ZCode 3.12.3 exposes no stable
      // handle on the element that carries the running status text, so the
      // takeover resolves it structurally and cannot be proven safe on every
      // build. A feature that might not act is better shipped off, labelled in
      // the settings centre, and turned on deliberately — the alternative is a
      // silent no-op that users report as a bug. See
      // docs/dev/zcode-runtime-signals.md §3.6.
      enabled: false,
      language: "zh",
      triggers: { reasoning: true, tool: true, progress: true },
      anyTheme: false,
    },
  };
}

/**
 * The accent the panel and the injected CSS use for "this is the Tarkov mode"
 * affordances. Exported from here so the settings UI and the theme cannot drift.
 */
export { TARKOV_ACCENT };
