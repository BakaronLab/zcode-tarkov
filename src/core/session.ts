/**
 * Shared high-level operations used by both the CLI and the MCP server.
 */

import fs from "node:fs";
import path from "node:path";
import { applyToZCode, buildPayload, DEFAULT_CONFIG, loadWallpaper, resetZCode, type BeautifyConfig, type BuiltPayload } from "./inject.js";
import { dataDir, loadConfig, saveConfig } from "./launch.js";
import { legacyMonetFlag, migrateColorMode, type ColorMode } from "./colorMode.js";

export interface ApplyOptions {
  port?: number;
  blur?: number;
  dim?: number;
  /** Legacy flag; only consulted when `colorMode` is not given. */
  monet?: boolean;
  colorMode?: ColorMode;
  wallpaperVisible?: boolean;
  fit?: "cover" | "contain" | "smart";
}

/**
 * Merges stored config with explicit options. `colorMode` wins over the legacy
 * boolean, and `monet` is always re-derived so the two never disagree.
 */
function mergedConfig(opts: ApplyOptions, stored = loadConfig()): BeautifyConfig {
  const colorMode =
    opts.colorMode ??
    (typeof opts.monet === "boolean" ? (opts.monet ? "monet" : "native") : migrateColorMode(stored));
  return {
    ...DEFAULT_CONFIG,
    ...stored,
    port: opts.port ?? stored.port ?? DEFAULT_CONFIG.port,
    blur: opts.blur ?? stored.blur ?? DEFAULT_CONFIG.blur,
    dim: opts.dim ?? stored.dim ?? DEFAULT_CONFIG.dim,
    colorMode,
    monet: legacyMonetFlag(colorMode),
    wallpaperVisible: opts.wallpaperVisible ?? stored.wallpaperVisible ?? DEFAULT_CONFIG.wallpaperVisible,
    fit: opts.fit ?? stored.fit ?? DEFAULT_CONFIG.fit,
    banner: { ...DEFAULT_CONFIG.banner, ...(stored.banner ?? {}) },
  };
}

/** Applies (or refreshes) the theme using the stored config. */
export async function reapplyStored(): Promise<number> {
  const config = mergedConfig({});
  return applyToZCode(config, await buildPayloadFromConfig(config));
}

export async function applyWallpaper(imagePath: string, opts: ApplyOptions): Promise<{ windows: number; config: BeautifyConfig }> {
  const abs = path.resolve(imagePath);
  if (!fs.existsSync(abs)) throw new Error(`Image not found: ${abs}`);

  const config = mergedConfig(opts);

  // Keep a copy of the wallpaper inside the data dir so the theme survives
  // the original file being moved/deleted.
  fs.mkdirSync(dataDir(), { recursive: true });
  const dest = path.join(dataDir(), "wallpaper" + path.extname(abs).toLowerCase());
  if (dest !== abs) fs.copyFileSync(abs, dest);

  const assets = await loadWallpaper(dest);
  const payload = buildPayload(config, assets);
  // Persist first: even if the app is not running yet, `launch` + `refresh_theme`
  // can pick the stored theme up later.
  saveConfig({ ...config, wallpaperPath: dest });

  const windows = await applyToZCode(config, payload);
  return { windows, config };
}

export async function applyColorsOnly(opts: ApplyOptions): Promise<number> {
  const config = mergedConfig(opts);
  saveConfig(config);
  return applyToZCode(config, await buildPayloadFromConfig(config));
}

export async function resetAppearance(port?: number): Promise<number> {
  const stored = loadConfig();
  await resetZCode(port ?? stored.port ?? DEFAULT_CONFIG.port);
  saveConfig({ ...stored, wallpaperPath: undefined });
  return 0;
}

export async function buildPayloadFromConfig(config: BeautifyConfig): Promise<BuiltPayload> {
  let assets;
  if (config.wallpaperPath && fs.existsSync(config.wallpaperPath)) {
    assets = await loadWallpaper(config.wallpaperPath);
  }
  return buildPayload(config, assets);
}
