/**
 * Loading, validating, migrating and saving the v0.2 preferences.
 *
 * The contract this module exists to keep: **a bad `prefs.json` can never take
 * the service down.** The file is hand-editable by design (the README tells
 * users where it is), so every failure mode is expected rather than
 * exceptional — a truncated write, a BOM from Notepad, a string where a number
 * belongs, a value far outside its range, a file from a future version, or a
 * v0.1 `config.json` that predates this schema entirely.
 *
 * The rules, in order:
 *  - Unparseable JSON is preserved as a `.bak-<timestamp>` file and replaced by
 *    defaults, so the user can recover whatever they meant to write.
 *  - Wrong types fall back to the default for that field alone; the rest of the
 *    file still loads.
 *  - Numbers are clamped to their documented range rather than rejected, so a
 *    slider that somehow stored 1e9 becomes 100, not an outage.
 *  - Unknown keys are dropped: the schema is closed, and silently carrying
 *    forward keys from an older build is how dead settings accumulate.
 *  - A missing `prefs.json` next to an existing v0.1 `config.json` is migrated
 *    field by field, and the legacy file is left in place untouched.
 */

import fs from "node:fs";
import path from "node:path";
import { dataRoot, ensureDataRoot, prefsFile } from "../core/dataRoot.js";
import { isSafeBasename } from "../media/paths.js";
import { parseHex, toHex } from "../themes/palette.js";
import { defaultBanner, defaultPrefs } from "./defaults.js";
import {
  BANNER_MODES,
  COLOR_MODES,
  MEDIA_KINDS,
  PREFS_VERSION,
  SFX_EVENTS,
  STATUS_LANGUAGES,
  STATUS_TRIGGERS,
  WALLPAPER_FITS,
  type BannerPrefs,
  type AppearancePrefs,
  type Prefs,
} from "./types.js";

/** A parsed JSON file, read with the same tolerance as the rest of the plugin. */
function readJson(file: string): unknown {
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Clamps to `[min, max]`, mapping anything non-finite to the default. */
export function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Returns `value` when it is one of `allowed`, else `fallback`. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * A bounded, sanitised string. Control characters are stripped because these
 * values are injected into the renderer as JSON literals and rendered as text;
 * a stray NUL or newline in a banner line has no legitimate use and only makes
 * failures harder to read.
 */
function text(value: unknown, maxLength: number, fallback: string): string {
  if (typeof value !== "string") return fallback;
  /* eslint-disable-next-line no-control-regex */
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (cleaned.length === 0) return fallback;
  return cleaned.length > maxLength ? cleaned.slice(0, maxLength) : cleaned;
}

/** `{ x, y }` in viewport pixels, or undefined when absent/unusable. */
function position(value: unknown): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const x = Number(value.x);
  const y = Number(value.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
  return { x: Math.round(x), y: Math.round(y) };
}

/**
 * A list of media basenames, deduplicated and bounded.
 *
 * The names are re-checked by the same rules the filesystem layer uses: a
 * hand-edited `prefs.json` is just another untrusted input, and a preference
 * naming `../../something` must not become a path anywhere downstream.
 */
function nameList(value: unknown, limit = 2000): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    if (!isSafeBasename(entry)) continue;
    seen.add(entry);
    if (seen.size >= limit) break;
  }
  return [...seen];
}

/** Per-event switches: known events only, each defaulting to enabled. */
function eventSwitches(value: unknown, allowed: readonly string[], fallback: Record<string, boolean>): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const key of allowed) {
    out[key] = isRecord(value) && typeof value[key] === "boolean" ? (value[key] as boolean) : fallback[key] !== false;
  }
  return out;
}

export function validateBanner(raw: unknown): BannerPrefs {
  const d = defaultBanner();
  if (!isRecord(raw)) return d;
  return {
    mode: oneOf(raw.mode, BANNER_MODES, d.mode),
    text1: text(raw.text1, 240, d.text1),
    text2: text(raw.text2, 400, d.text2),
    height: Math.round(clampNumber(raw.height, 24, 160, d.height)),
    opacity: clampNumber(raw.opacity, 0, 1, d.opacity),
  };
}

/**
 * A colour, as a normalised `#rrggbb`, or the fallback.
 *
 * Normalising rather than merely accepting matters: `#ABC` and `#aabbcc` are the
 * same colour, and storing both spellings means two identical settings compare
 * unequal — which would make the palette look customised when it is not, and
 * break the "unchanged defaults render identically" property.
 */
function color(value: unknown, fallback: string): string {
  const parsed = parseHex(value);
  return parsed ? toHex(parsed) : fallback;
}

function validateGreeting(raw: unknown): AppearancePrefs["greeting"] {
  const d = defaultPrefs().appearance.greeting;
  if (!isRecord(raw)) return d;
  return {
    enabled: boolOr(raw.enabled, d.enabled),
    line1: text(raw.line1, 240, d.line1),
    line2: text(raw.line2, 400, d.line2),
  };
}

