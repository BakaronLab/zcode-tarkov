/**
 * Assembles the full injected payload: wallpaper layer CSS + variable
 * overrides, plus helpers to apply a theme to a running ZCode instance.
 */

import { CdpConnection, injectIntoTarget, listRendererTargets, buildResetScript } from "./cdp.js";
import { loadWallpaper, type WallpaperAssets } from "./monet.js";
import { buildVariableOverrides, buildTransparencyOverrides } from "./tokens.js";
import { buildTarkovVariableOverrides, buildTarkovComponentCss } from "../themes/tarkov.js";
import { DEFAULT_COLOR_MODE, type ColorMode } from "./colorMode.js";
import { DEFAULT_BANNER, resolveBannerMode, type BannerOptions } from "./banner.js";
import {
  DEFAULT_PALETTE,
  TARKOV_BACKGROUND,
  TARKOV_INK,
  compositeOver,
  ensureContrast,
  parseHex,
  readableInk,
  resolvePalette,
  roundRgb,
  toHex,
} from "../themes/palette.js";
import { DEFAULT_GREETING, type GreetingText } from "../themes/tarkov.js";

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
  /** Base surface colour for the Tarkov palette, as `#rrggbb`. */
  background: string;
  /** Accent for the Tarkov palette, as `#rrggbb`. */
  accent: string;
  /** The beta notice drawn in place of the empty-chat greeting. */
  greeting: GreetingText & { enabled: boolean };
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
  background: DEFAULT_PALETTE.background,
  accent: DEFAULT_PALETTE.accent,
  greeting: { enabled: true, ...DEFAULT_GREETING },
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

/**
 * The banner to install, or null to tear any existing one down.
 *
 * The mode is authoritative, not the legacy `enabled` boolean. Deciding on
 * `enabled` alone let a payload of `enabled: true, mode: "off"` install a band
 * with a zero height and a one-pixel border — an accent line across the top of
 * the app and the reservation attribute set for a band that was supposed to be
 * absent. Nothing in the shipped UI produces that combination, which is exactly
 * why it is worth refusing here rather than relying on every caller to keep the
 * two fields in step.
 */
export function resolveBanner(config: BeautifyConfig): BannerOptions | null {
  if (resolveColorMode(config) !== "tarkov") return null;
  const banner = config.banner ?? DEFAULT_BANNER;
  if (resolveBannerMode(banner) === "off") return null;
  // The band carries the resolved accent, so a colour the user picked reaches it
  // without the banner module having to know the palette exists.
  const palette = resolvePalette({ background: config.background, accent: config.accent });

  // The band's ink is derived here rather than taken from the palette, because
  // the two bands are painted at different alphas and so are not the same
  // colour. The top band uses `banner.opacity` — 0.92 by default, adjustable to
  // 1 — while the empty-chat notice uses its own 0.62. Reusing the notice's ink
  // measured 1.90:1 up here for a dark accent over a light background, because a
  // higher alpha puts the band much closer to the raw accent.
  const bandRgb = parseHex(palette.background) ?? parseHex(TARKOV_BACKGROUND)!;
  const surface = roundRgb(compositeOver(parseHex(palette.accent)!, bandRgb, banner.opacity));
  // The near-black candidate is the shipped ink, so an untouched theme renders
  // exactly the colour it always did; the derivation only changes the answer once
  // a colour has actually been chosen.
  const accentInk = toHex(
    ensureContrast(readableInk(surface, [parseHex(TARKOV_INK)!, { r: 255, g: 255, b: 255 }]), surface, 4.5)
  );

  return { ...banner, accent: palette.accent, accentRgb: palette.accentRgb, accentInk };
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
    // The Tarkov palette never consults the wallpaper: it applies whether or not
    // an image is loaded, and swapping the wallpaper cannot shift the UI colors.
    // A user-chosen background and accent resolve here, once, so every module
    // downstream paints from one palette object rather than re-deriving.
    const palette = resolvePalette({ background: config.background, accent: config.accent });
    parts.push(
      buildTarkovVariableOverrides({
        dim: config.dim,
        wallpaperVisible: config.wallpaperVisible,
        palette,
      })
    );
    parts.push(
      buildTarkovComponentCss({
        palette,
        // Null omits the notice's rules entirely, which is what brings ZCode's
        // own greeting back.
        greeting: config.greeting.enabled
          ? { line1: config.greeting.line1, line2: config.greeting.line2 }
          : null,
      })
    );
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
  // listRendererTargets, not listTargets + pickRendererTargets: it adds the
  // bounded cold-start wait (endpoint reachable, renderer not up yet), which is
  // exactly the window in which the appearance commands used to fail. Every
  // appearance command funnels through here (apply, colors, theme) or through
  // resetZCode below, so all of them benefit.
  const targets = await listRendererTargets(config.port);
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
  const targets = await listRendererTargets(port);
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
