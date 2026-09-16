/**
 * Tarkov-inspired fixed palette and component skin for ZCode.
 *
 * This module is deliberately self-contained: the Tarkov palette does NOT
 * derive from the wallpaper, so switching wallpapers never changes the UI
 * colors (that is the whole point of the mode). Token names and their ZCode
 * meanings were taken from the shipped stylesheet of ZCode 3.11.2 — see
 * `docs/zcode-dom-notes.md`.
 *
 * Visual language adapted from dsh-theme-tarkov (MIT) — accent orange, deep
 * brown surfaces, warm text, hexagon warning badge. No game assets are used.
 *
 * Two deliberate non-goals:
 *  - Functional colors (success / warning / danger / destructive / git-* /
 *    diff-*) are never overridden. They carry meaning; re-tinting them for
 *    looks would make states unreadable.
 *  - Code blocks keep their syntax palette. Only the surrounding surface is
 *    warmed, because code readability outranks theme consistency.
 */

import { LIGHT_SCOPES, DARK_SCOPES } from "../core/tokenScopes.js";

export interface TarkovPalette {
  /** Primary accent, used for borders, focus rings and active states. */
  accent: string;
  /** Deepest surface tone; also the opaque background when no wallpaper shows. */
  deep: string;
  /** Base background. */
  background: string;
  /** Main panel tone (objective: rgba(26,18,10,…)). */
  panelRgb: string;
  /** Secondary panel tone (objective: rgba(30,20,10,…)). */
  panelAltRgb: string;
  /** Raised surface (cards). */
  raisedRgb: string;
  /** Popover / menu surface — kept more opaque for legibility. */
  popoverRgb: string;
  /** Primary warm text. */
  text: string;
  /** Warm highlight for emphasis. */
  highlight: string;
  /** Warning highlight. */
  warning: string;
  /** Muted text. */
  muted: string;
}

export const TARKOV_PALETTE: TarkovPalette = {
  accent: "#e07930",
  deep: "#140d04",
  background: "#1c1207",
  panelRgb: "26, 18, 10",
  panelAltRgb: "30, 20, 10",
  raisedRgb: "42, 29, 16",
  popoverRgb: "46, 32, 18",
  text: "#e8d9c8",
  highlight: "#ffd7ae",
  warning: "#ffb27a",
  muted: "#8b877c",
};

/** Accent as an rgb triple so it can be composed at arbitrary alpha. */
const ACCENT_RGB = "224, 121, 48";
const MUTED_RGB = "139, 135, 124";

export interface TarkovThemeOptions {
  /** When true, surfaces stay translucent so the wallpaper shows through. */
  wallpaperVisible: boolean;
  /** Wallpaper dimming, 0-100. Only forwarded as the shared dim variable. */
  dim: number;
}

function rgba(rgb: string, alpha: number): string {
  if (alpha >= 1) return `rgb(${rgb})`;
  const rounded = Math.round(alpha * 100) / 100;
  return `rgba(${rgb}, ${rounded})`;
}

function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * ZCode's semantic tokens for the fixed Tarkov palette.
 *
 * Returned as a flat list of `--token:value;` declarations so the mapping is
 * directly testable without string-matching rendered CSS.
 *
 * Note: the same values are emitted for the light and dark scopes on purpose.
 * Tarkov is an inherently dark theme, so the result must not depend on ZCode's
 * own light/dark setting.
 */