export function validateAppearance(raw: unknown): AppearancePrefs {
  const d = defaultPrefs().appearance;
  if (!isRecord(raw)) return d;
  const wallpaperPath =
    typeof raw.wallpaperPath === "string" && raw.wallpaperPath.trim().length > 0
      ? raw.wallpaperPath
      : undefined;
  return {
    colorMode: oneOf(raw.colorMode, COLOR_MODES, d.colorMode),
    wallpaperVisible: boolOr(raw.wallpaperVisible, d.wallpaperVisible),
    blur: clampNumber(raw.blur, 0, 100, d.blur),
    dim: clampNumber(raw.dim, 0, 100, d.dim),
    fit: oneOf(raw.fit, WALLPAPER_FITS, d.fit),
    wallpaperPath,
    banner: validateBanner(raw.banner),
    background: color(raw.background, d.background),
    accent: color(raw.accent, d.accent),
    greeting: validateGreeting(raw.greeting),
  };
}

export function validateAudio(raw: unknown): Prefs["audio"] {
  const d = defaultPrefs().audio;
  if (!isRecord(raw)) return d;
  const bgm = isRecord(raw.bgm) ? raw.bgm : {};
  const sfx = isRecord(raw.sfx) ? raw.sfx : {};
  const voice = isRecord(raw.voice) ? raw.voice : {};
  return {
    enabled: boolOr(raw.enabled, d.enabled),
    masterVolume: clampNumber(raw.masterVolume, 0, 1, d.masterVolume),
    bgm: {
      enabled: boolOr(bgm.enabled, d.bgm.enabled),
      volume: clampNumber(bgm.volume, 0, 1, d.bgm.volume),
      shuffle: boolOr(bgm.shuffle, d.bgm.shuffle),
      repeat: bgm.repeat === "one" ? "one" : d.bgm.repeat,
      trackId: typeof bgm.trackId === "string" && bgm.trackId.length > 0 ? bgm.trackId : undefined,
      disabledTracks: nameList(bgm.disabledTracks),
    },
    sfx: {
      enabled: boolOr(sfx.enabled, d.sfx.enabled),
      volume: clampNumber(sfx.volume, 0, 1, d.sfx.volume),
      events: eventSwitches(sfx.events, SFX_EVENTS, d.sfx.events),
    },
    voice: {
      enabled: boolOr(voice.enabled, d.voice.enabled),
      volume: clampNumber(voice.volume, 0, 1, d.voice.volume),
      chance: clampNumber(voice.chance, 0, 1, d.voice.chance),
    },
  };
}

export function validatePet(raw: unknown): Prefs["pet"] {
  const d = defaultPrefs().pet;
  if (!isRecord(raw)) return d;
  return {
    enabled: boolOr(raw.enabled, d.enabled),
    scale: Math.round(clampNumber(raw.scale, 24, 320, d.scale)),
    opacity: clampNumber(raw.opacity, 0.1, 1, d.opacity),
    position: position(raw.position),
    voiceOnClick: boolOr(raw.voiceOnClick, d.voiceOnClick),
  };
}

export function validateStatus(raw: unknown): Prefs["status"] {
  const d = defaultPrefs().status;
  if (!isRecord(raw)) return d;
  return {
    enabled: boolOr(raw.enabled, d.enabled),
    language: oneOf(raw.language, STATUS_LANGUAGES, d.language),
    triggers: eventSwitches(raw.triggers, STATUS_TRIGGERS, d.triggers),
    anyTheme: boolOr(raw.anyTheme, d.anyTheme),
  };
}

/** Validates a whole prefs document, filling every gap from the defaults. */
export function validatePrefs(raw: unknown): Prefs {
  if (!isRecord(raw)) return defaultPrefs();
  return {
    version: PREFS_VERSION,
    appearance: validateAppearance(raw.appearance),
    audio: validateAudio(raw.audio),
    pet: validatePet(raw.pet),
    status: validateStatus(raw.status),
  };
}

/**
 * The v0.1 flat config, as `config.json` stored it.
 *
 * Only the v0.1 keys are read; `port` is deliberately dropped, because the CDP
 * port is a launch-time flag and a stored copy of it was already documented as
 * not being a persisted setting.
 */
export interface LegacyV01Config {
  blur?: unknown;
  dim?: unknown;
  monet?: unknown;
  colorMode?: unknown;
  wallpaperVisible?: unknown;
  fit?: unknown;
  wallpaperPath?: unknown;
  banner?: unknown;
}

/**
 * Maps a v0.1 config onto the v0.2 appearance section.
 *
 * This is a pure function so migration is testable without touching a disk. The
 * v0.1 banner had an `enabled` boolean where v0.2 has a three-valued `mode`;
 * `enabled: false` becomes `mode: "off"` and `enabled: true` becomes `"full"`,
 * which is exactly what the v0.1 UI meant.
 */
