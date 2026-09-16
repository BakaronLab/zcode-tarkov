/**
 * Color-mode model.
 *
 * Upstream zcode-beautify stored a single boolean (`monet`), which cannot
 * express "fixed Tarkov palette" as a third state. `colorMode` supersedes it.
 *
 * The legacy boolean is still *read* (so existing configs keep working) and
 * still *written* (so an older build of the plugin reading the same config file
 * keeps behaving sensibly). Neither direction is guessing: `monet: true` means
 * the wallpaper-derived palette, `monet: false` means ZCode's own colors.
 */

export type ColorMode = "monet" | "tarkov" | "native";

export const COLOR_MODES: readonly ColorMode[] = ["monet", "tarkov", "native"] as const;

/** Matches the upstream default (`monet: true`). */
export const DEFAULT_COLOR_MODE: ColorMode = "monet";

export function isColorMode(value: unknown): value is ColorMode {
  return typeof value === "string" && (COLOR_MODES as readonly string[]).includes(value);
}

/**
 * Resolves the effective mode from a stored (possibly legacy) config.
 * Unknown or malformed values fall back to the default rather than throwing.
 */
export function migrateColorMode(
  stored: { colorMode?: unknown; monet?: unknown } | null | undefined
): ColorMode {
  if (isColorMode(stored?.colorMode)) return stored.colorMode;
  if (stored && typeof stored.monet === "boolean") return stored.monet ? "monet" : "native";
  return DEFAULT_COLOR_MODE;
}

/** True when the legacy boolean must be persisted alongside `colorMode`. */
export function legacyMonetFlag(mode: ColorMode): boolean {
  return mode === "monet";
}

export interface ColorModeCarrier {
  colorMode?: unknown;
  monet?: unknown;
}

/**
 * Normalizes a stored config in place (by copy): derives `colorMode` from the
 * legacy flag when it is missing, and re-derives `monet` from the mode so both
 * fields always agree on disk. Reading a pre-0.1 config therefore never throws
 * and never silently changes the user's appearance.
 */
export function withColorMode<T extends ColorModeCarrier>(
  stored: T
): T & { colorMode: ColorMode; monet: boolean } {
  const mode = migrateColorMode(stored);
  return { ...stored, colorMode: mode, monet: legacyMonetFlag(mode) };
}
