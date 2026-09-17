/**
 * Tarkov-inspired fixed palette and component skin for ZCode.
 *
 * This module is deliberately self-contained: the Tarkov palette does NOT
 * derive from the wallpaper, so switching wallpapers never changes the UI
 * colors (that is the whole point of the mode). Token names and their ZCode
 * meanings were taken from the shipped stylesheet of ZCode 3.11.2 — see
 * `docs/dev/zcode-dom-notes.md`.
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
import {
  DEFAULT_PALETTE,
  TARKOV_ACCENT,
  TARKOV_ACCENT_RGB,
  TARKOV_INK,
  resolvePalette,
  toTriple,
  parseHex,
  type PaletteColors,
  type PaletteOverrides,
} from "./palette.js";

/**
 * The palette shape, kept as its own name because it is what the theme builders
 * and the tests refer to. It is now identical to `PaletteColors` — the values
 * may be the shipped defaults or derived from a colour the user picked.
 */
export type TarkovPalette = PaletteColors;

/**
 * The shipped palette. Re-exported under its original name so callers and tests
 * that treat it as "the Tarkov colours" keep working; the authoritative
 * definition now lives in `palette.ts` alongside the derivation.
 */
export const TARKOV_PALETTE: TarkovPalette = DEFAULT_PALETTE;

/**
 * The default beta notice shown in place of the empty-chat greeting.
 *
 * Wording is dsh-theme-tarkov's original beta copy: line 1 verbatim with the
 * product name changed to ZCode, line 2 unchanged, including its punctuation
 * and the missing space after "Beta". Kept as data rather than buried in the
 * stylesheet so the text is testable — and, since v0.2, editable: these are the
 * values the settings panel starts the two text fields on, and what a user who
 * has not touched them keeps getting.
 */
export const TARKOV_GREETING = {
  line1: "注意！这是“ZCode”的Beta测试版本。",
  line2: "Beta测试版本不代表本产品的最终质量。感谢您的理解和支持，祝你好运！",
} as const;

/** The greeting copy to render. Both lines may be replaced by the user. */
export interface GreetingText {
  line1: string;
  line2: string;
}

export const DEFAULT_GREETING: GreetingText = {
  line1: TARKOV_GREETING.line1,
  line2: TARKOV_GREETING.line2,
};

/**
 * Quote a string for a CSS `content:` value.
 *
 * Backslash and double quote are the characters that can terminate or corrupt
 * the literal, so those are escaped; anything else (including the curly quotes
 * in the greeting) passes through unchanged.
 *
 * Line endings are escaped too, and the set is CR, LF **and form feed**: CSS
 * treats a form feed as a newline inside a string, so leaving it unescaped would
 * let a line break out of the literal and inject a declaration. The preferences
 * validator also strips C0 control characters, which means this is currently
 * unreachable — but it is the guard's own job to be complete, because the
 * validator is not the only future caller and the two protections should not
 * have to be reasoned about together.
 */
function cssString(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/[\r\n\f]/g, "\\a ");
  return `"${escaped}"`;
}

export interface TarkovThemeOptions {
  /** When true, surfaces stay translucent so the wallpaper shows through. */
  wallpaperVisible: boolean;
  /** Wallpaper dimming, 0-100. Only forwarded as the shared dim variable. */
  dim: number;
  /** The palette to render. Defaults to the shipped one. */
  palette?: PaletteColors;
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
  const p = opts.palette ?? TARKOV_PALETTE;
  const ACCENT_RGB = p.accentRgb;
  const MUTED_RGB = p.mutedRgb;
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
    `--color-popover-foreground:${p.popoverText};`,
    `--color-popover-header:${rgba(p.panelAltRgb, popoverAlpha)};`,
    `--color-popover-border:${rgba(ACCENT_RGB, 0.32)};`,
    `--color-menu:${rgba(p.popoverRgb, popoverAlpha)};`,
    `--color-menu-hover:${rgba(ACCENT_RGB, 0.2)};`,

