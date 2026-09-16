/**
 * Assembles the full injected payload: wallpaper layer CSS + variable
 * overrides, plus helpers to apply a theme to a running ZCode instance.
 */

import { CdpConnection, injectIntoTarget, listTargets, pickRendererTargets, buildResetScript } from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";
import { buildTarkovVariableOverrides, buildTarkovComponentCss } from "../themes/tarkov.js";
import { DEFAULT_COLOR_MODE, type ColorMode } from "./colorMode.js";
import { DEFAULT_BANNER, type BannerOptions } from "./banner.js";

export type WallpaperFit = "cover" | "contain" | "smart";

export interface BeautifyConfig {
  port: number;
  wallpaperPath?: string;
  blur: number;
  dim: number;
  /**
   * Legacy boolean. Always kept in sync with `colorMode` on disk; read it only
   * for backwards compatibility.
   */
  monet: boolean;
  /** Which palette drives the UI: wallpaper-derived, fixed Tarkov, or untouched. */
  colorMode: ColorMode;
  wallpaperVisible: boolean;
  fit: WallpaperFit;
  /** Tarkov-only beta banner. Ignored in the other modes. */
  banner: BannerOptions;
}

export const DEFAULT_CONFIG: BeautifyConfig = {
  port: 9222,
  blur: 0,
  dim: 25,
  monet: true,
  colorMode: DEFAULT_COLOR_MODE,
  wallpaperVisible: true,
  fit: "cover",
  banner: DEFAULT_BANNER,
};

export interface BuiltPayload {
  css: string;
  wallpaperDataUri?: string;
  /** How the wallpaper layer is framed; "contain" adds a blurred backdrop. */
  fit: "cover" | "contain";
  /** Normalized focus point for background-position. */
  focusX: number;
  focusY: number;
  /** Banner to install, or null to tear any existing one down. */
  banner: BannerOptions | null;
}

/**
 * Resolves the effective color mode. Configs written before `colorMode`
 * existed can still reach here (e.g. via an in-memory object), so the legacy
 * boolean is honored as a fallback rather than assumed absent.
 */
export function resolveColorMode(config: Pick<BeautifyConfig, "colorMode" | "monet">): ColorMode {
  return config.colorMode ?? (config.monet ? "monet" : "native");
}

/** The banner is a Tarkov-mode feature only; other modes tear it down. */
export function resolveBanner(config: BeautifyConfig): BannerOptions | null {
  if (resolveColorMode(config) !== "tarkov") return null;
  const banner = config.banner ?? DEFAULT_BANNER;
  return banner.enabled ? banner : null;
}

export function buildPayload(config: BeautifyConfig, assets?: WallpaperAssets): BuiltPayload {
  const parts: string[] = [];

  // "smart" resolves to the analyzed suggestion at build time, so the injected
  // CSS only ever deals with cover or contain.
  const resolved: "cover" | "contain" =
    config.fit === "smart" ? (assets?.focus.fit ?? "cover") : config.fit === "contain" ? "contain" : "cover";
  const focusX = config.fit === "smart" ? (assets?.focus.x ?? 0.5) : 0.5;
  const focusY = config.fit === "smart" ? (assets?.focus.y ?? 0.5) : 0.5;
  const position = `${Math.round(focusX * 100)}% ${Math.round(focusY * 100)}%`;

  parts.push(`
html, body { background: transparent !important; }
#zcode-beautify-wallpaper {
  position: fixed;
  inset: 0;
  z-index: -2147483646;
  background-size: ${resolved};
  background-position: ${resolved === "contain" ? "center" : position};
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(${config.blur}px);
  transform: scale(${config.blur > 0 ? 1.04 : 1});
}
#zcode-beautify-backdrop {
  position: fixed;
  inset: 0;
  z-index: -2147483647;
  background-size: cover;
  background-position: center;
  background-repeat: no-repeat;
  pointer-events: none;
  filter: blur(28px) saturate(1.15) brightness(0.85);
  transform: scale(1.12);
  display: none;
}
#zcode-beautify-backdrop[data-on="1"] { display: block; }`);
  if (config.dim > 0) {
    parts.push(`#zcode-beautify-wallpaper::after {
  content: '';
  position: absolute;
  inset: 0;
  background: rgb(0 0 0 / var(--zcode-beautify-dim, ${config.dim / 100}));
}`);
  }

  const mode = resolveColorMode(config);
  if (mode === "tarkov") {
    // The Tarkov palette is fixed, so it never consults the wallpaper: it
    // applies whether or not an image is loaded, and swapping the wallpaper
    // cannot shift the UI colors.
    parts.push(
      buildTarkovVariableOverrides({
        dim: config.dim,
        wallpaperVisible: config.wallpaperVisible,
      })
    );
    parts.push(buildTarkovComponentCss());
  } else if (mode === "monet") {
    // Monet recolors the UI from the wallpaper, so it needs the extracted theme.
    if (assets) {
      parts.push(
        buildVariableOverrides(assets.theme, {
          dim: config.dim,
          wallpaperVisible: config.wallpaperVisible,
        })
      );
    }
  } else if (assets && config.wallpaperVisible) {
    // Native keeps ZCode's own colors; surfaces only go translucent so the
    // wallpaper is not hidden behind an opaque UI. As upstream, this needs a
    // loaded wallpaper to have anything to be transparent about.
    parts.push(buildTransparencyOverrides({ dim: config.dim }));
  }
  const wallpaperDataUri = config.wallpaperVisible ? assets?.dataUri : undefined;

  return {
    css: parts.join("\n"),
    wallpaperDataUri,
    fit: config.wallpaperVisible ? resolved : "cover",
    focusX,
    focusY,
    banner: resolveBanner(config),
  };
}

/** Apply config to a running ZCode instance. Returns how many windows got it. */
export async function applyToZCode(config: BeautifyConfig, payload: BuiltPayload): Promise<number> {
  const targets = pickRendererTargets(await listTargets(config.port));
  if (targets.length === 0) {
    throw new Error("No ZCode renderer target found on the CDP endpoint.");
  }
  let count = 0;
  for (const target of targets) {
    try {
      await injectIntoTarget(target, payload);
      count++;
    } catch (err) {
      console.warn(`Injection into "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

export async function resetZCode(port: number): Promise<number> {
  const targets = pickRendererTargets(await listTargets(port));
  let count = 0;
  for (const target of targets) {
    try {
      const conn = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await conn.send("Runtime.evaluate", { expression: buildResetScript() });
      conn.close();
      count++;
    } catch (err) {
      console.warn(`Reset of "${target.title}" failed: ${(err as Error).message}`);
    }
  }
  return count;
}

/** Re-export so CLI/MCP can load wallpapers without touching monet internals. */
export { loadWallpaper };