export function tarkovTokenRows(opts: TarkovThemeOptions): string[] {
  const p = TARKOV_PALETTE;
  const visible = opts.wallpaperVisible;

  // With a wallpaper the surfaces must let the image through; without one they
  // become a fully opaque theme (the wallpaper layer is not rendered at all).
  const surfaceAlpha = visible ? 0.72 : 1;
  const panelAlpha = visible ? 0.62 : 1;
  const inputAlpha = visible ? 0.5 : 1;
  const popoverAlpha = visible ? 0.94 : 1;

  return [
    // Window background is transparent only while a wallpaper is showing;
    // otherwise it is the opaque base so nothing leaks through.
    `--color-background:${visible ? "transparent" : p.background};`,
    `--color-bg:${visible ? "transparent" : p.background};`,
    `--color-background-alt:${rgba(p.panelRgb, panelAlpha)};`,
    `--color-background-win-alt:${rgba(p.panelAltRgb, panelAlpha)};`,
    `--color-panel:${rgba(p.panelRgb, panelAlpha)};`,
    `--color-sidebar:${rgba(p.panelAltRgb, panelAlpha)};`,
    `--color-header:${rgba(p.panelRgb, panelAlpha)};`,

    `--color-surface:${rgba(p.raisedRgb, surfaceAlpha)};`,
    `--color-surface-hover:${rgba(ACCENT_RGB, visible ? 0.18 : 0.14)};`,
    `--color-hover:${rgba(ACCENT_RGB, visible ? 0.18 : 0.14)};`,
    `--color-selected:${rgba(ACCENT_RGB, visible ? 0.24 : 0.2)};`,

    `--color-card:${rgba(p.raisedRgb, surfaceAlpha)};`,
    `--color-card-selected:${rgba(ACCENT_RGB, visible ? 0.26 : 0.22)};`,
    `--color-card-border:${rgba(ACCENT_RGB, 0.3)};`,

    `--color-popover:${rgba(p.popoverRgb, popoverAlpha)};`,
    `--color-popover-foreground:${p.text};`,
    `--color-popover-header:${rgba(p.panelAltRgb, popoverAlpha)};`,
    `--color-popover-border:${rgba(ACCENT_RGB, 0.32)};`,
    `--color-menu:${rgba(p.popoverRgb, popoverAlpha)};`,
    `--color-menu-hover:${rgba(ACCENT_RGB, 0.2)};`,

    `--color-tab:${rgba(p.panelRgb, panelAlpha)};`,
    `--color-tab-active:${rgba(p.raisedRgb, surfaceAlpha)};`,
    `--color-tab-border:${rgba(ACCENT_RGB, 0.3)};`,

    `--color-input:${rgba(p.deep, inputAlpha)};`,
    `--color-input-focused:${rgba(p.deep, clamp01(inputAlpha + 0.2))};`,
    `--color-input-border:${rgba(ACCENT_RGB, 0.32)};`,
    `--color-input-border-hover:${rgba(ACCENT_RGB, 0.5)};`,
    `--color-input-border-focused:${p.accent};`,

    `--color-foreground:${p.text};`,
    `--color-foreground-subtle:${p.muted};`,
    `--color-foreground-subtlest:${rgba(MUTED_RGB, 0.72)};`,
    `--color-foreground-inverse:${p.background};`,

    `--color-primary:${p.accent};`,
    `--color-primary-foreground:${p.background};`,
    `--color-secondary:${rgba(ACCENT_RGB, 0.16)};`,
    `--color-accent:${p.warning};`,
    `--color-brand:${p.accent};`,

    `--color-border:${rgba(ACCENT_RGB, 0.28)};`,
    `--color-border-hover:${rgba(ACCENT_RGB, 0.5)};`,
    `--color-border-color-interactive:${rgba(ACCENT_RGB, 0.36)};`,
    `--color-border-color-interactive-hover:${rgba(ACCENT_RGB, 0.6)};`,
    `--color-border-color-interactive-active:${p.accent};`,
    `--divider-color:${rgba(ACCENT_RGB, 0.2)};`,

    `--color-find-highlight:${rgba(ACCENT_RGB, 0.3)};`,
    `--color-find-highlight-active:${rgba(ACCENT_RGB, 0.5)};`,
    `--color-tag:${rgba(ACCENT_RGB, 0.14)};`,
    // Inline code only gets a warm chip; the syntax palette is untouched.
    `--color-markdown-inline-code:${rgba(ACCENT_RGB, 0.12)};`,

    `--color-tooltip:${rgba(p.popoverRgb, visible ? 0.97 : 1)};`,
    `--color-tooltip-foreground:${p.text};`,
    `--color-toast:${rgba(p.popoverRgb, visible ? 0.97 : 1)};`,
    `--color-terminal-bg:${p.deep};`,
    `--color-terminal-fg:${p.text};`,

    // Local hooks for the component skin below; not ZCode tokens.
    `--tarkov-accent:${p.accent};`,
    `--tarkov-accent-soft:${rgba(ACCENT_RGB, visible ? 0.2 : 0.16)};`,
    `--tarkov-hover:${rgba(ACCENT_RGB, visible ? 0.18 : 0.14)};`,
    `--tarkov-highlight:${p.highlight};`,
    `--tarkov-panel-border:${rgba(ACCENT_RGB, 0.3)};`,

    opts.dim > 0 ? `--zcode-beautify-dim:${opts.dim / 100};` : "",
  ].filter(Boolean);
}