    `--color-tab:${rgba(p.panelRgb, panelAlpha)};`,
    `--color-tab-active:${rgba(p.raisedRgb, surfaceAlpha)};`,
    `--color-tab-border:${rgba(ACCENT_RGB, 0.3)};`,

    `--color-input:${rgba(p.deepRgb, inputAlpha)};`,
    `--color-input-focused:${rgba(p.deepRgb, clamp01(inputAlpha + 0.2))};`,
    `--color-input-border:${rgba(ACCENT_RGB, 0.32)};`,
    `--color-input-border-hover:${rgba(ACCENT_RGB, 0.5)};`,
    `--color-input-border-focused:${p.accent};`,

    `--color-foreground:${p.text};`,
    `--color-foreground-subtle:${p.muted};`,
    `--color-foreground-subtlest:${rgba(MUTED_RGB, 0.72)};`,
    `--color-foreground-inverse:${p.background};`,

    `--color-primary:${p.accent};`,
    `--color-primary-foreground:${p.onAccent};`,
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
    `--color-tooltip-foreground:${p.popoverText};`,
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
export interface TarkovComponentOptions {
  /** The palette to paint with. Defaults to the shipped one. */
  palette?: PaletteColors;
  /**
   * The notice to draw in place of the stock empty-chat greeting, or null to
   * leave that screen alone entirely. Null is what "greeting disabled" means:
   * the rules are omitted rather than hidden, so ZCode's own greeting comes
   * back exactly as it was.
   */
  greeting?: GreetingText | null;
}

/**
 * The empty-chat beta notice, as its own stylesheet fragment.
 *
 * Separated from the component skin because it is the one part of the theme a
 * user can switch off. Omitting the rules is what restores ZCode's own
 * greeting: nothing is hidden, nothing is overridden, and there is no state to
 * unwind.
 */
function greetingCss(p: PaletteColors, greeting: GreetingText): string {
  const ACCENT_RGB = p.accentRgb;
  return `
/* Tarkov: the empty-chat beta notice.
 *
 * Visual language is dsh-theme-tarkov's own #tarkov-beta-banner (MIT; see
 * THIRD_PARTY_NOTICES.md): a translucent orange warning band, a dark hexagonal
 * "!" badge and two black lines — nothing else, no plate, no frame, no blur.
 * Its fixed pixel sizes are re-expressed against ZCode's greeting font-size
 * variable, so at that variable's 30px default they resolve to the reference
 * values: badge 43.5x37.5 (reference 42x36), line 1 18px/700, line 2 15px/400,
 * both #111111 with the reference's 1.5px letter-spacing and 5px line gap.
 *
 * Anchor: p[data-v4-draft-greeting="true"] — a semantic data attribute emitted by
 * ZCode's own empty-chat component (verified live; see docs/dev/zcode-dom-notes.md).
 * No hashed class names are involved.
 *
 * The element becomes the band itself, so no extra DOM is created and there is
 * nothing to tear down. ZCode's own visible greeting span becomes the text
 * column: its text is never rewritten, only collapsed to zero size, and the two
 * lines are drawn by that span's pseudo-elements. Dropping the stylesheet —
 * which is exactly what leaving Tarkov mode does — restores the real greeting
 * byte for byte.
 *
 * Every rule also requires that two-span structure (the aria-hidden measuring
 * span plus the visible one) through :has(), and targets only the last span, so
 * if that markup ever changes the whole notice stops matching and the stock
 * greeting is drawn instead of a half-painted band. Nothing here can duplicate
 * itself either. The element only mounts on the empty-chat screen, so opening a
 * real session stops matching too.
 */
p[data-v4-draft-greeting="true"]:has(> span:not([aria-hidden]):last-child) {
  display: flex;
  align-items: center;
  gap: 16px;
  box-sizing: border-box;
  width: min(94%, 720px);
  margin: 18px auto 10px;
  padding: 15px 22px 15px 16px;
  border-radius: 6px;
  text-align: left;
  /* The band itself. One knob for its strength, as in the reference project,
     which ships the same variable — at 0.55, its own default.
   Measured on a real renderer over ZCode's empty-chat backdrop, the painted
   band is rgb(160,86,35) at 0.55 and rgb(171,94,37) at 0.62, against #111111
   text: 3.5:1 and 3.9:1, so both clear the 3:1 large-text bar.
   v0.2 raises the accent itself (see themes/palette.ts), which raises the band
   with it: the hue is unchanged, the band is still translucent, and the ink on
   it gains contrast rather than losing it.
   The --zct-banner-opacity variable remains the single knob for tuning it. */
  background: rgba(${ACCENT_RGB}, var(--zct-banner-opacity, 0.62));
}
p[data-v4-draft-greeting="true"]:has(> span:not([aria-hidden]):last-child)::before {
  /* The warning badge: the reference's hexagon, cut from the deepest surface
     tone with the accent as the glyph colour. */
  content: "!";
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  width: calc(var(--v4-draft-greeting-font-size, 30px) * 1.45);
  height: calc(var(--v4-draft-greeting-font-size, 30px) * 1.25);
  background: ${p.background};
  color: ${p.accent};
  font-weight: 800;
  font-size: calc(var(--v4-draft-greeting-font-size, 30px) * 0.8);
  line-height: 1;
  font-family: system-ui, "Microsoft YaHei", sans-serif;
  clip-path: polygon(25% 0%, 75% 0%, 100% 50%, 75% 100%, 25% 100%, 0% 50%);
}
p[data-v4-draft-greeting="true"]:has(> span:not([aria-hidden]):last-child) > span:not([aria-hidden]):last-child {
  /* ZCode's own greeting span doubles as the notice's text column: collapsed to
     zero size so its text cannot paint, but never emptied, so the real greeting
     is still in the DOM to come back to. */
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-width: 0;
  font-size: 0;
  line-height: 0;
}
p[data-v4-draft-greeting="true"]:has(> span:not([aria-hidden]):last-child) > span:not([aria-hidden]):last-child::before {
  content: ${cssString(greeting.line1)};
  display: block;
  font-size: calc(var(--v4-draft-greeting-font-size, 30px) * 0.6);
  font-weight: 700;
  line-height: 1.5;
  letter-spacing: 1.5px;
  color: ${p.bandInk};
}
p[data-v4-draft-greeting="true"]:has(> span:not([aria-hidden]):last-child) > span:not([aria-hidden]):last-child::after {
  content: ${cssString(greeting.line2)};
  display: block;
  /* The reference project's 5px gap between the two lines, at ZCode's scale. */
  margin-top: calc(var(--v4-draft-greeting-font-size, 30px) * 0.1667);
  font-size: calc(var(--v4-draft-greeting-font-size, 30px) * 0.5);
  font-weight: 400;
  line-height: 1.5;
  letter-spacing: 1.5px;
  color: ${p.bandInk};
}
p[data-v4-draft-greeting="true"] > span[aria-hidden="true"] {
  /* ZCode keeps this one purely to measure the greeting's width, so its box has
     to survive (no display: none); it is only made non-painting. */
  visibility: hidden;
}
`.trim();
}

export function buildTarkovComponentCss(opts: TarkovComponentOptions = {}): string {
  const p = opts.palette ?? TARKOV_PALETTE;
  const ACCENT_RGB = p.accentRgb;
  // Null means "off": the fragment is omitted entirely, so ZCode's own greeting
  // returns with nothing hidden and no state to unwind.
  const greetingBlock = opts.greeting === null ? "" : greetingCss(p, opts.greeting ?? DEFAULT_GREETING);
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

${greetingBlock}

/* Deliberately NOT styled: code blocks, success/warning/destructive states,
   git/diff colors. Readability and semantics outrank the theme. */
`.trim();
}