export function migrateV01Appearance(legacy: LegacyV01Config | undefined): AppearancePrefs {
  const d = defaultPrefs().appearance;
  if (!isRecord(legacy)) return d;

  const legacyBanner = isRecord(legacy.banner) ? legacy.banner : undefined;
  const banner: BannerPrefs = legacyBanner
    ? {
        mode: legacyBanner.enabled === false ? "off" : "full",
        text1: text(legacyBanner.text1, 240, d.banner.text1),
        text2: text(legacyBanner.text2, 400, d.banner.text2),
        height: Math.round(clampNumber(legacyBanner.height, 24, 160, d.banner.height)),
        opacity: clampNumber(legacyBanner.opacity, 0, 1, d.banner.opacity),
      }
    : d.banner;

  // v0.1 could store only the legacy `monet` boolean; `colorMode` is preferred
  // when present, exactly as the v0.1 resolver did.
  const colorMode =
    legacy.colorMode !== undefined
      ? oneOf(legacy.colorMode, COLOR_MODES, d.colorMode)
      : typeof legacy.monet === "boolean"
        ? legacy.monet
          ? "monet"
          : "native"
        : d.colorMode;

  return {
    colorMode,
    wallpaperVisible: boolOr(legacy.wallpaperVisible, d.wallpaperVisible),
    blur: clampNumber(legacy.blur, 0, 100, d.blur),
    dim: clampNumber(legacy.dim, 0, 100, d.dim),
    fit: oneOf(legacy.fit, WALLPAPER_FITS, d.fit),
    wallpaperPath:
      typeof legacy.wallpaperPath === "string" && legacy.wallpaperPath.trim().length > 0
        ? legacy.wallpaperPath
        : undefined,
    banner,
    // The v0.1 file had no concept of a custom palette or an editable greeting,
    // so a migrated install keeps the shipped colours and the shipped notice —
    // which is exactly what it was showing before the upgrade.
    background: d.background,
    accent: d.accent,
    greeting: d.greeting,
  };
}

function timestampSuffix(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Moves a file aside when it could not be parsed.
 *
 * Best effort by design: if the copy fails there is nothing useful left to try,
 * and refusing to continue would turn a broken settings file into a plugin that
 * will not start.
 */
function quarantine(file: string): string | undefined {
  try {
    if (!fs.existsSync(file)) return undefined;
    const dest = `${file}.bak-${timestampSuffix()}`;
    fs.copyFileSync(file, dest);
    return dest;
  } catch {
    return undefined;
  }
}

export interface LoadPrefsResult {
  prefs: Prefs;
  /** Set when the file had to be replaced, for logging by the caller. */
  recovered?: { reason: string; backup?: string };
  /** Set when the values came from a v0.1 config rather than a v0.2 file. */
  migratedFrom?: string;
}

/**
 * Loads the preferences, migrating or recovering as needed.
 *
 * `legacyConfigPath` is passed in rather than resolved here so this module does
 * not have to import the plugin's own data-directory logic — which imports this
 * one, and would otherwise close an import cycle.
 */
export function loadPrefs(legacyConfigPath?: string): LoadPrefsResult {
  const file = prefsFile();
  const raw = readJson(file);

  if (raw === undefined) {
    // Distinguish "no file" from "a file that would not parse": only the latter
    // is worth preserving, and only the former is worth migrating into.
    if (fs.existsSync(file)) {
      const backup = quarantine(file);
      return {
        prefs: defaultPrefs(),
        recovered: { reason: "prefs.json could not be parsed; defaults restored", backup },
      };
    }
    if (legacyConfigPath && fs.existsSync(legacyConfigPath)) {
      const legacyRaw = readJson(legacyConfigPath);
      if (isRecord(legacyRaw)) {
        const base = defaultPrefs();
        return {
          prefs: { ...base, appearance: migrateV01Appearance(legacyRaw as LegacyV01Config) },
          migratedFrom: legacyConfigPath,
        };
      }
    }
    return { prefs: defaultPrefs() };
  }

  return { prefs: validatePrefs(raw) };
}

/** Serialises prefs deterministically, so a rewrite is a no-op diff. */
export function serializePrefs(prefs: Prefs): string {
  return `${JSON.stringify(prefs, null, 2)}\n`;
}

/**
 * Writes prefs atomically: a temp file in the same directory is renamed over the
 * target, so a crash mid-write cannot leave a half-written settings file behind
 * — which is the failure that would otherwise require the user to delete it by
 * hand.
 */
export function savePrefs(prefs: Prefs): void {
  const root = ensureDataRoot();
  const file = prefsFile();
  const tmp = path.join(root, `.prefs.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, serializePrefs(prefs));
  fs.renameSync(tmp, file);
}

/** The media subdirectories, for the System section of the settings panel. */
export function mediaSubdirs(): { kind: string; path: string }[] {
  return MEDIA_KINDS.map((kind) => ({ kind, path: path.join(dataRoot(), kind) }));
}