/** Wraps the Tarkov token rows into the light and dark scope blocks. */
export function buildTarkovVariableOverrides(opts: TarkovThemeOptions): string {
  const rows = tarkovTokenRows(opts).join("");
  // Dark scope last: both blocks match <html>, so order decides.
  return `${LIGHT_SCOPES}{${rows}}\n${DARK_SCOPES}{${rows}}`;
}

/**
 * The limited component skin layered on top of the semantic tokens.
 *
 * Every selector here is either a shadcn/ui `data-slot` attribute or a Radix
 * `data-*` state — both are stable contracts of the component library, unlike
 * hashed class names. The one class selector (`.rounded-full`) exists only to
 * *exclude* deliberately circular buttons from the squaring-off rule; it is a
 * stable Tailwind utility, not an app-specific class.
 */
export function buildTarkovComponentCss(): string {
  const containerSlots = [
    '[data-slot="card"]',
    '[data-slot="dialog-content"]',
    '[data-slot="alert-dialog-content"]',
    '[data-slot="popover-content"]',
    '[data-slot="dropdown-menu-content"]',
    '[data-slot="dropdown-menu-sub-content"]',
    '[data-slot="context-menu-content"]',
    '[data-slot="context-menu-sub-content"]',
    '[data-slot="select-content"]',
    '[data-slot="hover-card-content"]',
    '[data-slot="command"]',
    '[data-slot="tooltip-content"]',
  ].join(",");

  const itemSlots = [
    '[data-slot="dropdown-menu-item"]',
    '[data-slot="dropdown-menu-checkbox-item"]',
    '[data-slot="dropdown-menu-radio-item"]',
    '[data-slot="select-item"]',
    '[data-slot="context-menu-item"]',
    '[data-slot="command-item"]',
  ];

  // Radix marks the active row differently per primitive.
  const itemActive = itemSlots
    .flatMap((s) => [
      `${s}:hover`,
      `${s}[data-highlighted]`,
      `${s}[data-state="checked"]`,
      `${s}[aria-selected="true"]`,
    ])
    .join(",");

  const fieldSlots = [
    '[data-slot="input"]',
    '[data-slot="textarea"]',
    '[data-slot="select-trigger"]',
    '[data-slot="input-group"]',
  ].join(",");

  return `
/* Tarkov: square off soft rounded containers (Material/rounded defaults). */
${containerSlots} { border-radius: 4px; }
${containerSlots} { border-color: var(--tarkov-panel-border); }
[data-slot="button"]:not(.rounded-full) { border-radius: 3px; }

/* Tarkov: fields get a thin warm border and a clear (not blown-out) focus. */
${fieldSlots} { border-radius: 3px; border-color: var(--color-input-border); }
${fieldSlots}:hover { border-color: var(--color-input-border-hover); }
${fieldSlots}:focus,
${fieldSlots}:focus-within { border-color: var(--color-input-border-focused); }

/* Tarkov: active row = warm wash + thin orange left indicator (inset so the
   indicator never shifts layout). */
${itemActive} {
  background-color: var(--tarkov-hover);
  box-shadow: inset 2px 0 0 var(--tarkov-accent);
}
[data-slot="command-item"][data-selected="true"],
[data-slot="tabs-trigger"][data-state="active"] { color: var(--tarkov-highlight); }
[data-slot="tabs-trigger"][data-state="active"] {
  box-shadow: inset 0 -2px 0 var(--tarkov-accent);
}
[data-slot="tabs-list"] { border-radius: 3px; }

/* Tarkov: progress and switch read as hardware-ish, not pill-shaped. */
[data-slot="progress-indicator"] { background-color: var(--tarkov-accent); }
[data-slot="switch"][data-state="checked"] { background-color: var(--color-primary); }

/* Deliberately NOT styled: code blocks, success/warning/destructive states,
   git/diff colors. Readability and semantics outrank the theme. */
`.trim();
}
